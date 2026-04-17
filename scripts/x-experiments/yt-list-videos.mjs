#!/usr/bin/env node
/**
 * yt-list-videos — enumerate recent videos on the logged-in channel.
 *
 * Prints { channelId, videos[], isEmpty } as JSON. On empty channels
 * (brand new, no uploads), videos:[] and isEmpty:true — not an error.
 *
 * Env:
 *   CHANNEL=UC...        override auto-detected channel id
 *   LIMIT=50             max rows to return (default 50)
 *
 * Run: node --import tsx scripts/x-experiments/yt-list-videos.mjs
 */
import { ensureYTStudio, listMyVideos } from '../../src/integrations/youtube/index.ts';

const CHANNEL = process.env.CHANNEL || undefined;
const LIMIT = Number.parseInt(process.env.LIMIT || '50', 10);

async function run() {
  const session = await ensureYTStudio({ throwOnChallenge: false });
  const channelId = CHANNEL || session.health.channelId;
  if (!channelId) {
    console.error(JSON.stringify({ ok: false, error: 'no channel id' }, null, 2));
    session.browser.close();
    process.exit(1);
  }
  const result = await listMyVideos(session.page, channelId, { limit: LIMIT });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  session.browser.close();
  process.exit(0);
}

run().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err?.message ?? String(err), stack: err?.stack }, null, 2));
  process.exit(3);
});
