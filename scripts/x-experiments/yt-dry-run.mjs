#!/usr/bin/env node
/**
 * yt-dry-run — exercise the full upload wizard without publishing.
 *
 * Generates a tiny 5-second 9:16 MP4 via ffmpeg, runs the hardened
 * uploadShort() with dryRun:true (stops before Save and cancels the
 * dialog), and prints the structured stage timeline as JSON.
 *
 * Nothing gets published. If the channel has no new videos in its
 * content list after the run, the test passes. Safe to repeat.
 *
 * Env:
 *   KEEP_DIALOG=1       skip the discard-on-exit (useful for post-mortem)
 *   VISIBILITY=unlisted which radio to SELECT (won't actually publish)
 *
 * Run: node --import tsx scripts/x-experiments/yt-dry-run.mjs
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureYTStudio, uploadShort } from '../../src/integrations/youtube/index.ts';

const VISIBILITY = (process.env.VISIBILITY || 'unlisted').toLowerCase();

function ensureTestVideo() {
  const testPath = path.join(os.tmpdir(), 'ohwow-yt-dryrun.mp4');
  if (fs.existsSync(testPath)) return testPath;
  execSync(
    `ffmpeg -y -f lavfi -i "color=c=black:s=1080x1920:d=5" -c:v libx264 -preset ultrafast -crf 28 "${testPath}" 2>/dev/null`,
    { timeout: 20_000 },
  );
  return testPath;
}

async function run() {
  const filePath = ensureTestVideo();
  const session = await ensureYTStudio({ throwOnChallenge: true });
  const startedAt = Date.now();
  const stages = [];
  try {
    const result = await uploadShort(session.page, {
      filePath,
      title: `dry-run ${new Date().toISOString()}`,
      description: 'automated dry-run — should never actually publish',
      visibility: VISIBILITY,
      dryRun: true,
      onStage: (ev) => {
        stages.push(ev);
        process.stderr.write(`[stage] ${ev.stage} ${ev.ok ? 'ok' : 'FAIL'} ${ev.durationMs}ms${ev.error ? ' — ' + ev.error : ''}\n`);
      },
    });
    console.log(JSON.stringify({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      dryRun: result.dryRun,
      visibility: result.visibility,
      wouldBeUrl: result.videoUrl,
      stageCount: result.stages.length,
      stages: result.stages,
    }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: err?.message ?? String(err),
      name: err?.name,
      stageTimeline: stages,
    }, null, 2));
    process.exit(1);
  } finally {
    session.browser.close();
  }
}

run().catch((err) => {
  console.error(JSON.stringify({ ok: false, fatal: true, error: err?.message ?? String(err) }, null, 2));
  process.exit(3);
});
