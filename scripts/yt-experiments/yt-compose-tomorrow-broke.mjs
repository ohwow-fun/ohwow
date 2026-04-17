#!/usr/bin/env node
/**
 * yt-compose-tomorrow-broke — run one episode of Tomorrow Broke through
 * the composable pipeline. See yt-compose-core.mjs for the mechanics.
 *
 * Run with `node --import tsx scripts/yt-experiments/yt-compose-tomorrow-broke.mjs`.
 */
import { composeEpisode } from './yt-compose-core.mjs';

composeEpisode({ slug: 'tomorrow-broke', env: process.env }).then(
  (r) => process.exit(r.status === 'ok' ? 0 : 0),
  (e) => { console.error(e); process.exit(1); },
);
