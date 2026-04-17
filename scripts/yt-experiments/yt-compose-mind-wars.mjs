#!/usr/bin/env node
/**
 * yt-compose-mind-wars — run one episode of Mind Wars through the
 * composable pipeline. See yt-compose-core.mjs for the mechanics.
 *
 * Run with `node --import tsx scripts/yt-experiments/yt-compose-mind-wars.mjs`.
 */
import { composeEpisode } from './yt-compose-core.mjs';

composeEpisode({ slug: 'mind-wars', env: process.env }).then(
  (r) => process.exit(r.status === 'ok' ? 0 : 0),
  (e) => { console.error(e); process.exit(1); },
);
