/**
 * XDmSignalsRollupExperiment — integration tests against a real
 * SQLite DB with migrations applied. The rollup does real writeFinding
 * calls, so a real findings-store stack (novelty scoring, baselines,
 * supersedeDuplicates) is more honest than a table-shaped mock.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

import { initDatabase } from '../../db/init.js';
import { createSqliteAdapter } from '../../db/sqlite-adapter.js';
import type { ExperimentContext, Finding } from '../experiment-types.js';
import {
  rollupByPhrase,
  XDmSignalsRollupExperiment,
} from '../experiments/x-dm-signals-rollup.js';

const WORKSPACE_ID = 'ws-dm-rollup-test';
const WORKSPACE_SLUG = 'default';

interface Env {
  dir: string;
  rawDb: Database.Database;
  db: ReturnType<typeof createSqliteAdapter>;
}

function setupEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'ohwow-dm-rollup-'));
  const rawDb = initDatabase(join(dir, 'runtime.db'));
  const db = createSqliteAdapter(rawDb);
  return { dir, rawDb, db };
}

function teardownEnv(env: Env): void {
  env.rawDb.close();
  rmSync(env.dir, { recursive: true, force: true });
}

function seedSignal(
  env: Env,
  args: {
    messageId: string;
    pair: string;
    phrase: string | null;
    text: string;
    contactId?: string | null;
    observedAt?: string;
    signalType?: 'trigger_phrase' | 'unknown_correspondent';
  },
): void {
  env.rawDb.prepare(
    `INSERT INTO x_dm_signals
      (workspace_id, conversation_pair, message_id, signal_type, trigger_phrase, primary_name, text, contact_id, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    WORKSPACE_ID,
    args.pair,
    args.messageId,
    args.signalType ?? 'trigger_phrase',
    args.phrase,
    'Alice',
    args.text,
    args.contactId ?? null,
    args.observedAt ?? new Date().toISOString(),
  );
}

function makeCtx(env: Env): ExperimentContext {
  return {
    db: env.db,
    workspaceId: WORKSPACE_ID,
    workspaceSlug: WORKSPACE_SLUG,
    engine: {} as never,
    recentFindings: async () => [] as Finding[],
  };
}

async function runProbe(
  env: Env,
  exp: XDmSignalsRollupExperiment,
): Promise<{ subject: string | null; evidence: Record<string, unknown> }> {
  const result = await exp.probe(makeCtx(env));
  return {
    subject: result.subject ?? null,
    evidence: result.evidence as Record<string, unknown>,
  };
}

function listFindings(env: Env): Array<{ subject: string; verdict: string; summary: string; evidence: string }> {
  return env.rawDb.prepare(
    `SELECT subject, verdict, summary, evidence FROM self_findings
     WHERE experiment_id='x-dm-signals-rollup' AND status='active'
     ORDER BY subject`,
  ).all() as Array<{ subject: string; verdict: string; summary: string; evidence: string }>;
}

describe('XDmSignalsRollupExperiment', () => {
  let env: Env;

  beforeEach(() => { env = setupEnv(); });
  afterEach(() => { teardownEnv(env); });

  it('writes a pass finding per phrase when count < warning threshold', async () => {
    seedSignal(env, { messageId: 'm1', pair: '1:2', phrase: 'pricing', text: 'what pricing?' });
    seedSignal(env, { messageId: 'm2', pair: '3:4', phrase: 'pricing', text: 'how much?' });

    const exp = new XDmSignalsRollupExperiment();
    await runProbe(env, exp);

    const findings = listFindings(env);
    const phraseFindings = findings.filter((f) => f.subject?.startsWith('phrase:'));
    expect(phraseFindings).toHaveLength(1);
    expect(phraseFindings[0].subject).toBe('phrase:pricing');
    expect(phraseFindings[0].verdict).toBe('pass');
  });

  it('escalates to warning when a phrase has >=3 signals in the window', async () => {
    for (let i = 0; i < 4; i++) {
      seedSignal(env, { messageId: `m${i}`, pair: `${i}:0`, phrase: 'refund', text: 'i want a refund' });
    }
    const exp = new XDmSignalsRollupExperiment();
    await runProbe(env, exp);

    const refund = listFindings(env).find((f) => f.subject === 'phrase:refund');
    expect(refund?.verdict).toBe('warning');
    const ev = JSON.parse(refund?.evidence ?? '{}');
    expect(ev.count).toBe(4);
    expect(ev.unique_pairs).toBe(4);
    expect(ev.phrase).toBe('refund');
  });

  it('includes linked-contact counts in the per-phrase evidence', async () => {
    seedSignal(env, { messageId: 'm1', pair: '1:2', phrase: 'pricing', text: 'q', contactId: 'contact-alice' });
    seedSignal(env, { messageId: 'm2', pair: '3:4', phrase: 'pricing', text: 'q', contactId: null });

    const exp = new XDmSignalsRollupExperiment();
    await runProbe(env, exp);
    const f = listFindings(env).find((f) => f.subject === 'phrase:pricing');
    const ev = JSON.parse(f?.evidence ?? '{}');
    expect(ev.contacts_linked).toBe(1);
  });

  it('skips signals outside the window', async () => {
    const inWindow = new Date().toISOString();
    const outOfWindow = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(); // 12h ago
    seedSignal(env, { messageId: 'old', pair: '1:2', phrase: 'pricing', text: '', observedAt: outOfWindow });
    seedSignal(env, { messageId: 'new', pair: '3:4', phrase: 'pricing', text: '', observedAt: inWindow });

    const exp = new XDmSignalsRollupExperiment();
    await runProbe(env, exp);
    const f = listFindings(env).find((f) => f.subject === 'phrase:pricing');
    const ev = JSON.parse(f?.evidence ?? '{}');
    expect(ev.count).toBe(1);
  });

  it('ignores unknown_correspondent signals (different axis)', async () => {
    seedSignal(env, { messageId: 'u1', pair: '1:2', phrase: null, text: '', signalType: 'unknown_correspondent' });
    seedSignal(env, { messageId: 't1', pair: '1:2', phrase: 'pricing', text: 'q' });

    const exp = new XDmSignalsRollupExperiment();
    await runProbe(env, exp);
    const findings = listFindings(env);
    const phraseSubjects = findings.map((f) => f.subject).filter((s) => s.startsWith('phrase:'));
    expect(phraseSubjects).toEqual(['phrase:pricing']);
  });

  it('emits no per-phrase findings when the window is empty', async () => {
    const exp = new XDmSignalsRollupExperiment();
    await runProbe(env, exp);

    const findings = listFindings(env);
    const phraseFindings = findings.filter((f) => f.subject?.startsWith('phrase:'));
    expect(phraseFindings).toHaveLength(0);
    // Summary finding still gets written through the normal runner
    // path — but the runner writes it, not the probe. Here we just
    // verify the probe returned a ProbeResult whose evidence
    // reflects the empty state.
    const summary = listFindings(env).find((f) => f.subject === 'rollup');
    // The summary is written by the runner, not by probe itself, so
    // it should be absent here (we called probe directly).
    expect(summary).toBeUndefined();
  });

  it('returns a summary ProbeResult with phrase_count + signals_total', async () => {
    seedSignal(env, { messageId: 'm1', pair: '1:2', phrase: 'pricing', text: 'q' });
    seedSignal(env, { messageId: 'm2', pair: '1:2', phrase: 'refund', text: 'r' });
    seedSignal(env, { messageId: 'm3', pair: '1:2', phrase: 'refund', text: 'r2' });
    seedSignal(env, { messageId: 'm4', pair: '1:2', phrase: 'refund', text: 'r3' });

    const exp = new XDmSignalsRollupExperiment();
    const { subject, evidence } = await runProbe(env, exp);
    expect(subject).toBe('rollup');
    expect(evidence.signals_total).toBe(4);
    expect(evidence.phrase_count).toBe(2);
    expect(evidence.warning_groups).toBe(1); // refund count=3 → warning
  });

  it('respects the workspace guard — skips when slug mismatches', async () => {
    seedSignal(env, { messageId: 'm1', pair: '1:2', phrase: 'pricing', text: 'q' });
    const exp = new XDmSignalsRollupExperiment();
    const result = await exp.probe({
      ...makeCtx(env),
      workspaceSlug: 'some-other-workspace',
    });
    expect(result.subject).toBeNull();
    const ev = result.evidence as { skipped?: boolean };
    expect(ev.skipped).toBe(true);

    const phraseFindings = listFindings(env).filter((f) => f.subject?.startsWith('phrase:'));
    expect(phraseFindings).toHaveLength(0);
  });

  it('judge returns pass (summary carries no per-phrase verdict)', async () => {
    const exp = new XDmSignalsRollupExperiment();
    const verdict = exp.judge(
      { subject: 'rollup', summary: '', evidence: {} },
      [] as Finding[],
    );
    expect(verdict).toBe('pass');
  });
});

describe('rollupByPhrase', () => {
  it('counts and groups rows into phrase buckets', () => {
    const groups = rollupByPhrase([
      { trigger_phrase: 'pricing', conversation_pair: '1:2', message_id: 'a', primary_name: null, text: 't1', contact_id: null, observed_at: '2026-04-16T10:00:00Z' },
      { trigger_phrase: 'pricing', conversation_pair: '3:4', message_id: 'b', primary_name: null, text: 't2', contact_id: 'c1', observed_at: '2026-04-16T11:00:00Z' },
      { trigger_phrase: 'refund', conversation_pair: '1:2', message_id: 'c', primary_name: null, text: 't3', contact_id: null, observed_at: '2026-04-16T10:30:00Z' },
    ]);
    const byPhrase = Object.fromEntries(groups.map((g) => [g.phrase, g]));
    expect(byPhrase.pricing.count).toBe(2);
    expect(byPhrase.pricing.uniquePairs).toBe(2);
    expect(byPhrase.pricing.contactsLinked).toBe(1);
    expect(byPhrase.pricing.firstAt).toBe('2026-04-16T10:00:00Z');
    expect(byPhrase.pricing.lastAt).toBe('2026-04-16T11:00:00Z');
    expect(byPhrase.refund.count).toBe(1);
  });

  it('sorts groups by count descending', () => {
    const groups = rollupByPhrase([
      { trigger_phrase: 'a', conversation_pair: '1:2', message_id: '1', primary_name: null, text: null, contact_id: null, observed_at: '2026-04-16T10:00:00Z' },
      { trigger_phrase: 'b', conversation_pair: '1:2', message_id: '2', primary_name: null, text: null, contact_id: null, observed_at: '2026-04-16T10:00:00Z' },
      { trigger_phrase: 'b', conversation_pair: '1:2', message_id: '3', primary_name: null, text: null, contact_id: null, observed_at: '2026-04-16T10:00:00Z' },
    ]);
    expect(groups.map((g) => g.phrase)).toEqual(['b', 'a']);
  });

  it('caps sample_texts at 3 entries', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      trigger_phrase: 'pricing',
      conversation_pair: '1:2',
      message_id: `m${i}`,
      primary_name: null,
      text: `sample ${i}`,
      contact_id: null,
      observed_at: '2026-04-16T10:00:00Z',
    }));
    const groups = rollupByPhrase(rows);
    expect(groups[0].sampleTexts).toHaveLength(3);
  });

  it('skips rows with null/empty trigger_phrase', () => {
    const groups = rollupByPhrase([
      { trigger_phrase: null, conversation_pair: '1:2', message_id: '1', primary_name: null, text: null, contact_id: null, observed_at: '2026-04-16T10:00:00Z' },
      { trigger_phrase: '', conversation_pair: '1:2', message_id: '2', primary_name: null, text: null, contact_id: null, observed_at: '2026-04-16T10:00:00Z' },
      { trigger_phrase: 'pricing', conversation_pair: '1:2', message_id: '3', primary_name: null, text: null, contact_id: null, observed_at: '2026-04-16T10:00:00Z' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].phrase).toBe('pricing');
  });
});
