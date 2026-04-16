/**
 * Unit tests for the pure helpers in _qualify.mjs and _author-ledger.mjs.
 * No LLM, no disk — ledger tests use a tmpdir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freeGates, acceptsIntent, classifyIntent, loadLeadGenConfig, buildAutoApproveGate, loadProposedHandles } from '../_qualify.mjs';
import { loadLedger, saveLedger, upsertAuthor, markQualified, isQualified } from '../_author-ledger.mjs';

const rubric = {
  icp: { description: 'small-team founders shipping AI agents', disqualifiers: ['bot'] },
  freeGates: {
    minScore: 0.6,
    minReplies: 0,
    minTouches: 1,
    allowedBuckets: ['market_signal', 'competitors'],
    engagerBoost: { ownPostReplyReducesMinScoreTo: 0.4 },
  },
  intentClassifier: { minConfidence: 0.7, acceptClasses: ['buyer_intent'] },
};

describe('freeGates', () => {
  it('passes a typical high-score market_signal row', () => {
    const row = { handle: 'a', score: 0.8, replies: 1, touches: 2, bucket: 'market_signal', sources: ['sidecar'] };
    expect(freeGates(rubric, row)).toEqual({ decision: 'pass', reason: 'free-gates-pass' });
  });

  it('rejects low score when not an engager', () => {
    const row = { handle: 'a', score: 0.5, touches: 2, bucket: 'market_signal', sources: ['sidecar'] };
    expect(freeGates(rubric, row).decision).toBe('reject');
  });

  it('passes low-score row when engager boost applies', () => {
    const row = { handle: 'a', score: 0.45, touches: 1, bucket: 'market_signal', sources: ['engager:own-post'] };
    expect(freeGates(rubric, row)).toEqual({ decision: 'pass', reason: 'engager-boost' });
  });

  it('rejects when bucket not in allowlist', () => {
    const row = { handle: 'a', score: 0.9, touches: 2, bucket: 'noise', sources: ['sidecar'] };
    expect(freeGates(rubric, row).decision).toBe('reject');
  });

  it('rejects when touches below threshold', () => {
    const row = { handle: 'a', score: 0.9, touches: 0, bucket: 'market_signal', sources: ['sidecar'] };
    expect(freeGates(rubric, row).decision).toBe('reject');
  });

  it('ignores bucket allowlist when not configured', () => {
    const openRubric = { freeGates: { minScore: 0.1 } };
    const row = { handle: 'a', score: 0.5, touches: 0, bucket: 'anything', sources: [] };
    expect(freeGates(openRubric, row).decision).toBe('pass');
  });
});

describe('acceptsIntent', () => {
  it('accepts buyer_intent above confidence floor', () => {
    expect(acceptsIntent({ intent: 'buyer_intent', confidence: 0.8, reason: '' }, rubric)).toBe(true);
  });
  it('rejects buyer_intent below confidence floor', () => {
    expect(acceptsIntent({ intent: 'buyer_intent', confidence: 0.5, reason: '' }, rubric)).toBe(false);
  });
  it('rejects non-accepted classes', () => {
    expect(acceptsIntent({ intent: 'builder_curiosity', confidence: 0.99, reason: '' }, rubric)).toBe(false);
  });
});

describe('classifyIntent', () => {
  it('parses the llm JSON into a normalized verdict', async () => {
    const llmFn = async () => '{"intent":"buyer_intent","confidence":0.85,"reason":"asking about pricing"}';
    const extractJson = (t) => JSON.parse(t);
    const out = await classifyIntent({ handle: 'a', bucket: 'market_signal' }, rubric, llmFn, { extractJson });
    expect(out.intent).toBe('buyer_intent');
    expect(out.confidence).toBe(0.85);
  });

  it('coerces unknown intent class to adjacent_noise', async () => {
    const llmFn = async () => '{"intent":"maybe","confidence":0.9,"reason":""}';
    const extractJson = (t) => JSON.parse(t);
    const out = await classifyIntent({ handle: 'a' }, rubric, llmFn, { extractJson });
    expect(out.intent).toBe('adjacent_noise');
  });

  it('clamps confidence into [0,1]', async () => {
    const llmFn = async () => '{"intent":"buyer_intent","confidence":5,"reason":""}';
    const extractJson = (t) => JSON.parse(t);
    const out = await classifyIntent({ handle: 'a' }, rubric, llmFn, { extractJson });
    expect(out.confidence).toBe(1);
  });
});

describe('author ledger', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'ledger-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('upsert merges touches, max-score, union of tags/sources', () => {
    const ledger = new Map();
    upsertAuthor(ledger, { handle: 'Alice', score: 0.5, tags: ['a'], source: 'sidecar', bucket: 'market_signal' });
    upsertAuthor(ledger, { handle: 'alice', score: 0.8, tags: ['b'], source: 'engager:own-post' });
    const row = ledger.get('alice');
    expect(row.touches).toBe(2);
    expect(row.score).toBe(0.8);
    expect(row.tags.sort()).toEqual(['a', 'b']);
    expect(row.sources.sort()).toEqual(['engager:own-post', 'sidecar']);
    expect(row.bucket).toBe('market_signal');
  });

  it('mark + isQualified round-trip via disk', () => {
    // Use a custom home by redirecting via env isn't trivial for this module
    // since it hardcodes os.homedir() inside ledgerPath. Instead write via
    // the save/load API using a fake workspace under a subdir we can clean.
    const workspace = `qualify-test-${Date.now()}`;
    const homedir = tmp;
    // Redirect HOME so os.homedir() resolves into tmp. Node caches homedir
    // per-process on some platforms; set both common envs.
    const prevHome = process.env.HOME;
    const prevUser = process.env.USERPROFILE;
    process.env.HOME = homedir;
    process.env.USERPROFILE = homedir;
    try {
      const ledger = new Map();
      upsertAuthor(ledger, { handle: 'bob', score: 0.7, bucket: 'market_signal', source: 'sidecar' });
      saveLedger(workspace, ledger);
      const reloaded = loadLedger(workspace);
      expect(reloaded.has('bob')).toBe(true);
      expect(isQualified(reloaded, 'bob')).toBe(false);
      markQualified(reloaded, 'bob', 'contact-id-123');
      saveLedger(workspace, reloaded);
      const again = loadLedger(workspace);
      expect(isQualified(again, 'bob')).toBe(true);
      expect(again.get('bob').crm_contact_id).toBe('contact-id-123');
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUser;
    }
  });
});

describe('buildAutoApproveGate', () => {
  const baseRubric = {
    autoApprove: {
      enabled: true,
      minConfidence: 0.85,
      minScore: 0.7,
      allowedBuckets: ['market_signal'],
      acceptIntents: ['buyer_intent'],
      dailyCap: 5,
    },
  };
  const happyPayload = {
    intent: 'buyer_intent',
    bucket: 'market_signal',
    confidence: 0.9,
    score: 0.8,
  };
  const noQueue = { loadQueue: () => [] };

  it('returns false when autoApprove block is missing', () => {
    const gate = buildAutoApproveGate({}, 'ws', { thisRunAutoApplied: 0 }, noQueue);
    expect(gate('x_contact_create', happyPayload)).toBe(false);
  });

  it('returns false when explicitly disabled', () => {
    const gate = buildAutoApproveGate(
      { autoApprove: { ...baseRubric.autoApprove, enabled: false } },
      'ws', { thisRunAutoApplied: 0 }, noQueue,
    );
    expect(gate('x_contact_create', happyPayload)).toBe(false);
  });

  it('passes the happy path', () => {
    const gate = buildAutoApproveGate(baseRubric, 'ws', { thisRunAutoApplied: 0 }, noQueue);
    expect(gate('x_contact_create', happyPayload)).toBe(true);
  });

  it('rejects each criterion individually', () => {
    const gate = buildAutoApproveGate(baseRubric, 'ws', { thisRunAutoApplied: 0 }, noQueue);
    expect(gate('x_contact_create', null)).toBe(false);
    expect(gate('x_contact_create', { ...happyPayload, intent: 'builder_curiosity' })).toBe(false);
    expect(gate('x_contact_create', { ...happyPayload, bucket: 'advancements' })).toBe(false);
    expect(gate('x_contact_create', { ...happyPayload, confidence: 0.84 })).toBe(false);
    expect(gate('x_contact_create', { ...happyPayload, score: 0.69 })).toBe(false);
  });

  it('enforces daily cap counting both per-run + queue snapshot', () => {
    const today = new Date().toISOString().slice(0, 10);
    const queue = [
      { kind: 'x_contact_create', status: 'auto_applied', ts: `${today}T08:00:00Z` },
      { kind: 'x_contact_create', status: 'auto_applied', ts: `${today}T09:00:00Z` },
      { kind: 'x_contact_create', status: 'pending',      ts: `${today}T10:00:00Z` }, // not counted
      { kind: 'x_contact_create', status: 'auto_applied', ts: '2025-01-01T00:00:00Z' }, // wrong day
      { kind: 'x_outbound_post',  status: 'auto_applied', ts: `${today}T11:00:00Z` }, // wrong kind
    ];
    const runState = { thisRunAutoApplied: 0 };
    const gate = buildAutoApproveGate(baseRubric, 'ws', runState, { loadQueue: () => queue });

    // 2 already today + 0 this run < 5: pass.
    expect(gate('x_contact_create', happyPayload)).toBe(true);
    // Caller increments after auto_applied lands.
    runState.thisRunAutoApplied = 3; // total = 5, at cap.
    expect(gate('x_contact_create', happyPayload)).toBe(false);
  });

  it('survives a queue loader that throws', () => {
    const gate = buildAutoApproveGate(baseRubric, 'ws', { thisRunAutoApplied: 0 }, {
      loadQueue: () => { throw new Error('disk fail'); },
    });
    // Should still gate normally on payload, treating todayCount as 0.
    expect(gate('x_contact_create', happyPayload)).toBe(true);
  });

  it('falls back to defaults when individual fields are missing', () => {
    const gate = buildAutoApproveGate(
      { autoApprove: { enabled: true } },
      'ws', { thisRunAutoApplied: 0 }, noQueue,
    );
    // Defaults: minConfidence=0.85, minScore=0.7, buckets=['market_signal'],
    // intents=['buyer_intent'], dailyCap=5.
    expect(gate('x_contact_create', happyPayload)).toBe(true);
    expect(gate('x_contact_create', { ...happyPayload, confidence: 0.5 })).toBe(false);
  });
});

describe('loadProposedHandles', () => {
  it('returns empty set when loadQueue is not provided', () => {
    expect(loadProposedHandles('ws')).toEqual(new Set());
  });

  it('returns empty set when loader throws', () => {
    const out = loadProposedHandles('ws', {
      loadQueue: () => { throw new Error('boom'); },
    });
    expect(out).toEqual(new Set());
  });

  it('includes handles from non-rejected x_contact_create entries', () => {
    const queue = [
      { kind: 'x_contact_create', status: 'pending',      payload: { handle: 'Alice' } },
      { kind: 'x_contact_create', status: 'approved',     payload: { handle: 'BOB' } },
      { kind: 'x_contact_create', status: 'applied',      payload: { handle: 'carol' } },
      { kind: 'x_contact_create', status: 'auto_applied', payload: { handle: 'Dave' } },
    ];
    const out = loadProposedHandles('ws', { loadQueue: () => queue });
    expect(out).toEqual(new Set(['alice', 'bob', 'carol', 'dave']));
  });

  it('excludes rejected entries so the caller can reconsider them', () => {
    const queue = [
      { kind: 'x_contact_create', status: 'rejected',     payload: { handle: 'eve' } },
      { kind: 'x_contact_create', status: 'pending',      payload: { handle: 'frank' } },
    ];
    const out = loadProposedHandles('ws', { loadQueue: () => queue });
    expect(out.has('eve')).toBe(false);
    expect(out.has('frank')).toBe(true);
  });

  it('ignores entries of other kinds', () => {
    const queue = [
      { kind: 'x_outbound_post', status: 'pending',  payload: { handle: 'grace' } },
      { kind: 'reply',           status: 'approved', payload: { handle: 'heidi' } },
    ];
    const out = loadProposedHandles('ws', { loadQueue: () => queue });
    expect(out.size).toBe(0);
  });

  it('skips entries with missing or non-string handle', () => {
    const queue = [
      { kind: 'x_contact_create', status: 'pending', payload: {} },
      { kind: 'x_contact_create', status: 'pending', payload: { handle: 42 } },
      { kind: 'x_contact_create', status: 'pending', payload: { handle: '' } },
      { kind: 'x_contact_create', status: 'pending', payload: { handle: 'real' } },
    ];
    const out = loadProposedHandles('ws', { loadQueue: () => queue });
    expect(out).toEqual(new Set(['real']));
  });
});

describe('loadLeadGenConfig fallback', () => {
  it('falls back to the committed example when private config is missing', () => {
    const fakeFs = {
      existsSync: () => false,
      readFileSync: (p) => readFileSync(p, 'utf8'),
    };
    const fakeOs = { homedir: () => '/tmp/does-not-exist' };
    const fakePath = { join: (...a) => a.join('/'), resolve: (p) => p };
    const warnings = [];
    const cfg = loadLeadGenConfig('any-ws', {
      fs: fakeFs, os: fakeOs, path: fakePath,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(cfg).toBeTruthy();
    expect(cfg.freeGates).toBeTruthy();
    expect(warnings.length).toBe(1);
  });
});
