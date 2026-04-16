#!/usr/bin/env node
/**
 * approve-dm-reply.mjs — flip a pending x_dm_outbound approval to
 * 'approved' so XDmReplyDispatcher picks it up on the next tick.
 *
 * Usage:
 *   node scripts/approve-dm-reply.mjs              # list pending
 *   node scripts/approve-dm-reply.mjs <id|prefix>  # approve one
 *   node scripts/approve-dm-reply.mjs --all        # approve all pending
 *
 * Writes a status-update row to x-approvals.jsonl (append-only) using
 * the same convention as the TUI approvals screen.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const jsonlPath = path.join(os.homedir(), '.ohwow', 'workspaces', 'default', 'x-approvals.jsonl');
const arg = process.argv[2];

function readRows() {
  if (!fs.existsSync(jsonlPath)) return [];
  const raw = fs.readFileSync(jsonlPath, 'utf-8');
  const rows = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch {}
  }
  return rows;
}

function latestById(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.id, { ...(m.get(r.id) ?? {}), ...r });
  return m;
}

function appendApproval(id) {
  const entry = {
    id,
    ts: new Date().toISOString(),
    status: 'approved',
    notes: JSON.stringify({ approved_by: 'scripts/approve-dm-reply.mjs' }),
  };
  fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n', 'utf-8');
}

const rows = readRows();
const latest = latestById(rows);
const pendingDm = Array.from(latest.values()).filter(
  (e) => e.kind === 'x_dm_outbound' && e.status === 'pending',
);

if (!arg) {
  if (pendingDm.length === 0) {
    console.log('No pending x_dm_outbound approvals.');
    process.exit(0);
  }
  console.log(`${pendingDm.length} pending x_dm_outbound approval(s):\n`);
  for (const e of pendingDm) {
    const text = e.payload?.text ?? '';
    const name = e.payload?.contact_name ?? '(unknown)';
    console.log(`  ${e.id.slice(0, 8)}  → ${name}`);
    console.log(`    "${text.slice(0, 180)}"\n`);
  }
  console.log('Approve one:  node scripts/approve-dm-reply.mjs <id-prefix>');
  console.log('Approve all:  node scripts/approve-dm-reply.mjs --all');
  process.exit(0);
}

if (arg === '--all') {
  if (pendingDm.length === 0) {
    console.log('No pending approvals.');
    process.exit(0);
  }
  for (const e of pendingDm) {
    appendApproval(e.id);
    console.log(`approved ${e.id.slice(0, 8)}`);
  }
  process.exit(0);
}

const match = pendingDm.find((e) => e.id === arg || e.id.startsWith(arg));
if (!match) {
  console.error(`No pending x_dm_outbound approval matching "${arg}".`);
  process.exit(1);
}
appendApproval(match.id);
console.log(`approved ${match.id}`);
