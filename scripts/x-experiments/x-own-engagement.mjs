#!/usr/bin/env node
/**
 * x-own-engagement — Piece 4a of the surprise-first bundle.
 *
 * Visits our own X profile, harvests recent posts with their current
 * engagement metrics (likes / replies / reposts / views), and writes a
 * per-post timestamped row into
 *   ~/.ohwow/workspaces/<workspace>/x-own-posts.jsonl
 * One JSONL row per (post permalink, snapshot timestamp). The
 * engagement-observer experiment (Piece 4b) reads these rows to
 * compute per-shape engagement baselines and feed the autonomy ramp.
 *
 * Why a per-snapshot row rather than mutating one row per post:
 *   - JSONL append is atomic; mutating in place needs a read+write
 *     cycle that races with parallel runs of this script.
 *   - Snapshots over time let us measure growth (likes at T+1h vs
 *     T+24h) which is the actual signal for "did this post land?".
 *
 * Resolves the self handle from (in priority order):
 *   1. process.env.OHWOW_X_SELF_HANDLE
 *   2. cfg.own_handle field in x-config.json
 *   3. The DOM at x.com — reads AppTabBar_Profile_Link href
 * If none resolve, exits 0 with a warning (operator hasn't logged in
 * yet or hasn't set the handle).
 *
 * Usage:
 *   OHWOW_WORKSPACE=default node scripts/x-experiments/x-own-engagement.mjs
 *   --max-posts=20    cap the number of recent posts to harvest
 *   --quiet           silence per-post log lines
 *
 * Cadence (when wired into x-intel-scheduler): every 6h is enough to
 * catch the bulk of post engagement growth without burning the
 * bandwidth Twitter rate-limits. Same browser session as the rest of
 * the X scripts via ensureXReady().
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureXReady } from './_x-browser.mjs';
import { scrollAndHarvest } from './_x-harvest.mjs';

const WORKSPACE = process.env.OHWOW_WORKSPACE || 'default';
const WORKSPACE_DIR = path.join(os.homedir(), '.ohwow', 'workspaces', WORKSPACE);
const CONFIG_PATH = path.join(WORKSPACE_DIR, 'x-config.json');
const OUTPUT_PATH = path.join(WORKSPACE_DIR, 'x-own-posts.jsonl');

const args = new Set(process.argv.slice(2));
const QUIET = args.has('--quiet');
const MAX_POSTS = (() => {
  for (const a of process.argv.slice(2)) {
    const m = /^--max-posts=(\d+)$/.exec(a);
    if (m) return Number(m[1]);
  }
  return 20;
})();

function log(...m) { if (!QUIET) console.log('[x-own-engagement]', ...m); }
function warn(...m) { console.warn('[x-own-engagement]', ...m); }

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    warn('failed to parse x-config.json:', err.message);
    return {};
  }
}

async function resolveOwnHandle(page, cfg) {
  if (process.env.OHWOW_X_SELF_HANDLE) return process.env.OHWOW_X_SELF_HANDLE;
  if (cfg.own_handle) return cfg.own_handle;
  try {
    const handle = await page.evaluate(`(() => {
      const link = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
      return link ? link.getAttribute('href').replace(/^\\//, '') : null;
    })()`);
    return handle || null;
  } catch (err) {
    warn('AppTabBar profile-link probe failed:', err.message);
    return null;
  }
}

function appendSnapshot(row) {
  try {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.appendFileSync(OUTPUT_PATH, JSON.stringify(row) + '\n', 'utf-8');
  } catch (err) {
    warn('append failed:', err.message);
  }
}

async function main() {
  const cfg = readConfig();
  const { page } = await ensureXReady();
  const handle = await resolveOwnHandle(page, cfg);
  if (!handle) {
    warn('no own_handle resolvable. Set OHWOW_X_SELF_HANDLE or cfg.own_handle in x-config.json. Exiting.');
    process.exit(0);
  }

  log(`harvesting own profile @${handle}`);
  const url = `https://x.com/${handle}`;
  const posts = await scrollAndHarvest(page, url, 6);
  // Keep only original posts authored by us (filters retweets, replies,
  // pinned-but-not-mine entries that show on profile pages).
  const own = posts
    .filter((p) => p.author === handle && !p.isRetweet && !p.replyingTo)
    .slice(0, MAX_POSTS);

  log(`found ${own.length} own posts (cap=${MAX_POSTS})`);

  const ts = new Date().toISOString();
  for (const p of own) {
    const row = {
      ts,
      permalink: p.permalink,
      author: p.author,
      datetime: p.datetime,
      text: p.text,
      likes: p.likes ?? 0,
      replies: p.replies ?? 0,
      reposts: p.reposts ?? 0,
      views: p.views ?? 0,
    };
    appendSnapshot(row);
    if (!QUIET) {
      log(`  ${p.permalink} likes=${row.likes} replies=${row.replies} views=${row.views}`);
    }
  }

  log(`wrote ${own.length} snapshot row(s) to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  warn('fatal:', err.message);
  process.exit(1);
});
