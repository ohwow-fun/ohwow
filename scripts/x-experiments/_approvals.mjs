/**
 * Shadow-mode approval queue for x-experiments. Every LIVE action
 * (reply send, DM→orchestrator dispatch, knowledge upload) goes through
 * propose() first. The operator rates pending entries via
 * approval-queue.mjs, and apply() executes the approved ones.
 *
 * Queue location: ~/.ohwow/workspaces/<ws>/x-approvals.jsonl (one JSON per line).
 * Keeping it file-based keeps the surface tiny and lets operators grep/edit
 * the queue by hand when needed. If this pattern earns its keep, the next
 * step is a real table + an ohwow_create_approval MCP call.
 *
 * Entry schema:
 *   { id, ts, kind, workspace, summary, payload, status, rating?, notes? }
 *   kind ∈ 'reply' | 'dm_dispatch' | 'knowledge_upload'
 *   status ∈ 'pending' | 'approved' | 'rejected' | 'applied' | 'auto_applied'
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveOhwow } from './_ohwow.mjs';

function queuePath(workspace) {
  const ws = workspace || resolveOhwow().workspace;
  return path.join(os.homedir(), '.ohwow', 'workspaces', ws, 'x-approvals.jsonl');
}

export function loadQueue(workspace) {
  const p = queuePath(workspace);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function writeQueue(workspace, entries) {
  const p = queuePath(workspace);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

/**
 * Record a proposed action. Returns the full entry. If the kind has
 * earned N auto_applied threshold via past approved ratings, the entry
 * is created as 'auto_applied' (caller should apply immediately).
 */
export function propose({ kind, summary, payload, autoApproveAfter = 10 }) {
  const { workspace } = resolveOhwow();
  const all = loadQueue(workspace);
  const priorApproved = all.filter(e => e.kind === kind && (e.status === 'approved' || e.status === 'applied' || e.status === 'auto_applied')).length;
  const priorRejected = all.filter(e => e.kind === kind && e.status === 'rejected').length;
  const trusted = priorApproved >= autoApproveAfter && priorRejected <= Math.max(1, Math.floor(priorApproved / 10));
  const entry = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    kind, workspace, summary, payload,
    status: trusted ? 'auto_applied' : 'pending',
    trustStats: { priorApproved, priorRejected },
  };
  const next = [...all, entry];
  writeQueue(workspace, next);
  return entry;
}

export function rate({ id, status, notes }) {
  const { workspace } = resolveOhwow();
  const all = loadQueue(workspace);
  const idx = all.findIndex(e => e.id === id);
  if (idx === -1) throw new Error(`no such approval: ${id}`);
  all[idx] = { ...all[idx], status, notes, ratedAt: new Date().toISOString() };
  writeQueue(workspace, all);
  return all[idx];
}

export function stats(workspace) {
  const all = loadQueue(workspace);
  const byKind = {};
  for (const e of all) {
    byKind[e.kind] ??= { pending: 0, approved: 0, rejected: 0, applied: 0, auto_applied: 0 };
    byKind[e.kind][e.status] = (byKind[e.kind][e.status] || 0) + 1;
  }
  return { total: all.length, byKind };
}
