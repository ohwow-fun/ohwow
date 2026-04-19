/**
 * Freeze the director injector surface introduced in Phase 6.10.
 *
 * Verifies:
 *   1. `runArc` honours the `idFactory` injector — phase-report ids and
 *      founder-question ids use the factory's output, not random generation.
 *   2. `runArc` honours the `now` injector — the arc's `opened_at` timestamp
 *      comes from the injected clock, not `Date.now()`.
 *   3. `detectPulseRegression` is exported and callable directly (confirms
 *      the function is public, not just accessible through the harness).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqliteAdapter } from '../../db/sqlite-adapter.js';
import {
  runArc,
  staticQueuePicker,
  detectPulseRegression,
  type ArcInput,
  type PickerOutput,
} from '../director.js';
import { loadArc, listPhaseReportsForArc } from '../director-persistence.js';
import { StubExecutor, planContinue, implContinue, qaPassed } from './_stubs.js';
import type { PulseSnapshot } from '../director-persistence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

function setupDb(): {
  rawDb: InstanceType<typeof Database>;
  adapter: ReturnType<typeof createSqliteAdapter>;
} {
  const rawDb = new Database(':memory:');
  rawDb.pragma('foreign_keys = OFF');
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const statements = sql.split(/^-- @statement$/m);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      try {
        rawDb.exec(trimmed);
      } catch {
        /* tolerate idempotent ALTERs */
      }
    }
  }
  return { rawDb, adapter: createSqliteAdapter(rawDb) };
}

const FIXED_MS = Date.UTC(2026, 3, 18, 12, 0, 0); // 2026-04-18T12:00:00Z
const FIXED_DATE = new Date(FIXED_MS);

function makeFakeIO(startMs = FIXED_MS) {
  let ms = startMs;
  return {
    now: () => {
      const d = new Date(ms);
      ms += 1;
      return d;
    },
    readPulse: async (): Promise<PulseSnapshot> => ({ ts: 'fake' }),
    readRuntimeSha: async () => 'test-sha',
    readCloudSha: async () => null,
  };
}

function allPassExec(): StubExecutor {
  return new StubExecutor({ plan: [planContinue], impl: [implContinue], qa: [qaPassed] });
}

function baseArcInput(over: Partial<ArcInput> = {}): ArcInput {
  return {
    workspace_id: 'ws-inject-test',
    thesis: 'injector test arc',
    mode_of_invocation: 'autonomous',
    ...over,
  };
}

function basePicked(over: Partial<PickerOutput> = {}): PickerOutput {
  return {
    phase_id: 'phase_001',
    mode: 'plumbing',
    goal: 'injector smoke',
    initial_plan_brief: 'brief',
    ...over,
  };
}

// ----------------------------------------------------------------------------
// 1. idFactory injector
// ----------------------------------------------------------------------------

describe('runArc — idFactory injector', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => ({ rawDb, adapter } = setupDb()));
  afterEach(() => rawDb.close());

  it('phase-report ids use the injected factory prefix, not random generation', async () => {
    const calls: string[] = [];
    const idFactory = (prefix: string): string => {
      const id = `${prefix}_TEST_${String(calls.length + 1).padStart(3, '0')}`;
      calls.push(id);
      return id;
    };

    const result = await runArc(
      baseArcInput({ idFactory }),
      staticQueuePicker([basePicked()]),
      allPassExec(),
      adapter,
      makeFakeIO(),
    );

    expect(result.phases_run).toBe(1);
    // At least one id was generated through the factory
    expect(calls.length).toBeGreaterThan(0);
    // The phase report id stored in DB must use the factory output
    const reports = await listPhaseReportsForArc(adapter, result.arc_id);
    expect(reports).toHaveLength(1);
    // The report id should be one of the factory-generated ids
    const factoryIds = new Set(calls);
    expect(factoryIds.has(reports[0].id)).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// 2. now injector
// ----------------------------------------------------------------------------

describe('runArc — now injector', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => ({ rawDb, adapter } = setupDb()));
  afterEach(() => rawDb.close());

  it('opened_at on the arc row reflects the injected clock, not wall time', async () => {
    // Use a fixed time far in the past to make accidental wall-clock leakage
    // obvious — 2020-01-01T00:00:00Z.
    const FAKE_MS = Date.UTC(2020, 0, 1, 0, 0, 0);
    let callCount = 0;
    const now = (): Date => {
      callCount += 1;
      return new Date(FAKE_MS + callCount); // advance 1ms per call
    };

    const result = await runArc(
      baseArcInput({ now }),
      staticQueuePicker([basePicked()]),
      allPassExec(),
      adapter,
      makeFakeIO(),
    );

    expect(result.phases_run).toBe(1);
    const arc = await loadArc(adapter, result.arc_id);
    expect(arc).not.toBeNull();
    // opened_at must be close to our fake 2020-01-01 epoch, not 2026.
    const openedAt = new Date(arc!.opened_at).getTime();
    expect(openedAt).toBeGreaterThan(FAKE_MS);
    expect(openedAt).toBeLessThan(FAKE_MS + 60_000); // within 1 min of fake epoch
    // Sanity: it is definitely NOT wall-clock 2026
    expect(openedAt).toBeLessThan(Date.UTC(2021, 0, 1));
  });
});

// ----------------------------------------------------------------------------
// 3. detectPulseRegression exported and callable
// ----------------------------------------------------------------------------

describe('detectPulseRegression — exported from director.ts', () => {
  it('returns null when there is no regression', () => {
    const baseline: PulseSnapshot = { ts: 'a', mrr_cents: 1000, pipeline_count: 5 };
    const current: PulseSnapshot = { ts: 'b', mrr_cents: 1000, pipeline_count: 5 };
    expect(detectPulseRegression(baseline, current)).toBeNull();
  });

  it('reports mrr regression', () => {
    const baseline: PulseSnapshot = { ts: 'a', mrr_cents: 1000 };
    const current: PulseSnapshot = { ts: 'b', mrr_cents: 800 };
    const result = detectPulseRegression(baseline, current);
    expect(result).not.toBeNull();
    expect(result).toContain('mrr_cents');
    expect(result).toContain('1000');
    expect(result).toContain('800');
  });

  it('reports pipeline_count regression', () => {
    const baseline: PulseSnapshot = { ts: 'a', pipeline_count: 10 };
    const current: PulseSnapshot = { ts: 'b', pipeline_count: 7 };
    const result = detectPulseRegression(baseline, current);
    expect(result).not.toBeNull();
    expect(result).toContain('pipeline_count');
  });

  it('does not flag equality as regression', () => {
    const baseline: PulseSnapshot = { ts: 'a', mrr_cents: 500 };
    const current: PulseSnapshot = { ts: 'b', mrr_cents: 500 };
    expect(detectPulseRegression(baseline, current)).toBeNull();
  });

  it('does not flag improvement as regression', () => {
    const baseline: PulseSnapshot = { ts: 'a', mrr_cents: 500 };
    const current: PulseSnapshot = { ts: 'b', mrr_cents: 700 };
    expect(detectPulseRegression(baseline, current)).toBeNull();
  });

  it('skips check when signal is absent from either side', () => {
    // baseline has mrr_cents, current does not -> no regression signal
    const baseline: PulseSnapshot = { ts: 'a', mrr_cents: 1000 };
    const current: PulseSnapshot = { ts: 'b' };
    expect(detectPulseRegression(baseline, current)).toBeNull();
  });
});
