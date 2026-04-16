/**
 * End-to-end-ish DRY test for x-authors-to-crm. We redirect HOME to a
 * tmp dir, write a synthetic sidecar + lead-gen-config, and verify:
 *   - the ledger gets written
 *   - per-passed-row briefs appear under /tmp
 *   - no HTTP calls (stub fetch to throw if called)
 *   - no LLM calls in DRY
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('x-authors-to-crm DRY path', () => {
  let tmp;
  let prevHome, prevUser, prevWs, prevDry;
  let prevFetch;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'x-a2c-'));
    prevHome = process.env.HOME; prevUser = process.env.USERPROFILE;
    prevWs = process.env.OHWOW_WORKSPACE; prevDry = process.env.DRY;
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.OHWOW_WORKSPACE = 'testws';
    process.env.DRY = '1';
    // Fail-loud: any fetch call means we leaked out of DRY.
    prevFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('fetch called during DRY'); };

    // Set up workspace dir + sidecar + lead-gen-config.
    const wsDir = join(tmp, '.ohwow', 'workspaces', 'testws');
    mkdirSync(wsDir, { recursive: true });
    const sidecarRows = [
      { handle: 'buyer_bob', display_name: 'Bob', permalink: '/buyer_bob/status/1', bucket: 'market_signal', score: 0.85, replies: 3, likes: 10, tags: ['llm'], first_seen_ts: '2026-04-15T00:00:00Z' },
      { handle: 'low_signal', display_name: 'Meh', permalink: '/low/status/2', bucket: 'market_signal', score: 0.2, replies: 0, likes: 0, tags: [], first_seen_ts: '2026-04-15T00:00:00Z' },
      { handle: 'wrong_bucket', display_name: 'WB', permalink: '/wb/status/3', bucket: 'noise', score: 0.9, replies: 1, likes: 2, tags: [], first_seen_ts: '2026-04-15T00:00:00Z' },
    ];
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(
      join(wsDir, `x-authors-${date}.jsonl`),
      sidecarRows.map(r => JSON.stringify(r)).join('\n') + '\n',
    );
    writeFileSync(join(wsDir, 'lead-gen-config.json'), JSON.stringify({
      icp: { description: 'small-team builders' },
      freeGates: {
        minScore: 0.6, minReplies: 0, minTouches: 1,
        allowedBuckets: ['market_signal', 'competitors'],
        engagerBoost: { ownPostReplyReducesMinScoreTo: 0.4 },
      },
      intentClassifier: { minConfidence: 0.7, acceptClasses: ['buyer_intent'] },
    }));
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUser;
    if (prevWs === undefined) delete process.env.OHWOW_WORKSPACE; else process.env.OHWOW_WORKSPACE = prevWs;
    if (prevDry === undefined) delete process.env.DRY; else process.env.DRY = prevDry;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes briefs for free-gate-passing rows and skips rejects', async () => {
    // Import lazily so the module picks up our env setup.
    const { main } = await import('../x-authors-to-crm.mjs');
    const report = await main();

    expect(report.dry).toBe(true);
    expect(report.sidecarRows).toBe(3);
    expect(report.ledgerTotal).toBe(3);
    expect(report.llmCalls).toBe(0); // DRY: no classification
    expect(report.promoted).toBe(0); // DRY never promotes
    expect(report.freeGatePassed).toBe(1); // only buyer_bob passes
    expect(report.freeGateRejected).toBe(2); // low_signal + wrong_bucket

    // Brief for buyer_bob should exist.
    expect(existsSync(report.briefDir)).toBe(true);
    const files = readdirSync(report.briefDir);
    expect(files).toHaveLength(1);
    const brief = JSON.parse(readFileSync(join(report.briefDir, files[0]), 'utf8'));
    expect(brief.entry.kind).toBe('x_contact_create');
    expect(brief.row.handle).toBe('buyer_bob');

    // Ledger was written under the tmp HOME.
    const ledgerPath = join(tmp, '.ohwow', 'workspaces', 'testws', 'x-authors-ledger.jsonl');
    expect(existsSync(ledgerPath)).toBe(true);
    const ledgerRows = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(ledgerRows).toHaveLength(3);
    expect(ledgerRows.every(r => r.qualified_ts === null)).toBe(true);

    rmSync(report.briefDir, { recursive: true, force: true });

    // DRY mode must NOT write the live-path classifier audit log.
    const auditPath = join(tmp, '.ohwow', 'workspaces', 'testws', 'x-authors-classifier-log.jsonl');
    expect(existsSync(auditPath)).toBe(false);
  });
});

describe('appendClassifierAudit', () => {
  let tmp;
  let prevHome, prevUser;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'x-a2c-audit-'));
    prevHome = process.env.HOME; prevUser = process.env.USERPROFILE;
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUser;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('appends a JSONL row, creating the workspace dir if missing', async () => {
    const { appendClassifierAudit } = await import('../x-authors-to-crm.mjs');
    appendClassifierAudit('newws', {
      ts: '2026-04-16T19:00:00Z',
      workspace: 'newws',
      handle: 'alice',
      bucket: 'market_signal',
      intent: 'buyer_intent',
      confidence: 0.82,
      accepted: true,
      promoted: true,
    });
    appendClassifierAudit('newws', {
      ts: '2026-04-16T19:01:00Z',
      workspace: 'newws',
      handle: 'bob',
      bucket: 'advancements',
      intent: 'adjacent_noise',
      confidence: 0.4,
      accepted: false,
      promoted: false,
    });
    const p = join(tmp, '.ohwow', 'workspaces', 'newws', 'x-authors-classifier-log.jsonl');
    expect(existsSync(p)).toBe(true);
    const rows = readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0].handle).toBe('alice');
    expect(rows[0].accepted).toBe(true);
    expect(rows[1].handle).toBe('bob');
    expect(rows[1].accepted).toBe(false);
  });
});
