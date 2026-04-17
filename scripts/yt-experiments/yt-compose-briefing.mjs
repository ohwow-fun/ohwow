#!/usr/bin/env node
/**
 * yt-compose-briefing — run one episode of The Briefing through the
 * composable pipeline. See yt-compose-core.mjs for the mechanics.
 *
 * Env knobs:
 *   DRY=1 (default)     write brief only, no approval row, no upload
 *   DRY=0               write approval row; upload on auto-approve
 *   VISIBILITY=unlisted upload visibility (private/unlisted/public)
 *   HISTORY_DAYS=2      how far back to scan x-intel advancements rows
 *   SKIP_RENDER=1       skip the remotion render (for LLM-only testing)
 *   SKIP_VOICE=1        skip voice generation
 *
 * Run with `node --import tsx scripts/yt-experiments/yt-compose-briefing.mjs`.
 */
import { composeEpisode } from './yt-compose-core.mjs';

composeEpisode({ slug: 'briefing', env: process.env }).then(
  (r) => process.exit(r.status === 'ok' ? 0 : 0),
  (e) => { console.error(e); process.exit(1); },
);
