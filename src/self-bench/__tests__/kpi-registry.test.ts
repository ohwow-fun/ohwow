import { describe, it, expect, vi } from 'vitest';
import {
  KPI_REGISTRY,
  getKpi,
  listKpiIds,
  readAllKpis,
  readKpi,
  signedLift,
  type KpiReadContext,
} from '../kpi-registry.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

// -----------------------------------------------------------------------------
// Minimal chainable DB mock reused across tests. Supports select/eq/gte/limit
// and resolves the builder as a promise. Mirrors the pattern in
// revenue-pipeline-observer.test.ts.
// -----------------------------------------------------------------------------

interface Table {
  rows: Record<string, unknown>[];
}

function buildDb(tables: Record<string, Table>): DatabaseAdapter {
  function makeBuilder(name: string) {
    if (!tables[name]) tables[name] = { rows: [] };
    const t = tables[name];
    const eqFilters: Array<{ col: string; val: unknown }> = [];
    const gteFilters: Array<{ col: string; val: unknown }> = [];
    const apply = () =>
      t.rows.filter(
        (r) =>
          eqFilters.every((f) => r[f.col] === f.val) &&
          gteFilters.every((f) => String(r[f.col]) >= String(f.val)),
      );
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => {
      eqFilters.push({ col, val });
      return builder;
    };
    builder.gte = (col: string, val: unknown) => {
      gteFilters.push({ col, val });
      return builder;
    };
    builder.order = () => builder;
    builder.limit = () =>
      Promise.resolve({ data: apply(), error: null });
    builder.then = (resolve: (v: unknown) => void) =>
      resolve({ data: apply(), error: null });
    return builder;
  }
  return { from: vi.fn().mockImplementation((n: string) => makeBuilder(n)) } as unknown as DatabaseAdapter;
}

const NOW = Date.parse('2026-04-16T12:00:00.000Z');
const HOUR_AGO = new Date(NOW - 3600_000).toISOString();
const DAY_AGO_PLUS = new Date(NOW - 20 * 3600_000).toISOString(); // inside 24h window
const THREE_DAYS_AGO = new Date(NOW - 3 * 86_400_000).toISOString();
const TEN_DAYS_AGO = new Date(NOW - 10 * 86_400_000).toISOString();

function ctx(db: DatabaseAdapter, overrides: Partial<KpiReadContext> = {}): KpiReadContext {
  return { db, workspaceId: 'ws-1', asOfMs: NOW, ...overrides };
}

// -----------------------------------------------------------------------------

describe('KPI_REGISTRY', () => {
  it('exposes stable registry ids, no duplicates', () => {
    const ids = listKpiIds();
    expect(ids.length).toBe(KPI_REGISTRY.length);
    expect(new Set(ids).size).toBe(ids.length);
    // Core KPIs the Phase 5 lift-measurement code will depend on
    expect(ids).toContain('revenue_cents_24h');
    expect(ids).toContain('revenue_cents_7d');
    expect(ids).toContain('reply_ratio_24h');
    expect(ids).toContain('burn_cents_today');
    expect(ids).toContain('signal_spend_ratio_24h');
  });

  it('getKpi returns the matching definition or undefined', () => {
    expect(getKpi('revenue_cents_24h')?.unit).toBe('cents');
    expect(getKpi('reply_ratio_24h')?.higher_is_better).toBe(true);
    expect(getKpi('burn_cents_today')?.higher_is_better).toBe(false);
    expect(getKpi('nonexistent')).toBeUndefined();
  });
});

describe('readKpi — revenue windows', () => {
  const rows = [
    { workspace_id: 'ws-1', amount_cents: 500, created_at: HOUR_AGO, month: 4, year: 2026 },
    { workspace_id: 'ws-1', amount_cents: 1500, created_at: DAY_AGO_PLUS, month: 4, year: 2026 },
    { workspace_id: 'ws-1', amount_cents: 2000, created_at: THREE_DAYS_AGO, month: 4, year: 2026 },
    { workspace_id: 'ws-1', amount_cents: 999, created_at: TEN_DAYS_AGO, month: 3, year: 2026 },
    // another workspace — must be excluded
    { workspace_id: 'other', amount_cents: 99999, created_at: HOUR_AGO, month: 4, year: 2026 },
  ];
  const db = buildDb({ agent_workforce_revenue_entries: { rows } });

  it('revenue_cents_24h sums only rows within 24h for this workspace', async () => {
    const r = await readKpi('revenue_cents_24h', ctx(db));
    expect(r?.value).toBe(500 + 1500);
    expect(r?.unit).toBe('cents');
    expect(r?.higher_is_better).toBe(true);
  });

  it('revenue_cents_7d sums rows within 7d, excludes 10-day-old row', async () => {
    const r = await readKpi('revenue_cents_7d', ctx(db));
    expect(r?.value).toBe(500 + 1500 + 2000);
  });

  it('revenue_cents_mtd sums current-month rows only', async () => {
    const r = await readKpi('revenue_cents_mtd', ctx(db));
    // March 2026 row is excluded — current month is April
    expect(r?.value).toBe(500 + 1500 + 2000);
  });

  it('returns 0 when there are no rows (not null)', async () => {
    const empty = buildDb({ agent_workforce_revenue_entries: { rows: [] } });
    const r = await readKpi('revenue_cents_24h', ctx(empty));
    expect(r?.value).toBe(0);
  });
});

describe('readKpi — DMs and reply ratio', () => {
  const dms = [
    { workspace_id: 'ws-1', direction: 'outbound', observed_at: HOUR_AGO },
    { workspace_id: 'ws-1', direction: 'outbound', observed_at: DAY_AGO_PLUS },
    { workspace_id: 'ws-1', direction: 'inbound', observed_at: HOUR_AGO },
    { workspace_id: 'ws-1', direction: 'outbound', observed_at: TEN_DAYS_AGO },
  ];
  const db = buildDb({ x_dm_messages: { rows: dms } });

  it('outbound_dm_24h counts outbound in window', async () => {
    const r = await readKpi('outbound_dm_24h', ctx(db));
    expect(r?.value).toBe(2);
    expect(r?.in_range).toBe(true); // saneRange [1, 50]
  });

  it('inbound_dm_24h counts inbound in window', async () => {
    const r = await readKpi('inbound_dm_24h', ctx(db));
    expect(r?.value).toBe(1);
  });

  it('reply_ratio_24h returns inbound/outbound', async () => {
    const r = await readKpi('reply_ratio_24h', ctx(db));
    expect(r?.value).toBeCloseTo(0.5);
  });

  it('reply_ratio_24h returns null when outbound is zero', async () => {
    const onlyInbound = buildDb({
      x_dm_messages: {
        rows: [{ workspace_id: 'ws-1', direction: 'inbound', observed_at: HOUR_AGO }],
      },
    });
    const r = await readKpi('reply_ratio_24h', ctx(onlyInbound));
    expect(r?.value).toBeNull();
  });
});

describe('readKpi — contacts and events', () => {
  it('active_leads and active_customers count by status', async () => {
    const db = buildDb({
      agent_workforce_contacts: {
        rows: [
          { workspace_id: 'ws-1', status: 'active' },
          { workspace_id: 'ws-1', status: 'active' },
          { workspace_id: 'ws-1', status: 'customer' },
          { workspace_id: 'other', status: 'customer' }, // excluded
        ],
      },
    });
    expect((await readKpi('active_leads', ctx(db)))?.value).toBe(2);
    expect((await readKpi('active_customers', ctx(db)))?.value).toBe(1);
  });

  it('qualified_events_24h only counts event_types with x:qualified prefix', async () => {
    const db = buildDb({
      agent_workforce_contact_events: {
        rows: [
          { workspace_id: 'ws-1', event_type: 'x:qualified:follow', created_at: HOUR_AGO },
          { workspace_id: 'ws-1', event_type: 'x:qualified:reply', created_at: DAY_AGO_PLUS },
          { workspace_id: 'ws-1', event_type: 'x:dm:sent', created_at: HOUR_AGO },
          { workspace_id: 'ws-1', event_type: 'x:qualified:old', created_at: TEN_DAYS_AGO }, // outside window
        ],
      },
    });
    const r = await readKpi('qualified_events_24h', ctx(db));
    expect(r?.value).toBe(2);
  });
});

describe('readKpi — burn and unit economics', () => {
  it('burn_cents_today reads the latest burn-rate finding', async () => {
    const db = buildDb({
      self_findings: {
        rows: [
          {
            workspace_id: 'ws-1',
            experiment_id: 'burn-rate',
            status: 'active',
            ran_at: new Date(NOW).toISOString(),
            evidence: JSON.stringify({ total_cents_today: 3450 }),
            subject: 'meta:burn-rate',
          },
        ],
      },
    });
    const r = await readKpi('burn_cents_today', ctx(db));
    expect(r?.value).toBe(3450);
    expect(r?.higher_is_better).toBe(false);
  });

  it('signal_spend_ratio_24h combines revenue and burn', async () => {
    const db = buildDb({
      agent_workforce_revenue_entries: {
        rows: [
          { workspace_id: 'ws-1', amount_cents: 10000, created_at: HOUR_AGO, month: 4, year: 2026 },
        ],
      },
      self_findings: {
        rows: [
          {
            workspace_id: 'ws-1',
            experiment_id: 'burn-rate',
            status: 'active',
            ran_at: new Date(NOW).toISOString(),
            evidence: JSON.stringify({ total_cents_today: 2500 }),
            subject: 'meta:burn-rate',
          },
        ],
      },
    });
    const r = await readKpi('signal_spend_ratio_24h', ctx(db));
    expect(r?.value).toBeCloseTo(4);
  });

  it('signal_spend_ratio_24h returns null when burn is zero', async () => {
    const db = buildDb({
      agent_workforce_revenue_entries: {
        rows: [{ workspace_id: 'ws-1', amount_cents: 1, created_at: HOUR_AGO, month: 4, year: 2026 }],
      },
      self_findings: {
        rows: [
          {
            workspace_id: 'ws-1',
            experiment_id: 'burn-rate',
            status: 'active',
            ran_at: new Date(NOW).toISOString(),
            evidence: JSON.stringify({ total_cents_today: 0 }),
            subject: 'meta:burn-rate',
          },
        ],
      },
    });
    const r = await readKpi('signal_spend_ratio_24h', ctx(db));
    expect(r?.value).toBeNull();
  });
});

describe('readAllKpis', () => {
  it('returns one reading per registered KPI in registry order', async () => {
    const db = buildDb({});
    const readings = await readAllKpis(ctx(db));
    expect(readings.length).toBe(KPI_REGISTRY.length);
    expect(readings.map((r) => r.id)).toEqual(KPI_REGISTRY.map((k) => k.id));
    for (const r of readings) expect(typeof r.at).toBe('string');
  });
});

describe('signedLift', () => {
  it('reports positive lift when a higher_is_better KPI goes up', () => {
    expect(signedLift('revenue_cents_24h', 100, 250)).toBe(150);
  });

  it('reports positive lift when a lower-is-better KPI goes down', () => {
    expect(signedLift('burn_cents_today', 500, 300)).toBe(200);
  });

  it('reports negative lift when a higher_is_better KPI goes down', () => {
    expect(signedLift('revenue_cents_24h', 200, 50)).toBe(-150);
  });

  it('returns null for unknown KPI ids', () => {
    expect(signedLift('nonexistent', 1, 2)).toBeNull();
  });

  it('returns null when either side is null', () => {
    expect(signedLift('revenue_cents_24h', null, 10)).toBeNull();
    expect(signedLift('revenue_cents_24h', 10, null)).toBeNull();
  });
});

describe('read-error resilience', () => {
  it('returns null for a reading when the underlying table throws', async () => {
    const db: DatabaseAdapter = {
      from: vi.fn().mockImplementation(() => {
        throw new Error('db offline');
      }),
    } as unknown as DatabaseAdapter;
    const r = await readKpi('revenue_cents_24h', ctx(db));
    expect(r?.value).toBeNull();
  });
});
