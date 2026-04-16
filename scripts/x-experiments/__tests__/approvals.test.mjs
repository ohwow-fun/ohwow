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

describe('propose() with bucketBy + maxPriorRejected (x_outbound_post escalation)', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'approvals-bucket-test-'));
    process.env.HOME = tmpHome;
    seedDaemon();
  });
  afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

  function seedQueueRows(rows) {
    const p = join(tmpHome, '.ohwow', 'workspaces', WS, 'x-approvals.jsonl');
    writeFileSync(p, rows.map(r => JSON.stringify({
      id: r.id, ts: new Date().toISOString(), workspace: WS,
      summary: 's', ...r,
    })).join('\n') + '\n');
  }

  it('shape with 3+ clean approvals auto_applies under bucketBy=shape', () => {
    seedQueueRows([
      { id: 'a', kind: 'x_outbound_post', status: 'applied',      payload: { shape: 'tactical_tip' } },
      { id: 'b', kind: 'x_outbound_post', status: 'auto_applied', payload: { shape: 'tactical_tip' } },
      { id: 'c', kind: 'x_outbound_post', status: 'approved',     payload: { shape: 'tactical_tip' } },
    ]);
    const e = approvals.propose({
      kind: 'x_outbound_post', summary: 's',
      payload: { shape: 'tactical_tip', post_text: 'x' },
      autoApproveAfter: 3, bucketBy: 'shape', maxPriorRejected: 0,
    });
    expect(e.status).toBe('auto_applied');
  });

  it('one rejection in same shape forces pending (maxPriorRejected=0)', () => {
    seedQueueRows([
      { id: 'a', kind: 'x_outbound_post', status: 'applied',  payload: { shape: 'humor' } },
      { id: 'b', kind: 'x_outbound_post', status: 'applied',  payload: { shape: 'humor' } },
      { id: 'c', kind: 'x_outbound_post', status: 'applied',  payload: { shape: 'humor' } },
      { id: 'd', kind: 'x_outbound_post', status: 'rejected', payload: { shape: 'humor' } },
    ]);
    const e = approvals.propose({
      kind: 'x_outbound_post', summary: 's',
      payload: { shape: 'humor', post_text: 'x' },
      autoApproveAfter: 3, bucketBy: 'shape', maxPriorRejected: 0,
    });
    expect(e.status).toBe('pending');
  });

  it('rejections in OTHER shapes do not block escalation', () => {
    seedQueueRows([
      { id: 'a', kind: 'x_outbound_post', status: 'applied',  payload: { shape: 'tactical_tip' } },
      { id: 'b', kind: 'x_outbound_post', status: 'applied',  payload: { shape: 'tactical_tip' } },
      { id: 'c', kind: 'x_outbound_post', status: 'applied',  payload: { shape: 'tactical_tip' } },
      { id: 'd', kind: 'x_outbound_post', status: 'rejected', payload: { shape: 'humor' } },
      { id: 'e', kind: 'x_outbound_post', status: 'rejected', payload: { shape: 'opinion' } },
    ]);
    const e = approvals.propose({
      kind: 'x_outbound_post', summary: 's',
      payload: { shape: 'tactical_tip', post_text: 'x' },
      autoApproveAfter: 3, bucketBy: 'shape', maxPriorRejected: 0,
    });
    expect(e.status).toBe('auto_applied');
    expect(e.trustStats.priorApproved).toBe(3);
    expect(e.trustStats.priorRejected).toBe(0);
    expect(e.trustStats.bucketValue).toBe('tactical_tip');
  });

  it('approvals in OTHER shapes do not count toward this shape', () => {
    seedQueueRows([
      { id: 'a', kind: 'x_outbound_post', status: 'applied', payload: { shape: 'tactical_tip' } },
      { id: 'b', kind: 'x_outbound_post', status: 'applied', payload: { shape: 'tactical_tip' } },
      { id: 'c', kind: 'x_outbound_post', status: 'applied', payload: { shape: 'tactical_tip' } },
    ]);
    const e = approvals.propose({
      kind: 'x_outbound_post', summary: 's',
      payload: { shape: 'humor', post_text: 'x' },
      autoApproveAfter: 3, bucketBy: 'shape', maxPriorRejected: 0,
    });
    expect(e.status).toBe('pending');
    expect(e.trustStats.priorApproved).toBe(0);
  });

  it('payload missing the bucket key stays pending (cannot trust by absent bucket)', () => {
    seedQueueRows([
      { id: 'a', kind: 'x_outbound_post', status: 'applied', payload: { shape: 'tactical_tip' } },
      { id: 'b', kind: 'x_outbound_post', status: 'applied', payload: { shape: 'tactical_tip' } },
      { id: 'c', kind: 'x_outbound_post', status: 'applied', payload: { shape: 'tactical_tip' } },
    ]);
    const e = approvals.propose({
      kind: 'x_outbound_post', summary: 's',
      payload: { post_text: 'x' }, // no shape
      autoApproveAfter: 3, bucketBy: 'shape', maxPriorRejected: 0,
    });
    expect(e.status).toBe('pending');
  });

  it('maxPriorRejected=null preserves the legacy ratio rule', () => {
    // 10 approvals + 1 rejection of the same kind: legacy ceiling is
    // max(1, floor(10/10)) = 1, so 1 rejection still trusts.
    seedQueueRows(Array.from({ length: 10 }, (_, i) => ({
      id: `a-${i}`, kind: 'x_outbound_reply', status: 'applied', payload: { bucket: 'ms' },
    })).concat([
      { id: 'r', kind: 'x_outbound_reply', status: 'rejected', payload: { bucket: 'ms' } },
    ]));
    const e = approvals.propose({
      kind: 'x_outbound_reply', summary: 's', payload: { bucket: 'ms' },
      autoApproveAfter: 10, // no bucketBy, no maxPriorRejected
    });
    expect(e.status).toBe('auto_applied');
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
