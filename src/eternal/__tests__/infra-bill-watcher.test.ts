/**
 * Unit tests for the infrastructure bill watcher.
 *
 * Tests confirmationThresholdDays (pure utility) and checkInfraBills
 * (DB-backed side-effecting function). Uses a minimal DatabaseAdapter
 * mock that supports the chained .from().select().eq()... pattern.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { confirmationThresholdDays, checkInfraBills } from '../infra-bill-watcher.js';

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

const WORKSPACE_ID = 'ws-test-infra';

const NOW = Date.now();
const DAYS = (n: number) => n * 86_400_000;

function isoAgo(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

// ---------------------------------------------------------------------------
// confirmationThresholdDays
// ---------------------------------------------------------------------------

describe('confirmationThresholdDays', () => {
  it('returns 35 for monthly manual-pay (auto_pay=0)', () => {
    expect(confirmationThresholdDays('monthly', 0)).toBe(35);
  });

  it('returns 40 for monthly auto-pay (auto_pay=1)', () => {
    expect(confirmationThresholdDays('monthly', 1)).toBe(40);
  });

  it('returns 400 for annual regardless of auto_pay', () => {
    expect(confirmationThresholdDays('annual', 0)).toBe(400);
    expect(confirmationThresholdDays('annual', 1)).toBe(400);
  });

  it('returns 7 for one-time regardless of auto_pay', () => {
    expect(confirmationThresholdDays('one-time', 0)).toBe(7);
    expect(confirmationThresholdDays('one-time', 1)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// checkInfraBills
// ---------------------------------------------------------------------------

describe('checkInfraBills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0 when there are no bills', async () => {
    const db = buildMockDb({
      infrastructure_bills: [],
      founder_inbox: [],
    });
    const result = await checkInfraBills(db, WORKSPACE_ID);
    expect(result).toBe(0);
    expect(writeFounderQuestion).not.toHaveBeenCalled();
  });

  it('returns 0 when all bills were confirmed recently', async () => {
    const db = buildMockDb({
      infrastructure_bills: [
        {
          id: 'b1',
          service_name: 'Fly.io',
          category: 'hosting',
          amount_cents: 2000,
          billing_cycle: 'monthly',
          auto_pay: 0,
          last_confirmed_at: isoAgo(DAYS(10)), // 10 days ago, within 35-day threshold
          created_at: isoAgo(DAYS(60)),
        },
      ],
      founder_inbox: [],
    });
    const result = await checkInfraBills(db, WORKSPACE_ID);
    expect(result).toBe(0);
    expect(writeFounderQuestion).not.toHaveBeenCalled();
  });

  it('writes an alert for a monthly bill not confirmed in >35 days', async () => {
    const db = buildMockDb({
      infrastructure_bills: [
        {
          id: 'b2',
          service_name: 'Cloudflare',
          category: 'domain',
          amount_cents: 1500,
          billing_cycle: 'monthly',
          auto_pay: 0,
          last_confirmed_at: isoAgo(DAYS(40)), // 40 days ago, exceeds 35-day threshold
          created_at: isoAgo(DAYS(90)),
        },
      ],
      founder_inbox: [],
    });
    const result = await checkInfraBills(db, WORKSPACE_ID);
    expect(result).toBe(1);
    expect(writeFounderQuestion).toHaveBeenCalledTimes(1);
    const call = (writeFounderQuestion as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(call.workspace_id).toBe(WORKSPACE_ID);
    expect(call.blocker).toBe('infra-bill-unconfirmed');
    const ctx = JSON.parse(call.context as string) as Record<string, unknown>;
    expect(ctx.billId).toBe('b2');
    expect(ctx.serviceName).toBe('Cloudflare');
    expect(ctx.threshold).toBe(35);
  });

  it('skips bills that already have an open infra-bill-unconfirmed alert', async () => {
    const db = buildMockDb({
      infrastructure_bills: [
        {
          id: 'b3',
          service_name: 'Vercel',
          category: 'hosting',
          amount_cents: 5000,
          billing_cycle: 'monthly',
          auto_pay: 0,
          last_confirmed_at: isoAgo(DAYS(45)), // would normally trigger
          created_at: isoAgo(DAYS(100)),
        },
      ],
      founder_inbox: [
        {
          id: 'inbox-1',
          blocker: 'infra-bill-unconfirmed',
          status: 'open',
          context: JSON.stringify({ billId: 'b3' }),
        },
      ],
    });
    const result = await checkInfraBills(db, WORKSPACE_ID);
    expect(result).toBe(0);
    expect(writeFounderQuestion).not.toHaveBeenCalled();
  });

  it('uses created_at as reference when last_confirmed_at is null', async () => {
    const db = buildMockDb({
      infrastructure_bills: [
        {
          id: 'b4',
          service_name: 'Supabase',
          category: 'saas',
          amount_cents: 2500,
          billing_cycle: 'monthly',
          auto_pay: 1,
          last_confirmed_at: null, // never confirmed
          created_at: isoAgo(DAYS(45)), // 45 days ago, exceeds 40-day auto-pay threshold
        },
      ],
      founder_inbox: [],
    });
    const result = await checkInfraBills(db, WORKSPACE_ID);
    expect(result).toBe(1);
    expect(writeFounderQuestion).toHaveBeenCalledTimes(1);
    const ctx = JSON.parse(
      (writeFounderQuestion as ReturnType<typeof vi.fn>).mock.calls[0][1].context as string,
    ) as Record<string, unknown>;
    expect(ctx.billId).toBe('b4');
    expect(ctx.autoPay).toBe(true);
    expect(ctx.threshold).toBe(40);
  });

  it('writes an alert for an annual bill not confirmed in >400 days', async () => {
    const db = buildMockDb({
      infrastructure_bills: [
        {
          id: 'b5',
          service_name: 'AWS Route 53',
          category: 'domain',
          amount_cents: 15000,
          billing_cycle: 'annual',
          auto_pay: 0,
          last_confirmed_at: isoAgo(DAYS(410)), // exceeds 400-day annual threshold
          created_at: isoAgo(DAYS(420)),
        },
      ],
      founder_inbox: [],
    });
    const result = await checkInfraBills(db, WORKSPACE_ID);
    expect(result).toBe(1);
    const ctx = JSON.parse(
      (writeFounderQuestion as ReturnType<typeof vi.fn>).mock.calls[0][1].context as string,
    ) as Record<string, unknown>;
    expect(ctx.threshold).toBe(400);
    expect(ctx.billingCycle).toBe('annual');
  });

  it('does not alert an annual bill confirmed 390 days ago (within threshold)', async () => {
    const db = buildMockDb({
      infrastructure_bills: [
        {
          id: 'b6',
          service_name: 'GitHub',
          category: 'saas',
          amount_cents: 4000,
          billing_cycle: 'annual',
          auto_pay: 1,
          last_confirmed_at: isoAgo(DAYS(390)), // within 400-day threshold
          created_at: isoAgo(DAYS(400)),
        },
      ],
      founder_inbox: [],
    });
    const result = await checkInfraBills(db, WORKSPACE_ID);
    expect(result).toBe(0);
    expect(writeFounderQuestion).not.toHaveBeenCalled();
  });

  it('returns the correct count when multiple bills need alerting', async () => {
    const db = buildMockDb({
      infrastructure_bills: [
        {
          id: 'b7',
          service_name: 'Render',
          category: 'hosting',
          amount_cents: 700,
          billing_cycle: 'monthly',
          auto_pay: 0,
          last_confirmed_at: isoAgo(DAYS(36)), // exceeds 35-day threshold
          created_at: isoAgo(DAYS(100)),
        },
        {
          id: 'b8',
          service_name: 'Linear',
          category: 'saas',
          amount_cents: 800,
          billing_cycle: 'monthly',
          auto_pay: 0,
          last_confirmed_at: isoAgo(DAYS(50)), // exceeds 35-day threshold
          created_at: isoAgo(DAYS(200)),
        },
        {
          id: 'b9',
          service_name: 'Notion',
          category: 'saas',
          amount_cents: 1600,
          billing_cycle: 'monthly',
          auto_pay: 0,
          last_confirmed_at: isoAgo(DAYS(5)), // within 35-day threshold — no alert
          created_at: isoAgo(DAYS(200)),
        },
      ],
      founder_inbox: [],
    });
    const result = await checkInfraBills(db, WORKSPACE_ID);
    expect(result).toBe(2);
    expect(writeFounderQuestion).toHaveBeenCalledTimes(2);
  });
});
