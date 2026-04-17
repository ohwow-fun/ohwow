#!/usr/bin/env node
/**
 * Publish an already-rendered Briefing episode to YouTube.
 *
 * Pair for _render-briefing-dryrun.mjs: that script stops at an mp4,
 * this one takes an mp4 + the compiled spec, derives a broadcast-style
 * title + description from the scene narrations, runs the Studio
 * upload wizard via src/integrations/youtube, and records the action
 * in the existing approval queue (kind yt_short_draft_briefing, same
 * schema compose-core uses).
 *
 * Why separate from compose-core: compose-core runs the full seed →
 * LLM → render → voice → propose → upload chain for autonomous
 * episodes. This script publishes a human-authored / already-rendered
 * briefing without re-running the LLM or render stages, which is the
 * right shape for dogfooding + early days while the series is still
 * human-gated (ops-runbook.md — 10-20 episodes minimum before
 * auto-approve).
 *
 * Flags:
 *   --mp4=<path>        mp4 to upload. Default packages/video/out/briefing-dryrun-v4.mp4
 *   --spec=<path>       compiled spec to derive title/description. Default briefing-dryrun.compiled.json
 *   --publish           actually click Save. Without this, dry-run (close dialog, no publish)
 *   --public            request public visibility. Gated: requires ≥5 prior applied unlisted briefing rows
 *   --yes               skip interactive TTY confirm on --publish
 *   --identity=<id>     pin channel (handle or UC-id). Default: whatever Studio tab is logged in
 *   --title=<str>       override derived title
 *   --description=<str> override derived description
 *
 * Exit codes:
 *   0 success (upload or dry-run)
 *   1 preflight failure (mp4/spec missing, account flag set, visibility gate)
 *   2 user declined confirm
 *   3 upload wizard failed mid-flight (stage timeline printed)
 *
 * Run: node --import tsx scripts/yt-experiments/_publish-briefing.mjs [--publish]
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { loadQueue, propose, rate } from '../x-experiments/_approvals.mjs';
import { resolveOhwow } from '../x-experiments/_ohwow.mjs';

// Typed YT library — tsx loader resolves .js → .ts from src/.
import { ensureYTStudio, uploadShort } from '../../src/integrations/youtube/index.ts';
import { getSeries } from '../../src/integrations/youtube/series/registry.js';

const VIDEO_PKG = path.resolve('packages/video');
const DEFAULT_MP4 = path.join(VIDEO_PKG, 'out/briefing-dryrun-v4.mp4');
const DEFAULT_SPEC = path.join(VIDEO_PKG, 'specs/briefing-dryrun.compiled.json');
const UNLISTED_BEFORE_PUBLIC = 5;

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

// Pull YYYY-MM-DD out of spec.id, which compose-core + render-dryrun
// both stamp with `briefing-<YYYYMMDD>-<variant>`.
function deriveDateLabel(specId, fallback = new Date()) {
  const m = /(\d{4})(\d{2})(\d{2})/.exec(specId || '');
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : fallback;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
}

// Human-authored hook lives on the intro scene's floating-title subtitle.
// Strip any leading "APR 17 · " date prefix that the spec author wrote
// into the visual (we don't want it twice in the title).
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

// Non-greedy sentence terminator that won't split on decimals
// ("Opus 4.7" → keep together) by requiring whitespace-or-end
// after the terminator.
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mp4Path = path.resolve(args.kv.mp4 || DEFAULT_MP4);
  const specPath = path.resolve(args.kv.spec || DEFAULT_SPEC);
  const publish = args.flags.has('publish');
  const wantPublic = args.flags.has('public');
  const autoYes = args.flags.has('yes');
  const identity = args.kv.identity || undefined;

  if (!fs.existsSync(mp4Path)) {
    console.error(`[publish] mp4 not found: ${mp4Path}`);
    process.exit(1);
  }
  if (!fs.existsSync(specPath)) {
    console.error(`[publish] spec not found: ${specPath}`);
    process.exit(1);
  }

  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const series = getSeries('briefing');
  const dateLabel = deriveDateLabel(spec.id);
  const title = (args.kv.title || deriveTitle(spec, dateLabel)).slice(0, 100);
  const description = args.kv.description || deriveDescription(spec, series);

  const { workspace } = resolveOhwow();
  const queue = loadQueue(workspace);
  const priorUnlisted = countPriorAppliedUnlisted(queue, series);
  const visibility = wantPublic ? 'public' : series.defaultVisibility;

  if (wantPublic && priorUnlisted < UNLISTED_BEFORE_PUBLIC) {
    console.error(
      `[publish] --public refused: need ≥${UNLISTED_BEFORE_PUBLIC} applied unlisted briefings in the queue, found ${priorUnlisted}.`,
    );
    console.error('[publish] ship unlisted runs first. Ops-runbook policy.');
    process.exit(1);
  }

  console.error('[publish] plan:');
  console.error(`  workspace     ${workspace}`);
  console.error(`  mp4           ${mp4Path}  (${(fs.statSync(mp4Path).size / 1024 / 1024).toFixed(1)} MB)`);
  console.error(`  spec          ${specPath}`);
  console.error(`  title         ${title}`);
  console.error(`  visibility    ${visibility}${wantPublic ? `  (gate ok: ${priorUnlisted}/${UNLISTED_BEFORE_PUBLIC})` : ''}`);
  console.error(`  identity      ${identity ?? '(reuse active Studio tab)'}`);
  console.error(`  mode          ${publish ? 'PUBLISH' : 'dry-run (wizard walked, dialog cancelled)'}`);
  console.error('  description:');
  for (const line of description.split('\n')) console.error(`    ${line}`);

  // Session preflight runs first so we catch account flags / login
  // issues before we write an approval row.
  console.error('[publish] ensuring Studio session…');
  const session = await ensureYTStudio({ identity, throwOnChallenge: true });
  const flags = session.health.accountFlags || {};
  if (flags.hasUnacknowledgedCopyrightTakedown || flags.hasUnacknowledgedTouStrike) {
    console.error('[publish] account flags set — refusing to upload. Resolve in Studio first.');
    console.error(`  flags: ${JSON.stringify(flags)}`);
    if (session.ownsBrowser) session.browser.close();
    process.exit(1);
  }
  console.error(`[publish] session ok. channel=${session.health.channelId ?? '(unknown)'} ` +
    `handle=${session.health.channelHandle ?? '(n/a)'}`);

  // Record the proposed action. Non-blocking — we mark it applied/rejected
  // after the wizard returns. bucketBy:'series' matches compose-core.
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
      channelId: session.health.channelId,
      source: '_publish-briefing.mjs',
      publishMode: publish ? 'live' : 'dry-run',
    },
  });
  console.error(`[publish] approval row: ${entry.id} status=${entry.status}`);

  if (!publish) {
    console.error('[publish] dry-run: exercising wizard without Save, then closing dialog.');
    try {
      const result = await uploadShort(session.page, {
        filePath: mp4Path, title, description, visibility,
        dryRun: true,
        onStage: (ev) => process.stderr.write(
          `  [stage] ${ev.stage} ${ev.ok ? 'ok' : 'FAIL'} ${ev.durationMs}ms${ev.error ? ' — ' + ev.error : ''}\n`,
        ),
      });
      rate({ id: entry.id, status: 'rejected', notes: 'dry-run — wizard walked, dialog cancelled' });
      console.error(`[publish] dry-run ok. wouldBeUrl=${result.videoUrl ?? '(none surfaced)'}`);
      console.log(JSON.stringify({ ok: true, dryRun: true, wouldBeUrl: result.videoUrl, approvalId: entry.id }, null, 2));
    } catch (err) {
      rate({ id: entry.id, status: 'rejected', notes: `dry-run error: ${err?.message ?? err}` });
      console.error(`[publish] dry-run wizard error: ${err?.message ?? err}`);
      process.exit(3);
    } finally {
      if (session.ownsBrowser) session.browser.close();
    }
    return;
  }

  if (!autoYes) {
    const ok = await confirmTty(`[publish] upload to channel ${session.health.channelId ?? '(unknown)'} as ${visibility}? Type 'y' to confirm: `);
    if (!ok) {
      rate({ id: entry.id, status: 'rejected', notes: 'operator declined confirm' });
      console.error('[publish] declined. No upload.');
      if (session.ownsBrowser) session.browser.close();
      process.exit(2);
    }
  } else if (!process.stdin.isTTY) {
    console.error('[publish] --yes + non-TTY: skipping confirm.');
  }

  try {
    const result = await uploadShort(session.page, {
      filePath: mp4Path, title, description, visibility,
      dryRun: false,
      onStage: (ev) => process.stderr.write(
        `  [stage] ${ev.stage} ${ev.ok ? 'ok' : 'FAIL'} ${ev.durationMs}ms${ev.error ? ' — ' + ev.error : ''}\n`,
      ),
    });
    rate({
      id: entry.id,
      status: 'applied',
      notes: `published. url=${result.videoUrl ?? '(none)'}`,
    });
    console.error(`[publish] ok. url=${result.videoUrl ?? '(none surfaced — check Studio)'}`);
    console.log(JSON.stringify({
      ok: true,
      dryRun: false,
      url: result.videoUrl,
      visibility: result.visibility,
      approvalId: entry.id,
      title,
    }, null, 2));
  } catch (err) {
    rate({ id: entry.id, status: 'rejected', notes: `wizard error: ${err?.message ?? err}` });
    console.error(`[publish] upload error: ${err?.message ?? err}`);
    process.exit(3);
  } finally {
    if (session.ownsBrowser) session.browser.close();
  }
}

main().catch((err) => {
  console.error('[publish] fatal', err);
  process.exit(1);
});
