/**
 * Unit tests for the revenue leak watcher.
 *
 * Covers both unattributed payment events and monthly silence detection.
 * Uses the same minimal DatabaseAdapter mock pattern as contact-sla-watcher.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../autonomy/director-persistence.js', () => ({
  writeFounderQuestion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import after mocks so hoisting works correctly.
const { writeFounderQuestion } = await import('../../autonomy/director-persistence.js');
const { checkRevenueLeak } = await import('../revenue-leak-watcher.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock DatabaseAdapter that returns predetermined data for each table.
 * Each call to .from(table) returns a fresh thenable chain. Every chained
 * method (select, eq, insert, etc.) returns the same thenable chain, so the
 * final await resolves to { data: rows, error: null }.
 */
function buildMockDb(tableData: Record<string, unknown[]>): DatabaseAdapter {
  const makeChain = (table: string) => {
    const rows = (tableData[table] ?? []) as unknown[];
    const result = { data: rows, error: null };

    const chain = {} as Record<string, unknown>;

    Object.defineProperty(chain, 'then', {
      enumerable: false,
      configurable: true,
      writable: true,
      value: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    });

    const noop = vi.fn().mockReturnValue(chain);
    chain.select = noop;
    chain.eq = noop;
    chain.neq = noop;
    chain.insert = noop;
    chain.update = noop;
    chain.delete = noop;
    chain.order = noop;
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: rows[0] ?? null, error: null });

    return chain;
  };

  return {
    from: vi.fn().mockImplementation((table: string) => makeChain(table)),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  } as unknown as DatabaseAdapter;
}

const WORKSPACE_ID = 'ws-test-456';

// Fixed "now" so month-sensitive tests are deterministic.
// We use a date past the 5th so monthly-silence logic can trigger.
const FIXED_NOW = new Date('2026-04-21T12:00:00.000Z');
const CURRENT_MONTH = 4;  // April
const CURRENT_YEAR = 2026;

// ---------------------------------------------------------------------------
// checkRevenueLeak
// ---------------------------------------------------------------------------

describe('checkRevenueLeak', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0 when there are no payment events', async () => {
    const db = buildMockDb({
      agent_workforce_contact_events: [],
      agent_workforce_revenue_entries: [],
      founder_inbox: [],
    });
    const result = await checkRevenueLeak(db, WORKSPACE_ID);
    expect(result).toBe(0);
    expect(writeFounderQuestion).not.toHaveBeenCalled();
  });

  it('returns 0 when all payment events have corresponding revenue entries', async () => {
    const db = buildMockDb({
      agent_workforce_contact_events: [
        { id: 'ev-1', contact_id: 'c1', kind: 'plan:paid', occurred_at: '2026-04-10T00:00:00Z', created_at: '2026-04-10T00:00:00Z' },
        { id: 'ev-2', contact_id: 'c2', kind: 'plan:paid', occurred_at: '2026-03-15T00:00:00Z', created_at: '2026-03-15T00:00:00Z' },
      ],
      agent_workforce_revenue_entries: [
        { id: 'r-1', source_event_id: 'ev-1', month: 4, year: 2026, amount_cents: 9900 },
        { id: 'r-2', source_event_id: 'ev-2', month: 3, year: 2026, amount_cents: 9900 },
      ],
      founder_inbox: [],
    });
    const result = await checkRevenueLeak(db, WORKSPACE_ID);
    expect(result).toBe(0);
    expect(writeFounderQuestion).not.toHaveBeenCalled();
  });

  it('detects an unattributed event when payment event has no matching revenue entry', async () => {
    const db = buildMockDb({
      agent_workforce_contact_events: [
        { id: 'ev-1', contact_id: 'c1', kind: 'plan:paid', occurred_at: '2026-04-10T00:00:00Z', created_at: '2026-04-10T00:00:00Z' },
      ],
      agent_workforce_revenue_entries: [],
      founder_inbox: [],
    });
    const result = await checkRevenueLeak(db, WORKSPACE_ID);
    expect(result).toBe(1);
    expect(writeFounderQuestion).toHaveBeenCalledTimes(1);

    const call = (writeFounderQuestion as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(call.workspace_id).toBe(WORKSPACE_ID);
    expect(call.blocker).toBe('revenue-leak');
    expect(call.mode).toBe('revenue');

    const ctx = JSON.parse(call.context as string) as Record<string, unknown>;
    expect(ctx.type).toBe('unattributed_payment_event');
    expect(ctx.eventId).toBe('ev-1');
    expect(ctx.contactId).toBe('c1');
  });

  it('detects an unattributed event when revenue entry has a different source_event_id', async () => {
    const db = buildMockDb({
      agent_workforce_contact_events: [
        { id: 'ev-orphan', contact_id: 'c2', kind: 'plan:paid', occurred_at: '2026-04-05T00:00:00Z', created_at: '2026-04-05T00:00:00Z' },
      ],
      agent_workforce_revenue_entries: [
        // This revenue entry is linked to a different event, not ev-orphan
        { id: 'r-1', source_event_id: 'ev-other', month: 4, year: 2026, amount_cents: 5000 },
      ],
      founder_inbox: [],
    });
    const result = await checkRevenueLeak(db, WORKSPACE_ID);
    expect(result).toBe(1);
    const call = (writeFounderQuestion as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const ctx = JSON.parse(call.context as string) as Record<string, unknown>;
    expect(ctx.eventId).toBe('ev-orphan');
  });

  it('skips unattributed events already alerted in open inbox', async () => {
    const db = buildMockDb({
      agent_workforce_contact_events: [
        { id: 'ev-1', contact_id: 'c1', kind: 'plan:paid', occurred_at: '2026-04-10T00:00:00Z', created_at: '2026-04-10T00:00:00Z' },
      ],
      agent_workforce_revenue_entries: [],
      founder_inbox: [
        {
          id: 'inbox-1',
          status: 'open',
          context: JSON.stringify({ type: 'unattributed_payment_event', eventId: 'ev-1' }),
        },
      ],
    });
    const result = await checkRevenueLeak(db, WORKSPACE_ID);
    expect(result).toBe(0);
    expect(writeFounderQuestion).not.toHaveBeenCalled();
  });

  it('only skips the already-alerted event, writes for the new one', async () => {
    const db = buildMockDb({
      agent_workforce_contact_events: [
        { id: 'ev-1', contact_id: 'c1', kind: 'plan:paid', occurred_at: '2026-04-01T00:00:00Z', created_at: '2026-04-01T00:00:00Z' },
        { id: 'ev-2', contact_id: 'c2', kind: 'plan:paid', occurred_at: '2026-04-08T00:00:00Z', created_at: '2026-04-08T00:00:00Z' },
      ],
      agent_workforce_revenue_entries: [],
      founder_inbox: [
        {
          id: 'inbox-1',
          status: 'open',
          context: JSON.stringify({ type: 'unattributed_payment_event', eventId: 'ev-1' }),
        },
      ],
    });
    const result = await checkRevenueLeak(db, WORKSPACE_ID);
    expect(result).toBe(1);
    expect(writeFounderQuestion).toHaveBeenCalledTimes(1);
    const call = (writeFounderQuestion as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const ctx = JSON.parse(call.context as string) as Record<string, unknown>;
    expect(ctx.eventId).toBe('ev-2');
  });

  it('detects monthly silence when past the 5th, current month has no revenue, prior months do', async () => {
    // FIXED_NOW is April 21 — past the 5th.
    // No April entries, but March has one.
    const db = buildMockDb({
      agent_workforce_contact_events: [],
      agent_workforce_revenue_entries: [
        { id: 'r-1', source_event_id: null, month: 3, year: 2026, amount_cents: 9900 },
      ],
      founder_inbox: [],
    });
    const result = await checkRevenueLeak(db, WORKSPACE_ID);
    expect(result).toBe(1);
    expect(writeFounderQuestion).toHaveBeenCalledTimes(1);

    const call = (writeFounderQuestion as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const ctx = JSON.parse(call.context as string) as Record<string, unknown>;
    expect(ctx.type).toBe('monthly_silence');
    expect(ctx.month).toBe(CURRENT_MONTH);
    expect(ctx.year).toBe(CURRENT_YEAR);
  });

  it('does NOT alert monthly silence when no prior months have revenue (no baseline)', async () => {
    const db = buildMockDb({
      agent_workforce_contact_events: [],
      agent_workforce_revenue_entries: [], // no revenue at all
      founder_inbox: [],
    });
    const result = await checkRevenueLeak(db, WORKSPACE_ID);
    expect(result).toBe(0);
    expect(writeFounderQuestion).not.toHaveBeenCalled();
  });

  it('does NOT alert monthly silence when current month already has revenue', async () => {
    const db = buildMockDb({
      agent_workforce_contact_events: [],
      agent_workforce_revenue_entries: [
        { id: 'r-1', source_event_id: null, month: CURRENT_MONTH, year: CURRENT_YEAR, amount_cents: 9900 },
        { id: 'r-2', source_event_id: null, month: 3, year: 2026, amount_cents: 9900 },
      ],
      founder_inbox: [],
    });
    const result = await checkRevenueLeak(db, WORKSPACE_ID);
    expect(result).toBe(0);
    expect(writeFounderQuestion).not.toHaveBeenCalled();
  });

  it('does NOT alert monthly silence when already alerted for this month/year', async () => {
    const db = buildMockDb({
      agent_workforce_contact_events: [],
      agent_workforce_revenue_entries: [
        { id: 'r-1', source_event_id: null, month: 3, year: 2026, amount_cents: 9900 },
      ],
      founder_inbox: [
        {
          id: 'inbox-silence',
          status: 'open',
          context: JSON.stringify({ type: 'monthly_silence', month: CURRENT_MONTH, year: CURRENT_YEAR }),
        },
      ],
    });
    const result = await checkRevenueLeak(db, WORKSPACE_ID);
    expect(result).toBe(0);
    expect(writeFounderQuestion).not.toHaveBeenCalled();
  });

  it('does NOT alert monthly silence when on or before the 5th of the month', async () => {
    // Override to the 5th
    vi.setSystemTime(new Date('2026-04-05T12:00:00.000Z'));
    const db = buildMockDb({
      agent_workforce_contact_events: [],
      agent_workforce_revenue_entries: [
        { id: 'r-1', source_event_id: null, month: 3, year: 2026, amount_cents: 9900 },
      ],
      founder_inbox: [],
    });
    const result = await checkRevenueLeak(db, WORKSPACE_ID);
    expect(result).toBe(0);
    expect(writeFounderQuestion).not.toHaveBeenCalled();
  });

  it('returns correct count when both unattributed events and monthly silence are new', async () => {
    const db = buildMockDb({
      agent_workforce_contact_events: [
        { id: 'ev-1', contact_id: 'c1', kind: 'plan:paid', occurred_at: '2026-04-10T00:00:00Z', created_at: '2026-04-10T00:00:00Z' },
        { id: 'ev-2', contact_id: 'c2', kind: 'plan:paid', occurred_at: '2026-04-11T00:00:00Z', created_at: '2026-04-11T00:00:00Z' },
      ],
      agent_workforce_revenue_entries: [
        // prior month only — no April entries
        { id: 'r-0', source_event_id: null, month: 3, year: 2026, amount_cents: 9900 },
      ],
      founder_inbox: [],
    });
    const result = await checkRevenueLeak(db, WORKSPACE_ID);
    // 2 unattributed + 1 monthly silence = 3
    expect(result).toBe(3);
    expect(writeFounderQuestion).toHaveBeenCalledTimes(3);
  });
});
