#!/usr/bin/env node
/**
 * yt-series-digest — daily stand-up across all enabled series. Prints:
 *   - last 24h uploaded / approved / pending drafts per series
 *   - current goal progress
 *   - approval backlog (count + oldest age)
 *   - kill-switch state (env + workspace.json)
 *   - last 5 episode metrics per series (if available)
 *
 * Read this first thing every morning. If any series shows 0 shipped and
 * ≥2 pending approvals older than 36h, clear the backlog before enabling
 * new cadences.
 *
 * TODO(phase-4): wire yt_short_drafts + yt_episode_metrics queries once
 * the daemon exposes /api/yt-drafts + /api/yt-metrics endpoints (Phase 5).
 * Until then this script surfaces what it can from workspace config +
 * approval JSONL.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOhwow } from '../x-experiments/_ohwow.mjs';
import { listSeries, SERIES } from '../../src/integrations/youtube/series/registry.js';

const { workspace } = resolveOhwow();
const approvalsPath = path.join(os.homedir(), '.ohwow', 'workspaces', workspace, 'x-approvals.jsonl');

function loadApprovals() {
  if (!fs.existsSync(approvalsPath)) return [];
  return fs.readFileSync(approvalsPath, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function killSwitchState(series) {
  const envFlag = process.env[series.killSwitchEnv];
  const masterEnv = process.env.OHWOW_YT_SHORTS_ENABLED;
  // Workspace file check.
  try {
    const wsCfg = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.ohwow', 'workspaces', workspace, 'workspace.json'), 'utf8'),
    );
    const wsFlag = wsCfg[`yt${series.slug.split('-').map((p, i) => (i === 0 ? p[0].toUpperCase() + p.slice(1) : p[0].toUpperCase() + p.slice(1))).join('')}Enabled`];
    return { env: envFlag, masterEnv, workspace: wsFlag };
  } catch {
    return { env: envFlag, masterEnv, workspace: undefined };
  }
}

function sinceHours(iso) {
  return Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
}

function bar(n, max, width = 12) {
  const filled = Math.max(0, Math.min(width, Math.round((n / max) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function digestSeries(s, allApprovals) {
  const recent = allApprovals.filter((a) => a.kind === s.approvalKind);
  const last24h = recent.filter((a) => sinceHours(a.ts) <= 24);
  const pending = recent.filter((a) => a.status === 'pending');
  const uploaded = recent.filter((a) => a.status === 'auto_applied' || a.status === 'applied');
  const oldestPending = pending
    .map((a) => sinceHours(a.ts))
    .sort((x, y) => y - x)[0];
  const ks = killSwitchState(s);
  const active = ks.env === 'true' || ks.workspace === true;
  return {
    slug: s.slug,
    display: s.displayName,
    uploaded24h: last24h.filter((a) => a.status === 'auto_applied' || a.status === 'applied').length,
    drafted24h: last24h.length,
    pendingTotal: pending.length,
    pendingOldestHours: oldestPending ?? 0,
    uploadedTotal: uploaded.length,
    killSwitch: active ? 'ON' : 'OFF',
    warn: !active ? 'disabled' : (oldestPending > 36 ? 'stale-backlog' : null),
  };
}

function main() {
  const approvals = loadApprovals();
  const rows = listSeries({ onlyEnabled: true }).map((s) => digestSeries(s, approvals));

  const masterKill = process.env.OHWOW_YT_SHORTS_ENABLED === 'true';
  console.log('\n' + '='.repeat(60));
  console.log(`  OHWOW.FUN daily digest · ws=${workspace} · master=${masterKill ? 'ON' : 'OFF'}`);
  console.log('='.repeat(60));

  for (const r of rows) {
    console.log(`\n${r.display}  [${r.slug}]  switch=${r.killSwitch}${r.warn ? '  ⚠ ' + r.warn : ''}`);
    console.log(`  24h: drafted=${r.drafted24h}  uploaded=${r.uploaded24h}  pending=${r.pendingTotal} (oldest ${r.pendingOldestHours}h)`);
    console.log(`  total uploaded (lifetime approvals): ${r.uploadedTotal}`);
  }

  // Parked series (bot-beats): show as disabled with its registry entry.
  const parked = Object.values(SERIES).filter((s) => !s.enabled);
  if (parked.length) {
    console.log('\n' + '-'.repeat(60));
    console.log(`Deferred series: ${parked.map((s) => s.displayName).join(', ')}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('next: read docs/youtube/ops-runbook.md if any backlog is stale.\n');
}

main();
