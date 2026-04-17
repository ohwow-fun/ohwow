/**
 * Thumbnail generator for horizontal briefing videos.
 *
 * Inputs: rendered MP4 path + draft JSON (has title, story actors, episode_date).
 * Output: 1280×720 JPG at <briefDir>/thumbnail.jpg
 *
 * Strategy: extract a keyframe from ~6s into the video (past the intro
 * animation, into the first story's visual backdrop), resize to 1280×720,
 * overlay two text bands via ffmpeg drawtext:
 *   - Top-left: "THE BRIEFING · <DATE>"
 *   - Bottom: "<ACTOR1> · <ACTOR2> · <ACTOR3>" joined with separators
 *
 * No image-generation API. Pure ffmpeg + local fonts — runs offline in
 * <2s per thumbnail. Good enough for pre-publish review; a future pass
 * can swap in an image-generation API for richer composites.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Find a usable font file on the system. ffmpeg drawtext needs a path
 * to a TTF/OTF file, and fonts vary by OS. Return the first match.
 */
function findFont() {
  const candidates = [
    // macOS
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/System/Library/Fonts/SFNS.ttf',
    // Linux
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    // Windows
    'C:/Windows/Fonts/arialbd.ttf',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function formatDate(iso) {
  // "2026-04-17" → "APR 17, 2026"
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return new Date().toISOString().slice(0, 10).toUpperCase();
  const [y, m, d] = iso.slice(0, 10).split('-');
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${months[Number(m) - 1]} ${Number(d)}, ${y}`;
}

/**
 * Extract the actors from a draft for the thumbnail lower band.
 */
function extractActors(draft) {
  const stories = Array.isArray(draft?.stories) ? draft.stories : [];
  if (stories.length === 0 && draft?.actor) return [String(draft.actor).toUpperCase()];
  return stories
    .map((s) => String(s?.actor || '').trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 3);
}

/**
 * Escape text for ffmpeg drawtext — colons, backslashes, single quotes,
 * percent signs all have special meaning.
 */
function escFF(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/·/g, '-');  // middle-dot sometimes renders as ? in limited fonts
}

/**
 * Check if ffmpeg has the drawtext filter available. Homebrew's default
 * ffmpeg is often compiled without libfreetype, which means text overlays
 * fail silently. We probe once; if missing, fall back to keyframe-only
 * thumbnails.
 */
let _drawtextCache = null;
function hasDrawtext() {
  if (_drawtextCache !== null) return _drawtextCache;
  try {
    const out = execSync('ffmpeg -hide_banner -filters 2>&1', { encoding: 'utf8' });
    _drawtextCache = /\bdrawtext\b/.test(out);
  } catch { _drawtextCache = false; }
  return _drawtextCache;
}

/**
 * Generate the thumbnail. Returns { ok: boolean, path?: string, error?: string, textOverlay: boolean }.
 *
 * If ffmpeg's drawtext filter isn't available on this system (common on
 * minimal ffmpeg builds), we still produce a thumbnail — just the bare
 * keyframe, scaled + darkened. textOverlay:false signals the caller that
 * the labels weren't baked in and could be added later via a different
 * tool (Canvas, Pillow, ImageMagick).
 */
export function generateThumbnail({ videoPath, draft, outPath, keyframeSeconds = 6 }) {
  if (!fs.existsSync(videoPath)) {
    return { ok: false, error: `video not found: ${videoPath}`, textOverlay: false };
  }

  const baseFilters = [
    `scale=1280:720:force_original_aspect_ratio=increase`,
    `crop=1280:720`,
    `eq=brightness=-0.08:contrast=1.05`,
  ];

  const font = findFont();
  const canOverlayText = hasDrawtext() && font;

  let filters = baseFilters;
  if (canOverlayText) {
    const date = formatDate(draft?.episode_date);
    const actors = extractActors(draft);
    const actorLine = actors.length ? actors.join('  -  ') : 'OHWOW.FUN';
    const header = `THE BRIEFING  -  ${date}`;

    // ffmpeg drawtext needs the fontfile path with escaped colons on macOS
    // (e.g. /System/Library/... → /System\:/Library/...). Escape spaces too.
    const fontFile = font.replace(/:/g, '\\:').replace(/ /g, '\\ ');
    const hdrText = escFF(header);
    const actorText = escFF(actorLine);

    filters = [
      ...baseFilters,
      `drawtext=fontfile=${fontFile}:text='${hdrText}':x=64:y=48:fontsize=28:fontcolor=white:box=1:boxcolor=0x0a1629CC:boxborderw=16`,
      `drawtext=fontfile=${fontFile}:text='${actorText}':x=(w-text_w)/2:y=h-140:fontsize=62:fontcolor=white:box=1:boxcolor=0x0a1629EE:boxborderw=24:borderw=2:bordercolor=0x2563eb`,
    ];
  }

  const filterStr = filters.join(',');
  const cmd = `ffmpeg -y -ss ${keyframeSeconds.toFixed(1)} -i "${videoPath}" -vframes 1 -vf "${filterStr}" -q:v 3 "${outPath}"`;

  try {
    execSync(cmd, { stdio: 'pipe', timeout: 15_000 });
    return { ok: true, path: outPath, textOverlay: canOverlayText };
  } catch (e) {
    // drawtext failure mid-run (rare — usually hasDrawtext catches it).
    // Fall back to bare keyframe if we were attempting overlay.
    if (canOverlayText) {
      const fallback = `ffmpeg -y -ss ${keyframeSeconds.toFixed(1)} -i "${videoPath}" -vframes 1 -vf "${baseFilters.join(',')}" -q:v 3 "${outPath}"`;
      try {
        execSync(fallback, { stdio: 'pipe', timeout: 15_000 });
        return { ok: true, path: outPath, textOverlay: false, note: 'drawtext failed, fell back to bare keyframe' };
      } catch { /* fall through */ }
    }
    return { ok: false, error: `ffmpeg failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`, textOverlay: false };
  }
}
