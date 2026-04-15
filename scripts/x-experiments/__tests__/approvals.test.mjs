/**
 * Tests for _approvals.propose gate callback + _outbound-gate.buildOutboundGate.
 * Uses a tmp HOME so the queue file lands in an isolated workspace dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as approvals from '../_approvals.mjs';
import * as gate from '../_outbound-gate.mjs';

let tmpHome;
const WS = 'default';

function seedDaemon(token = 'tk') {
  const dir = join(tmpHome, '.ohwow', 'workspaces', WS);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'daemon.token'), token);
  writeFileSync(join(tmpHome, '.ohwow', 'current-workspace'), WS);
}

function seedTrust(kind, count = 5) {
  const p = join(tmpHome, '.ohwow', 'workspaces', WS, 'x-approvals.jsonl');
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify({
      id: `seed-${i}`, ts: new Date().toISOString(), kind, workspace: WS,
      summary: 's', payload: {}, status: 'approved',
    }));
  }
  writeFileSync(p, lines.join('\n') + '\n');
}

function seedScores(rows) {
  const p = join(tmpHome, '.ohwow', 'workspaces', WS, 'x-predictions-scores.jsonl');
  writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

describe('propose() with gate', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'approvals-test-'));
    process.env.HOME = tmpHome;
    seedDaemon();
  });
  afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

  it('gate absent: trusted entries auto_apply as before', async () => {
    
    seedTrust('x_contact_create', 3);
    const e = approvals.propose({ kind: 'x_contact_create', summary: 's', payload: {}, autoApproveAfter: 3 });
    expect(e.status).toBe('auto_applied');
  });

  it('gate returns true: trusted entries still auto_apply', async () => {
    
    seedTrust('x_outbound_reply', 10);
    const e = approvals.propose({
      kind: 'x_outbound_reply', summary: 's', payload: { bucket: 'ms' },
      autoApproveAfter: 8, gate: () => true,
    });
    expect(e.status).toBe('auto_applied');
  });

  it('gate returns false: forces pending even when trusted', async () => {
    
    seedTrust('x_outbound_reply', 10);
    const e = approvals.propose({
      kind: 'x_outbound_reply', summary: 's', payload: { bucket: 'ms' },
      autoApproveAfter: 8, gate: () => false,
    });
    expect(e.status).toBe('pending');
  });

  it('gate throws: treated as false (fail closed)', async () => {
    
    seedTrust('x_outbound_reply', 10);
    const e = approvals.propose({
      kind: 'x_outbound_reply', summary: 's', payload: { bucket: 'ms' },
      autoApproveAfter: 8, gate: () => { throw new Error('boom'); },
    });
    expect(e.status).toBe('pending');
  });

  it('gate not consulted when below trust threshold', async () => {
    
    // No prior approvals → not trusted → gate irrelevant, status=pending.
    let called = false;
    const e = approvals.propose({
      kind: 'x_outbound_reply', summary: 's', payload: { bucket: 'ms' },
      autoApproveAfter: 8, gate: () => { called = true; return true; },
    });
    expect(e.status).toBe('pending');
    expect(called).toBe(false);
  });
});

describe('buildOutboundGate', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'outbound-gate-test-'));
    process.env.HOME = tmpHome;
    seedDaemon();
  });
  afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

  it('returns false when no accuracy data exists (fail-closed)', async () => {
    
    const g = gate.buildOutboundGate(WS);
    expect(g('x_outbound_reply', { bucket: 'market_signal' })).toBe(false);
  });

  it('returns true when bucket accuracy ≥ floor', async () => {
    
    const now = new Date().toISOString();
    seedScores([
      { judged_at: now, bucket: 'market_signal', verdict: 'hit' },
      { judged_at: now, bucket: 'market_signal', verdict: 'hit' },
      { judged_at: now, bucket: 'market_signal', verdict: 'partial' },
    ]);
    const g = gate.buildOutboundGate(WS);
    expect(g('x_outbound_reply', { bucket: 'market_signal' })).toBe(true);
  });

  it('returns false when bucket accuracy below floor', async () => {
    
    const now = new Date().toISOString();
    seedScores([
      { judged_at: now, bucket: 'market_signal', verdict: 'miss' },
      { judged_at: now, bucket: 'market_signal', verdict: 'miss' },
      { judged_at: now, bucket: 'market_signal', verdict: 'partial' },
    ]);
    const g = gate.buildOutboundGate(WS);
    expect(g('x_outbound_reply', { bucket: 'market_signal' })).toBe(false);
  });

  it('returns false when payload has no bucket', async () => {
    
    const now = new Date().toISOString();
    seedScores([{ judged_at: now, bucket: 'market_signal', verdict: 'hit' }]);
    const g = gate.buildOutboundGate(WS);
    expect(g('x_outbound_reply', {})).toBe(false);
  });
});
