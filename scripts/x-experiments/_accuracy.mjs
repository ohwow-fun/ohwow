/**
 * Rolling N-day forecast accuracy per bucket. Computed from the scorer's
 * output at ~/.ohwow/workspaces/<ws>/x-predictions-scores.jsonl.
 *
 * Verdict weights: hit=1, partial=0.5, miss=0.
 * Returns { [bucketId]: { n, acc } }. Empty object when no scores yet —
 * callers must treat "no data" as a distinct signal, not "zero accuracy".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function scoresPath(workspace) {
  return path.join(os.homedir(), '.ohwow', 'workspaces', workspace, 'x-predictions-scores.jsonl');
}

export function loadRollingAccuracy(workspace, daysBack = 30) {
  const p = scoresPath(workspace);
  if (!fs.existsSync(p)) return {};
  const cutoff = Date.now() - daysBack * 86400_000;
  const rows = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && r.judged_at && new Date(r.judged_at).getTime() >= cutoff);
  const agg = {};
  for (const r of rows) {
    if (!agg[r.bucket]) agg[r.bucket] = { n: 0, sum: 0 };
    agg[r.bucket].n++;
    agg[r.bucket].sum += r.verdict === 'hit' ? 1 : r.verdict === 'partial' ? 0.5 : 0;
  }
  const out = {};
  for (const [b, v] of Object.entries(agg)) out[b] = { n: v.n, acc: v.sum / v.n };
  return out;
}
