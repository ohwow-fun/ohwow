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
 * Generate the thumbnail. Returns { ok: boolean, path?: string, error?: string }.
 */
export function generateThumbnail({ videoPath, draft, outPath, keyframeSeconds = 6 }) {
  if (!fs.existsSync(videoPath)) {
    return { ok: false, error: `video not found: ${videoPath}` };
  }
  const font = findFont();
  if (!font) {
    return { ok: false, error: 'no usable font found on system — install DejaVu Sans or Arial' };
  }

  const date = formatDate(draft?.episode_date);
  const actors = extractActors(draft);
  const actorLine = actors.length ? actors.join('  -  ') : 'OHWOW.FUN';
  const header = `THE BRIEFING  -  ${date}`;

  // drawtext filter parts. Top: small label band. Bottom: bold actor list.
  const fontFile = escFF(font);
  const hdrText = escFF(header);
  const actorText = escFF(actorLine);

  const filters = [
    // First, scale the keyframe to 1280x720 fit-cover, blur it slightly,
    // and darken for text legibility.
    `scale=1280:720:force_original_aspect_ratio=increase`,
    `crop=1280:720`,
    `eq=brightness=-0.08:contrast=1.05`,
    // Top-left label: small, medium weight
    `drawtext=fontfile='${fontFile}':text='${hdrText}':x=64:y=48:fontsize=28:fontcolor=white:box=1:boxcolor=0x0a1629CC:boxborderw=16`,
    // Bottom-center actors: big, bold
    `drawtext=fontfile='${fontFile}':text='${actorText}':x=(w-text_w)/2:y=h-140:fontsize=62:fontcolor=white:box=1:boxcolor=0x0a1629EE:boxborderw=24:borderw=2:bordercolor=0x2563eb`,
  ].join(',');

  const cmd = `ffmpeg -y -ss ${keyframeSeconds.toFixed(1)} -i "${videoPath}" -vframes 1 -vf "${filters}" -q:v 3 "${outPath}"`;

  try {
    execSync(cmd, { stdio: 'pipe', timeout: 15_000 });
    return { ok: true, path: outPath };
  } catch (e) {
    return { ok: false, error: `ffmpeg failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}` };
  }
}
