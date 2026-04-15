/**
 * Unit tests for the pure helpers in _qualify.mjs and _author-ledger.mjs.
 * No LLM, no disk — ledger tests use a tmpdir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freeGates, acceptsIntent, classifyIntent, loadLeadGenConfig } from '../_qualify.mjs';
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
