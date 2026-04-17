#!/usr/bin/env node
/**
 * Stage / publish / delete a Briefing episode on YouTube Studio.
 *
 * Three subcommands, dispatched by flag:
 *
 *   (default)            → STAGE: upload mp4 + thumbnail, walk wizard
 *                          through visibility, close dialog. Leaves a
 *                          draft in Studio Content → Drafts. Prints
 *                          the real videoId + edit URL for human review.
 *
 *   --publish-draft=<id> → PUBLISH-DRAFT: reopen the wizard on the
 *                          existing draft, advance to Visibility,
 *                          click Save. Commits to the channel at the
 *                          draft's saved visibility (default unlisted).
 *
 *   --delete-draft=<id>  → DELETE-DRAFT: edit page → overflow menu →
 *                          Delete → confirm. Removes the draft.
 *
 * Why this shape (stage → human inspect → publish-draft or delete):
 * after commit 4829995 we learned that uploadShort's dryRun leaves a
 * draft behind — the wizard's fake "wouldBeUrl" and the message
 * "nothing committed to the channel" were both wrong. Drafts are
 * auto-saved by Studio at each wizard step. So rather than trying to
 * render a perfect preview without side effects, we lean in: the draft
 * IS the preview, and the approval loop is approve-in-Studio →
 * publish-draft.
 *
 * Options:
 *   --mp4=<path>         video to upload. Default packages/video/out/briefing-dryrun-v4.mp4
 *   --spec=<path>        compiled spec for title/description. Default briefing-dryrun.compiled.json
 *   --thumbnail=<path>   custom thumbnail file (.jpg/.png). Requires the channel
 *                        to be phone-verified (Studio's gate for custom thumbs).
 *   --no-thumbnail       skip the thumbnail attach and keep Studio's auto-pick.
 *                        Default: generate a frame-grab at 5s and attach it
 *                        (cached under ~/.ohwow/media/thumbnails/briefing-<sha256>.jpg).
 *   --playlist=<name>    override the series' default playlist binding.
 *   --no-playlist        skip playlist binding entirely.
 *                        Default: bind to series.playlist ("Daily AI News"),
 *                        create if missing.
 *   --visibility=<v>     private|unlisted|public. Default: series registry (unlisted).
 *                        --public still requires ≥5 prior applied unlisted rows.
 *   --yes                skip interactive confirm (needed in non-TTY)
 *   --identity=<id>      pin channel (handle or UC-id)
 *   --title=<str>        override derived title
 *   --description=<str>  override derived description
 *
 * Exit codes:
 *   0 success
 *   1 preflight (file missing, account flag set, visibility gate)
 *   2 user declined confirm
 *   3 wizard / delete / publish failed
 *
 * Run: node --import tsx scripts/yt-experiments/_publish-briefing.mjs
 */
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { loadQueue, propose, rate } from '../x-experiments/_approvals.mjs';
import { resolveOhwow } from '../x-experiments/_ohwow.mjs';

import {
  deleteDraft,
  ensureYTStudio,
  findDraftIdByTitle,
  publishDraft,
  uploadShort,
} from '../../src/integrations/youtube/index.ts';
import { getSeries } from '../../src/integrations/youtube/series/registry.js';

const VIDEO_PKG = path.resolve('packages/video');
const DEFAULT_MP4 = path.join(VIDEO_PKG, 'out/briefing-dryrun-v4.mp4');
const DEFAULT_SPEC = path.join(VIDEO_PKG, 'specs/briefing-dryrun.compiled.json');
const THUMB_DIR = path.join(os.homedir(), '.ohwow', 'media', 'thumbnails');
const UNLISTED_BEFORE_PUBLIC = 5;
// 5s mark = post-cold-open (60 frames @ 30fps = 2s) + mid-intro — title has
// sprung in, subtitle is visible, anchor has started. Most representative
// frame of the episode without being a blank cold-open.
const THUMB_SEEK_SECONDS = 5.0;
const THUMB_WIDTH = 1280;
const THUMB_HEIGHT = 720;

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { flags: new Set(), kv: {} };
  for (const a of argv) {
    if (a.startsWith('--') && a.includes('=')) {
      const [k, ...rest] = a.slice(2).split('=');
      out.kv[k] = rest.join('=');
    } else if (a.startsWith('--')) {
      out.flags.add(a.slice(2));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Title / description derivation
// ---------------------------------------------------------------------------
function deriveDateLabel(specId, fallback = new Date()) {
  const m = /(\d{4})(\d{2})(\d{2})/.exec(specId || '');
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : fallback;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
}

function deriveHook(spec) {
  const intro = spec.scenes?.find((s) => s.id === 'intro');
  if (!intro) return null;
  const ft = intro.params?.primitives?.find((p) => p.primitive === 'r3f.floating-title');
  const sub = ft?.params?.subtitle;
  if (!sub || typeof sub !== 'string') return null;
  const stripped = sub.replace(/^[A-Z]{3}\s+\d{1,2}\s*[·•|-]\s*/i, '').trim();
  return stripped ? titleCase(stripped) : null;
}

function deriveTitle(spec, dateLabel) {
  const hook = deriveHook(spec);
  return hook ? `The Briefing · ${dateLabel} · ${hook}` : `The Briefing · ${dateLabel}`;
}

// Sentence splitter that won't break on decimals ("Opus 4.7" stays whole)
// by requiring whitespace/end after the terminator.
const SENTENCE_RE = /(.*?[.!?])(?=\s|$)/s;

function firstNSentences(text, n) {
  const src = (text || '').trim();
  const out = [];
  let rest = src;
  for (let i = 0; i < n; i += 1) {
    const m = SENTENCE_RE.exec(rest);
    if (!m) break;
    out.push(m[1].trim());
    rest = rest.slice(m[0].length).trimStart();
  }
  return out.length ? out.join(' ') : src;
}

function deriveDescription(spec, series) {
  const storyScenes = spec.scenes.filter((s) => /^story-\d+a$/.test(s.id || ''));
  const bullets = storyScenes
    .map((s) => firstNSentences(s.narration, 1))
    .filter(Boolean)
    .map((line) => `• ${line}`);

  const outro = spec.scenes.find((s) => s.id === 'outro');
  const watchLine = outro?.narration
    ? firstNSentences(outro.narration.split(/Watch list[:,]/i)[1] || '', 2)
    : '';

  const parts = ["Today's briefing:", '', ...bullets];
  if (watchLine) parts.push('', `Watch list: ${watchLine}`);
  parts.push('', 'Made with ohwow.fun', '', (series.hashtags || []).join(' '));
  return parts.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Thumbnail generation (ffmpeg frame-grab, cached by mp4 sha256)
// ---------------------------------------------------------------------------
function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

function generateThumbnail(mp4Path) {
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  const hash = sha256File(mp4Path).slice(0, 16);
  const thumbPath = path.join(THUMB_DIR, `briefing-${hash}.jpg`);
  if (fs.existsSync(thumbPath)) return thumbPath;
  execSync(
    `ffmpeg -y -ss ${THUMB_SEEK_SECONDS} -i "${mp4Path}" -vframes 1 -vf "scale=${THUMB_WIDTH}:${THUMB_HEIGHT}" -q:v 2 "${thumbPath}"`,
    { timeout: 20_000, stdio: 'pipe' },
  );
  if (!fs.existsSync(thumbPath)) {
    throw new Error(`thumbnail generation failed; ffmpeg produced no file at ${thumbPath}`);
  }
  return thumbPath;
}

// ---------------------------------------------------------------------------
// Approval queue helpers
// ---------------------------------------------------------------------------
function findApprovalByVideoId(queue, series, videoId) {
  return queue.findLast((e) =>
    e.kind === series.approvalKind && e.payload?.videoId === videoId,
  ) ?? null;
}

function countPriorAppliedUnlisted(queue, series) {
  return queue.filter((e) =>
    e.kind === series.approvalKind
    && (e.status === 'applied' || e.status === 'auto_applied')
    && e.payload?.visibility === 'unlisted',
  ).length;
}

async function confirmTty(prompt) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise((resolve) => rl.question(prompt, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: PUBLISH-DRAFT
// ---------------------------------------------------------------------------
async function cmdPublishDraft({ videoId, args }) {
  const series = getSeries('briefing');
  const { workspace } = resolveOhwow();
  const queue = loadQueue(workspace);
  const row = findApprovalByVideoId(queue, series, videoId);
  const visibility = (args.kv.visibility || row?.payload?.visibility || series.defaultVisibility).toLowerCase();

  if (visibility === 'public') {
    const prior = countPriorAppliedUnlisted(queue, series);
    if (prior < UNLISTED_BEFORE_PUBLIC) {
      console.error(
        `[publish-draft] --visibility=public refused: need ≥${UNLISTED_BEFORE_PUBLIC} applied unlisted rows, found ${prior}.`,
      );
      process.exit(1);
    }
  }

  console.error('[publish-draft] plan:');
  console.error(`  videoId       ${videoId}`);
  console.error(`  visibility    ${visibility}`);
  console.error(`  approvalRow   ${row?.id ?? '(no matching row found)'}`);

  if (!args.flags.has('yes')) {
    const ok = await confirmTty(`[publish-draft] publish draft ${videoId} as ${visibility}? Type 'y': `);
    if (!ok) {
      console.error('[publish-draft] declined.');
      process.exit(2);
    }
  }

  const session = await ensureYTStudio({ identity: args.kv.identity, throwOnChallenge: true });
  try {
    const result = await publishDraft(session.page, {
      videoId,
      channelId: session.health.channelId,
      visibility,
    });
    if (row) {
      rate({ id: row.id, status: 'applied', notes: `published draft. url=${result.videoUrl ?? '(none)'}` });
    }
    console.error(`[publish-draft] ok. url=${result.videoUrl ?? '(none surfaced)'}`);
    console.log(JSON.stringify({ ok: true, videoId, url: result.videoUrl, visibility }, null, 2));
  } catch (err) {
    if (row) rate({ id: row.id, status: 'rejected', notes: `publish-draft error: ${err?.message ?? err}` });
    console.error(`[publish-draft] error: ${err?.message ?? err}`);
    process.exit(3);
  } finally {
    if (session.ownsBrowser) session.browser.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: DELETE-DRAFT
// ---------------------------------------------------------------------------
async function cmdDeleteDraft({ videoId, args }) {
  const series = getSeries('briefing');
  const { workspace } = resolveOhwow();
  const queue = loadQueue(workspace);
  const row = findApprovalByVideoId(queue, series, videoId);

  console.error('[delete-draft] plan:');
  console.error(`  videoId       ${videoId}`);
  console.error(`  approvalRow   ${row?.id ?? '(no matching row found)'}`);

  if (!args.flags.has('yes')) {
    const ok = await confirmTty(`[delete-draft] permanently delete draft ${videoId}? Type 'y': `);
    if (!ok) {
      console.error('[delete-draft] declined.');
      process.exit(2);
    }
  }

  const session = await ensureYTStudio({ identity: args.kv.identity, throwOnChallenge: true });
  try {
    await deleteDraft(session.page, { videoId });
    if (row) rate({ id: row.id, status: 'rejected', notes: 'draft deleted' });
    console.error(`[delete-draft] ok.`);
    console.log(JSON.stringify({ ok: true, videoId, deleted: true }, null, 2));
  } catch (err) {
    console.error(`[delete-draft] error: ${err?.message ?? err}`);
    process.exit(3);
  } finally {
    if (session.ownsBrowser) session.browser.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: STAGE (default)
// ---------------------------------------------------------------------------
async function cmdStage({ args }) {
  const mp4Path = path.resolve(args.kv.mp4 || DEFAULT_MP4);
  const specPath = path.resolve(args.kv.spec || DEFAULT_SPEC);

  if (!fs.existsSync(mp4Path)) { console.error(`[stage] mp4 not found: ${mp4Path}`); process.exit(1); }
  if (!fs.existsSync(specPath)) { console.error(`[stage] spec not found: ${specPath}`); process.exit(1); }

  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const series = getSeries('briefing');
  const dateLabel = deriveDateLabel(spec.id);
  const title = (args.kv.title || deriveTitle(spec, dateLabel)).slice(0, 100);
  const description = args.kv.description || deriveDescription(spec, series);
  const visibility = (args.kv.visibility || series.defaultVisibility).toLowerCase();

  // Thumbnail: explicit path > auto frame-grab > skip
  let thumbnailPath = null;
  if (args.kv.thumbnail) {
    thumbnailPath = path.resolve(args.kv.thumbnail);
    if (!fs.existsSync(thumbnailPath)) {
      console.error(`[stage] thumbnail not found: ${thumbnailPath}`);
      process.exit(1);
    }
  } else if (!args.flags.has('no-thumbnail')) {
    console.error('[stage] generating thumbnail via ffmpeg frame-grab…');
    thumbnailPath = generateThumbnail(mp4Path);
    console.error(`[stage]   thumbnail: ${thumbnailPath} (${(fs.statSync(thumbnailPath).size / 1024).toFixed(1)} KB)`);
  }

  // Playlist: explicit --playlist > series default > --no-playlist skip
  let playlistName = null;
  if (args.kv.playlist) {
    playlistName = args.kv.playlist;
  } else if (!args.flags.has('no-playlist')) {
    playlistName = series.playlist ?? null;
  }

  console.error('[stage] plan:');
  console.error(`  mp4           ${mp4Path}  (${(fs.statSync(mp4Path).size / 1024 / 1024).toFixed(1)} MB)`);
  console.error(`  title         ${title}`);
  console.error(`  visibility    ${visibility}  (saved with draft; publish-draft uses this unless overridden)`);
  console.error(`  thumbnail     ${thumbnailPath ?? '(Studio auto-pick)'}`);
  console.error(`  playlist      ${playlistName ?? '(none)'}`);

  const session = await ensureYTStudio({ identity: args.kv.identity, throwOnChallenge: true });
  const flags = session.health.accountFlags || {};
  if (flags.hasUnacknowledgedCopyrightTakedown || flags.hasUnacknowledgedTouStrike) {
    console.error('[stage] account flags set — refusing. Resolve in Studio first.');
    if (session.ownsBrowser) session.browser.close();
    process.exit(1);
  }
  console.error(`[stage] session ok. channel=${session.health.channelId ?? '(unknown)'}`);

  // Walk the wizard as stage-as-draft (dryRun:true leaves the draft
  // behind — that's the whole point here).
  let wizardResult;
  try {
    wizardResult = await uploadShort(session.page, {
      filePath: mp4Path,
      title,
      description,
      thumbnailPath: thumbnailPath ?? undefined,
      playlist: playlistName ?? undefined,
      createPlaylistIfMissing: !!playlistName,
      createPlaylistVisibility: 'public',
      visibility,
      dryRun: true,
      onStage: (ev) => process.stderr.write(
        `  [stage] ${ev.stage} ${ev.ok ? 'ok' : 'FAIL'} ${ev.durationMs}ms${ev.error ? ' — ' + ev.error : ''}\n`,
      ),
    });
  } catch (err) {
    console.error(`[stage] wizard error: ${err?.message ?? err}`);
    if (session.ownsBrowser) session.browser.close();
    process.exit(3);
  }

  // Find the real videoId from the Content page (the wizard sidebar URL
  // is unreliable — see drafts.ts findDraftIdByTitle comment).
  console.error('[stage] resolving real draft videoId from Content page…');
  const { workspace } = resolveOhwow();
  let videoId = null;
  try {
    videoId = await findDraftIdByTitle(session.page, {
      channelId: session.health.channelId,
      titleContains: title.slice(0, 40),
    });
  } catch (err) {
    console.error(`[stage] videoId lookup error: ${err?.message ?? err}`);
  }

  const entry = propose({
    kind: series.approvalKind,
    summary: `${series.displayName} · ${title.slice(0, 60)}`,
    bucketBy: 'series',
    maxPriorRejected: 0,
    payload: {
      series: series.slug,
      title,
      description,
      visibility,
      mp4Path,
      specPath,
      specId: spec.id,
      thumbnailPath,
      playlist: playlistName,
      videoId,
      wouldBeUrlFromSidebar: wizardResult.videoUrl,
      channelId: session.health.channelId,
      source: '_publish-briefing.mjs stage',
    },
  });

  if (session.ownsBrowser) session.browser.close();

  console.error(`[stage] approval row: ${entry.id} status=${entry.status}`);
  console.error(`[stage] real videoId: ${videoId ?? '(lookup failed — inspect Studio Content → Drafts)'}`);
  const editUrl = videoId ? `https://studio.youtube.com/video/${videoId}/edit` : '(n/a)';
  console.error(`[stage] edit URL:     ${editUrl}`);
  console.error('[stage] next steps:');
  if (videoId) {
    console.error(`  inspect in Studio, then:`);
    console.error(`  publish →  node --import tsx scripts/yt-experiments/_publish-briefing.mjs --publish-draft=${videoId}`);
    console.error(`  reject  →  node --import tsx scripts/yt-experiments/_publish-briefing.mjs --delete-draft=${videoId}`);
  } else {
    console.error(`  videoId lookup failed. Open Studio Content → Drafts and act manually.`);
  }

  console.log(JSON.stringify({
    ok: true,
    staged: true,
    videoId,
    editUrl,
    approvalId: entry.id,
    title,
    visibility,
    wouldBeUrlFromSidebar: wizardResult.videoUrl,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.kv['publish-draft']) {
    await cmdPublishDraft({ videoId: args.kv['publish-draft'], args });
    return;
  }
  if (args.kv['delete-draft']) {
    await cmdDeleteDraft({ videoId: args.kv['delete-draft'], args });
    return;
  }
  await cmdStage({ args });
}

main().catch((err) => {
  console.error('[publish-briefing] fatal', err);
  process.exit(1);
});
