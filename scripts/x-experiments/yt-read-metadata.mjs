#!/usr/bin/env node
/**
 * yt-read-metadata — read title/description/visibility/metrics for one video.
 *
 * Usage:
 *   node --import tsx scripts/x-experiments/yt-read-metadata.mjs <videoId>
 *
 * Prints the scraped metadata as JSON.
 */
import { ensureYTStudio, videoMetadata } from '../../src/integrations/youtube/index.ts';

const videoId = process.argv[2];
if (!videoId) {
  console.error('usage: yt-read-metadata.mjs <videoId>');
  process.exit(2);
}

async function run() {
  const session = await ensureYTStudio({ throwOnChallenge: false });
  const meta = await videoMetadata(session.page, videoId);
  console.log(JSON.stringify({ ok: true, ...meta }, null, 2));
  session.browser.close();
  process.exit(0);
}

run().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err?.message ?? String(err), stack: err?.stack }, null, 2));
  process.exit(3);
});
