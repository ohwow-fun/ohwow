import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  writeFinding,
  readRecentFindings,
  listFindings,
} from '../findings-store.js';
import type { NewFindingRow } from '../experiment-types.js';

/**
 * In-memory DB stub matching the surface findings-store uses:
 *   from(table).insert(row) → persists
 *   from(table).select(cols).eq().order().limit() → filtered read
 */
function buildDb(initial: Array<Record<string, unknown>> = []) {
  // Table-aware storage. writeFinding now inserts into both
  // self_findings (the ledger) and self_observation_baselines (novelty
  // stats added in Piece 1). env.rows remains the self_findings slice
  // so existing assertions keep working.
  const tables = new Map<string, Array<Record<string, unknown>>>();
  const findingsBucket = [...initial];
  tables.set('self_findings', findingsBucket);

  function makeBuilder(tableName: string) {
    if (!tables.has(tableName)) tables.set(tableName, []);
    const tableRows = tables.get(tableName)!;
    const filters: Array<{ col: string; val: unknown }> = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    let updateFields: Record<string, unknown> | null = null;

    const apply = () => {
      let out = tableRows.filter((r) =>
        filters.every((f) => r[f.col] === f.val),
      );
      if (orderCol) {
        const key = orderCol;
        out = [...out].sort((a, b) => {
          const av = String(a[key] ?? '');
          const bv = String(b[key] ?? '');
          return orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    };

    const builder: Record<string, unknown> = {};
    builder.select = (_cols?: string) => builder;
    builder.eq = (col: string, val: unknown) => {
      if (updateFields) {
        const matches = tableRows.filter((r) => r[col] === val);
        for (const m of matches) Object.assign(m, updateFields);
        return Promise.resolve({ data: null, error: null });
      }
      filters.push({ col, val });
      return builder;
    };
    builder.order = (col: string, opts?: { ascending?: boolean }) => {
      orderCol = col;
      orderAsc = opts?.ascending !== false;
      return builder;
    };
    builder.limit = (n: number) => {
      limitN = n;
      return Promise.resolve({ data: apply(), error: null });
    };
    builder.insert = (row: Record<string, unknown>) => {
      tableRows.push({ ...row });
      return Promise.resolve({ data: null, error: null });
    };
    builder.update = (fields: Record<string, unknown>) => {
      updateFields = fields;
      return builder;
    };
    builder.then = (resolve: (v: unknown) => void) =>
      resolve({ data: apply(), error: null });
    return builder;
  }

  return {
    db: { from: vi.fn().mockImplementation((table: string) => makeBuilder(table)) },
    rows: findingsBucket,
    tables,
  };
}

const baseRow: NewFindingRow = {
  experimentId: 'model-health',
  category: 'model_health',
  subject: 'qwen/qwen3.5-9b',
  hypothesis: 'This model reliably emits OpenAI-format tool_calls on work-shaped tasks.',
  verdict: 'fail',
  summary: '0% tool-call rate over 12 samples',
  evidence: { samples: 12, toolCallRate: 0 },
  interventionApplied: { description: 'demoted FAST→BALANCED', details: { demoted: ['qwen/qwen3.5-9b'] } },
  ranAt: '2026-04-14T12:00:00.000Z',
  durationMs: 42,
};

describe('writeFinding', () => {
  let env: ReturnType<typeof buildDb>;

  beforeEach(() => {
    env = buildDb();
  });

  it('persists a row with a generated UUID', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = await writeFinding(env.db as any, baseRow);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(env.rows).toHaveLength(1);
    expect(env.rows[0].id).toBe(id);
    expect(env.rows[0].experiment_id).toBe('model-health');
    expect(env.rows[0].verdict).toBe('fail');
    expect(env.rows[0].status).toBe('active');
  });

  it('serializes evidence as JSON text', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await writeFinding(env.db as any, baseRow);
    expect(typeof env.rows[0].evidence).toBe('string');
    const parsed = JSON.parse(env.rows[0].evidence as string) as Record<string, unknown>;
    // User-supplied evidence fields must round-trip verbatim. Piece 1
    // also injects a __novelty stanza; we assert that separately.
    expect(parsed.samples).toBe(12);
    expect(parsed.toolCallRate).toBe(0);
    expect(parsed.__novelty).toMatchObject({ reason: 'first_seen', score: 1 });
  });

  it('stores null intervention_applied when no intervention', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await writeFinding(env.db as any, { ...baseRow, interventionApplied: null });
    expect(env.rows[0].intervention_applied).toBeNull();
  });

  it('serializes intervention details as JSON text', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await writeFinding(env.db as any, baseRow);
    const raw = env.rows[0].intervention_applied as string;
    expect(JSON.parse(raw)).toEqual({
      description: 'demoted FAST→BALANCED',
      details: { demoted: ['qwen/qwen3.5-9b'] },
    });
  });
});

describe('readRecentFindings', () => {
  it('returns findings newest-first, scoped to experiment id', async () => {
    const env = buildDb([
      { id: '1', experiment_id: 'model-health', category: 'model_health', subject: null, hypothesis: null, verdict: 'pass', summary: 'all good', evidence: '{}', intervention_applied: null, ran_at: '2026-04-14T10:00:00Z', duration_ms: 5, status: 'active', superseded_by: null, created_at: '2026-04-14T10:00:00Z' },
      { id: '2', experiment_id: 'model-health', category: 'model_health', subject: null, hypothesis: null, verdict: 'fail', summary: 'qwen-9b dead', evidence: '{"n":12}', intervention_applied: null, ran_at: '2026-04-14T12:00:00Z', duration_ms: 7, status: 'active', superseded_by: null, created_at: '2026-04-14T12:00:00Z' },
      { id: '3', experiment_id: 'trigger-stability', category: 'trigger_stability', subject: null, hypothesis: null, verdict: 'pass', summary: 'all triggers healthy', evidence: '{}', intervention_applied: null, ran_at: '2026-04-14T11:00:00Z', duration_ms: 3, status: 'active', superseded_by: null, created_at: '2026-04-14T11:00:00Z' },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readRecentFindings(env.db as any, 'model-health', 10);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('2'); // newest first
    expect(result[0].verdict).toBe('fail');
    expect(result[0].evidence).toEqual({ n: 12 });
    expect(result[1].id).toBe('1');
  });

  it('returns empty array when no findings exist for the experiment', async () => {
    const env = buildDb([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readRecentFindings(env.db as any, 'anything', 10);
    expect(result).toEqual([]);
  });

  it('parses corrupt evidence gracefully', async () => {
    const env = buildDb([
      { id: '1', experiment_id: 'model-health', category: 'model_health', subject: null, hypothesis: null, verdict: 'pass', summary: 'x', evidence: 'not json{{', intervention_applied: null, ran_at: '2026-04-14T10:00:00Z', duration_ms: 0, status: 'active', superseded_by: null, created_at: '2026-04-14T10:00:00Z' },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readRecentFindings(env.db as any, 'model-health', 10);
    expect(result[0].evidence).toEqual({}); // falls back to {}
  });
});

describe('listFindings', () => {
  it('defaults to active status and newest-first order', async () => {
    const env = buildDb([
      { id: '1', experiment_id: 'a', category: 'model_health', subject: null, hypothesis: null, verdict: 'pass', summary: 'x', evidence: '{}', intervention_applied: null, ran_at: '2026-04-14T09:00:00Z', duration_ms: 0, status: 'active', superseded_by: null, created_at: '2026-04-14T09:00:00Z' },
      { id: '2', experiment_id: 'a', category: 'model_health', subject: null, hypothesis: null, verdict: 'fail', summary: 'y', evidence: '{}', intervention_applied: null, ran_at: '2026-04-14T12:00:00Z', duration_ms: 0, status: 'superseded', superseded_by: null, created_at: '2026-04-14T12:00:00Z' },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await listFindings(env.db as any, {});
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1'); // superseded row excluded by default
  });

  it('filters by category', async () => {
    const env = buildDb([
      { id: '1', experiment_id: 'a', category: 'model_health', subject: null, hypothesis: null, verdict: 'pass', summary: 'x', evidence: '{}', intervention_applied: null, ran_at: '2026-04-14T10:00:00Z', duration_ms: 0, status: 'active', superseded_by: null, created_at: '2026-04-14T10:00:00Z' },
      { id: '2', experiment_id: 'b', category: 'trigger_stability', subject: null, hypothesis: null, verdict: 'pass', summary: 'y', evidence: '{}', intervention_applied: null, ran_at: '2026-04-14T11:00:00Z', duration_ms: 0, status: 'active', superseded_by: null, created_at: '2026-04-14T11:00:00Z' },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await listFindings(env.db as any, { category: 'trigger_stability' });
    expect(result).toHaveLength(1);
    expect(result[0].experimentId).toBe('b');
  });

  it('filters by verdict and experimentId simultaneously', async () => {
    const env = buildDb([
      { id: '1', experiment_id: 'a', category: 'model_health', subject: null, hypothesis: null, verdict: 'pass', summary: 'ok', evidence: '{}', intervention_applied: null, ran_at: '2026-04-14T10:00:00Z', duration_ms: 0, status: 'active', superseded_by: null, created_at: '2026-04-14T10:00:00Z' },
      { id: '2', experiment_id: 'a', category: 'model_health', subject: null, hypothesis: null, verdict: 'fail', summary: 'bad', evidence: '{}', intervention_applied: null, ran_at: '2026-04-14T11:00:00Z', duration_ms: 0, status: 'active', superseded_by: null, created_at: '2026-04-14T11:00:00Z' },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await listFindings(env.db as any, { experimentId: 'a', verdict: 'fail' });
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe('bad');
  });

  it('caps limit at 500 to avoid pulling the whole table', async () => {
    const env = buildDb(
      Array.from({ length: 50 }, (_, i) => ({
        id: `r${i}`, experiment_id: 'a', category: 'model_health', subject: null, hypothesis: null,
        verdict: 'pass', summary: `s${i}`, evidence: '{}', intervention_applied: null,
        ran_at: `2026-04-14T10:${String(i).padStart(2, '0')}:00Z`, duration_ms: 0, status: 'active',
        superseded_by: null, created_at: '2026-04-14T10:00:00Z',
      })),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await listFindings(env.db as any, { limit: 9999 });
    expect(result.length).toBeLessThanOrEqual(500);
    expect(result.length).toBe(50); // capped at actual row count
  });
});
