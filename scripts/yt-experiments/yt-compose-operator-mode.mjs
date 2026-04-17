#!/usr/bin/env node
/**
 * yt-compose-operator-mode — run one episode of Operator Mode through
 * the composable pipeline. See yt-compose-core.mjs for the mechanics.
 *
 * Run with `node --import tsx scripts/yt-experiments/yt-compose-operator-mode.mjs`.
 */
import { composeEpisode } from './yt-compose-core.mjs';

composeEpisode({ slug: 'operator-mode', env: process.env }).then(
  (r) => process.exit(r.status === 'ok' ? 0 : 0),
  (e) => { console.error(e); process.exit(1); },
);
