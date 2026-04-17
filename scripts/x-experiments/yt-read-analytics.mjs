#!/usr/bin/env node
/**
 * yt-read-analytics — channel dashboard summary + analytics overview.
 *
 * Prints { summary, overview } as JSON. Requires a logged-in Studio
 * session; run yt-health.mjs first to confirm.
 *
 * Env:
 *   CHANNEL=UC...         override auto-detected channel id
 *   WINDOW=28             analytics window in days (7, 28, 90, 365)
 *   OPEN=1                open Studio if no tab exists
 *
 * Run: node --import tsx scripts/x-experiments/yt-read-analytics.mjs
 */
import { ensureYTStudio, channelSummary, analyticsOverview } from '../../src/integrations/youtube/index.ts';

const CHANNEL = process.env.CHANNEL || undefined;
const WINDOW = Number.parseInt(process.env.WINDOW || '28', 10);

async function run() {
  const session = await ensureYTStudio({ throwOnChallenge: false });
  const channelId = CHANNEL || session.health.channelId;
  if (!channelId) {
    console.error(JSON.stringify({ ok: false, error: 'no channel id — sign in or pass CHANNEL=UC...' }, null, 2));
    session.browser.close();
    process.exit(1);
  }

  const summary = await channelSummary(session.page, channelId);
  let overview = null;
  let overviewError = null;
  try {
    overview = await analyticsOverview(session.page, channelId, WINDOW);
  } catch (err) {
    overviewError = err?.message ?? String(err);
  }

  const report = { ok: true, channelId, summary, overview, overviewError, windowDays: WINDOW };
  console.log(JSON.stringify(report, null, 2));
  session.browser.close();
  process.exit(0);
}

run().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err?.message ?? String(err), stack: err?.stack }, null, 2));
  process.exit(3);
});
