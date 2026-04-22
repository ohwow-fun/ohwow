/**
 * Unit tests for the contact SLA watcher.
 *
 * Tests slaThresholdForType (pure utility) and checkContactSLAs (DB-backed
 * side-effecting function). Uses a minimal DatabaseAdapter mock that supports
 * the chained .from().select().eq()... pattern.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { EternalSpec } from '../types.js';
import { slaThresholdForType, checkContactSLAs } from '../contact-sla-watcher.js';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_SLA_DAYS = { customer: 30, partner: 14, lead: 21, other: 60 };

function makeSpec(contactSlaDays: Record<string, number> = DEFAULT_SLA_DAYS): EternalSpec {
  return {
    inactivityProtocol: {
      conservativeAfterDays: 7,
      trusteePingAfterDays: 7,
      estateAfterDays: 90,
    },
    escalationMap: [],
    contactSlaDays,
  };
}

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

    // Build a plain object with a custom 'then' defined via defineProperty
    // to avoid the "only a getter" conflict.
    const chain = {} as Record<string, unknown>;

    // Make chain awaitable (thenable) — resolves to { data, error }
    Object.defineProperty(chain, 'then', {
      enumerable: false,
      configurable: true,
      writable: true,
      value: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    });

    // All chaining methods return the same awaitable chain.
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

const WORKSPACE_ID = 'ws-test-123';

const NOW = Date.now();
const DAYS = (n: number) => n * 86_400_000;

function isoAgo(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

// ---------------------------------------------------------------------------
// slaThresholdForType
// ---------------------------------------------------------------------------

describe('slaThresholdForType', () => {
  it('returns the correct threshold for a known type', () => {
    expect(slaThresholdForType('customer', DEFAULT_SLA_DAYS)).toBe(30);
    expect(slaThresholdForType('partner', DEFAULT_SLA_DAYS)).toBe(14);
    expect(slaThresholdForType('lead', DEFAULT_SLA_DAYS)).toBe(21);
    expect(slaThresholdForType('other', DEFAULT_SLA_DAYS)).toBe(60);
  });

  it('returns undefined for a type not in slaDays', () => {
    expect(slaThresholdForType('vendor', DEFAULT_SLA_DAYS)).toBeUndefined();
    expect(slaThresholdForType('', DEFAULT_SLA_DAYS)).toBeUndefined();
  });

  it('returns undefined for every type when slaDays is empty', () => {
    expect(slaThresholdForType('customer', {})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkContactSLAs
// ---------------------------------------------------------------------------

describe('checkContactSLAs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0 when contactSlaDays is empty (no types monitored)', async () => {
    const db = buildMockDb({});
    const spec = makeSpec({});
    const result = await checkContactSLAs(db, WORKSPACE_ID, spec);
    expect(result).toBe(0);
    expect(db.from).not.toHaveBeenCalled();
  });

  it('returns 0 when there are no active contacts', async () => {
    const db = buildMockDb({
      agent_workforce_contacts: [],
      agent_workforce_contact_events: [],
      founder_inbox: [],
    });
    const result = await checkContactSLAs(db, WORKSPACE_ID, makeSpec());
    expect(result).toBe(0);
    expect(writeFounderQuestion).not.toHaveBeenCalled();
  });

  it('returns 0 when all contacts are within their SLA', async () => {
    const db = buildMockDb({
      agent_workforce_contacts: [
        {
          id: 'c1',
          name: 'Alice',
          contact_type: 'customer',
          created_at: isoAgo(DAYS(100)),
        },
      ],
      agent_workforce_contact_events: [
        {
          contact_id: 'c1',
          occurred_at: isoAgo(DAYS(10)), // 10 days ago, within 30-day SLA
          created_at: isoAgo(DAYS(10)),
        },
      ],
      founder_inbox: [],
    });
    const result = await checkContactSLAs(db, WORKSPACE_ID, makeSpec());
    expect(result).toBe(0);
    expect(writeFounderQuestion).not.toHaveBeenCalled();
  });

  it('writes a founder_inbox alert when a contact exceeds its SLA threshold', async () => {
    const db = buildMockDb({
      agent_workforce_contacts: [
        {
          id: 'c1',
          name: 'Bob',
          contact_type: 'partner',
          created_at: isoAgo(DAYS(60)),
        },
      ],
      agent_workforce_contact_events: [
        {
          contact_id: 'c1',
          occurred_at: isoAgo(DAYS(20)), // 20 days, exceeds 14-day partner SLA
          created_at: isoAgo(DAYS(20)),
        },
      ],
      founder_inbox: [],
    });
    const result = await checkContactSLAs(db, WORKSPACE_ID, makeSpec());
    expect(result).toBe(1);
    expect(writeFounderQuestion).toHaveBeenCalledTimes(1);
    const call = (writeFounderQuestion as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(call.workspace_id).toBe(WORKSPACE_ID);
    expect(call.blocker).toBe('relationship-decay');
    const ctx = JSON.parse(call.context as string) as Record<string, unknown>;
    expect(ctx.contactId).toBe('c1');
    expect(ctx.contactName).toBe('Bob');
    expect(ctx.slaThreshold).toBe(14);
    expect(ctx.contactType).toBe('partner');
  });

  it('skips contacts that already have an open relationship-decay alert', async () => {
    const db = buildMockDb({
      agent_workforce_contacts: [
        {
          id: 'c1',
          name: 'Carol',
          contact_type: 'lead',
          created_at: isoAgo(DAYS(60)),
        },
      ],
      agent_workforce_contact_events: [
        {
          contact_id: 'c1',
          occurred_at: isoAgo(DAYS(25)), // 25 days, exceeds 21-day lead SLA
          created_at: isoAgo(DAYS(25)),
        },
      ],
      founder_inbox: [
        {
          id: 'inbox-1',
          blocker: 'relationship-decay',
          status: 'open',
          context: JSON.stringify({ contactId: 'c1' }),
        },
      ],
    });
    const result = await checkContactSLAs(db, WORKSPACE_ID, makeSpec());
    expect(result).toBe(0);
    expect(writeFounderQuestion).not.toHaveBeenCalled();
  });

  it('uses created_at as fallback when no events exist for a contact', async () => {
    // Contact was created 35 days ago and never touched (no events).
    // Customer SLA is 30 days — should fire.
    const db = buildMockDb({
      agent_workforce_contacts: [
        {
          id: 'c2',
          name: 'Dave',
          contact_type: 'customer',
          created_at: isoAgo(DAYS(35)),
        },
      ],
      agent_workforce_contact_events: [],
      founder_inbox: [],
    });
    const result = await checkContactSLAs(db, WORKSPACE_ID, makeSpec());
    expect(result).toBe(1);
    expect(writeFounderQuestion).toHaveBeenCalledTimes(1);
  });

  it('uses the most recent occurred_at when multiple events exist', async () => {
    // Contact has two events: one 40 days ago and one 5 days ago.
    // Lead SLA is 21 days. Most recent is 5 days — should NOT fire.
    const db = buildMockDb({
      agent_workforce_contacts: [
        {
          id: 'c3',
          name: 'Eve',
          contact_type: 'lead',
          created_at: isoAgo(DAYS(50)),
        },
      ],
      agent_workforce_contact_events: [
        {
          contact_id: 'c3',
          occurred_at: isoAgo(DAYS(40)),
          created_at: isoAgo(DAYS(40)),
        },
        {
          contact_id: 'c3',
          occurred_at: isoAgo(DAYS(5)),
          created_at: isoAgo(DAYS(5)),
        },
      ],
      founder_inbox: [],
    });
    const result = await checkContactSLAs(db, WORKSPACE_ID, makeSpec());
    expect(result).toBe(0);
    expect(writeFounderQuestion).not.toHaveBeenCalled();
  });

  it('returns the count of alerts written across multiple contacts', async () => {
    const db = buildMockDb({
      agent_workforce_contacts: [
        {
          id: 'c4',
          name: 'Frank',
          contact_type: 'customer',
          created_at: isoAgo(DAYS(50)),
        },
        {
          id: 'c5',
          name: 'Grace',
          contact_type: 'partner',
          created_at: isoAgo(DAYS(30)),
        },
        {
          id: 'c6',
          name: 'Hank',
          contact_type: 'lead',
          created_at: isoAgo(DAYS(100)),
        },
      ],
      agent_workforce_contact_events: [
        // c4: last touch 40 days ago — exceeds 30-day customer SLA
        { contact_id: 'c4', occurred_at: isoAgo(DAYS(40)), created_at: isoAgo(DAYS(40)) },
        // c5: last touch 20 days ago — exceeds 14-day partner SLA
        { contact_id: 'c5', occurred_at: isoAgo(DAYS(20)), created_at: isoAgo(DAYS(20)) },
        // c6: last touch 5 days ago — within 21-day lead SLA
        { contact_id: 'c6', occurred_at: isoAgo(DAYS(5)), created_at: isoAgo(DAYS(5)) },
      ],
      founder_inbox: [],
    });
    const result = await checkContactSLAs(db, WORKSPACE_ID, makeSpec());
    expect(result).toBe(2);
    expect(writeFounderQuestion).toHaveBeenCalledTimes(2);
  });
});
