import { describe, it, expect, vi } from 'vitest';
import { readRecentFindings, listFindings } from '../findings-store.js';

/**
 * Regression test for the "evidence comes back as {}" bug found
 * when querying the live ledger. Some DB adapters return TEXT JSON
 * columns already parsed as objects; parseJsonSafe must accept both
 * string and object shapes and not silently land {} when the
 * adapter was helpful.
 */

function buildDb(rows: Array<Record<string, unknown>>) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  };
  return { from: vi.fn().mockReturnValue(chain) };
}

const baseRow = {
  id: 'f1',
  experiment_id: 'model-health',
  category: 'model_health',
  subject: 'qwen/qwen3.5-9b',
  hypothesis: 'h',
  verdict: 'fail',
  summary: 's',
  intervention_applied: null,
  ran_at: '2026-04-14T12:00:00Z',
  duration_ms: 0,
  status: 'active',
  superseded_by: null,
  created_at: '2026-04-14T12:00:00Z',
};

describe('findings-store evidence parsing — adapter shape tolerance', () => {
  it('parses stringified JSON evidence (typical text-column adapter)', async () => {
    const db = buildDb([
      { ...baseRow, evidence: JSON.stringify({ samples: 12, rate: 0 }) },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findings = await readRecentFindings(db as any, 'model-health');
    expect(findings[0].evidence).toEqual({ samples: 12, rate: 0 });
  });

  it('accepts already-parsed object evidence (helpful adapter)', async () => {
    const db = buildDb([
      { ...baseRow, evidence: { samples: 12, rate: 0 } },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findings = await readRecentFindings(db as any, 'model-health');
    expect(findings[0].evidence).toEqual({ samples: 12, rate: 0 });
  });

  it('parses stringified intervention_applied', async () => {
    const db = buildDb([
      {
        ...baseRow,
        evidence: '{}',
        intervention_applied: JSON.stringify({ description: 'demoted', details: { which: 'foo' } }),
      },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findings = await readRecentFindings(db as any, 'model-health');
    expect(findings[0].interventionApplied).toEqual({ description: 'demoted', details: { which: 'foo' } });
  });

  it('accepts already-parsed object intervention_applied', async () => {
    const db = buildDb([
      {
        ...baseRow,
        evidence: '{}',
        intervention_applied: { description: 'demoted', details: { which: 'foo' } },
      },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findings = await readRecentFindings(db as any, 'model-health');
    expect(findings[0].interventionApplied).toEqual({ description: 'demoted', details: { which: 'foo' } });
  });

  it('still falls back to {} on truly corrupt evidence', async () => {
    const db = buildDb([
      { ...baseRow, evidence: '{ not json' },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findings = await readRecentFindings(db as any, 'model-health');
    expect(findings[0].evidence).toEqual({});
  });

  it('listFindings parses evidence objects too', async () => {
    const db = buildDb([
      { ...baseRow, evidence: { count: 7 } },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findings = await listFindings(db as any);
    expect(findings[0].evidence).toEqual({ count: 7 });
  });
});
