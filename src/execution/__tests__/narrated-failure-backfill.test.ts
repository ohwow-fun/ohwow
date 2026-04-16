import { describe, it, expect } from 'vitest';
import { backfillNarratedFailures } from '../narrated-failure-backfill.js';

interface FakeRow {
  id: string;
  title: string | null;
  status: string;
  output: string | null;
  deferred_action: string | null;
  completed_at: string | null;
  updated_at?: string | null;
  failure_category?: string | null;
  error_message?: string | null;
}

interface FakeDeliverable {
  id: string;
  task_id: string;
  status: string;
  rejection_reason?: string | null;
  updated_at?: string | null;
}

function makeDb(rows: FakeRow[], deliverables: FakeDeliverable[] = []) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const deliverableUpdates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    if (table === 'agent_workforce_deliverables') {
      let taskId: string | null = null;
      let statusFilter: string | null = null;
      chain.select = () => chain;
      chain.eq = (col: string, val: unknown) => {
        if (col === 'task_id') taskId = val as string;
        if (col === 'status') statusFilter = val as string;
        return chain;
      };
      const exec = () => {
        const matches = deliverables.filter(
          (d) => (taskId === null || d.task_id === taskId) && (statusFilter === null || d.status === statusFilter),
        );
        return Promise.resolve({ data: matches, error: null });
      };
      Object.assign(chain, { then: (cb: (v: unknown) => unknown) => exec().then(cb) });
      chain.update = (patch: Record<string, unknown>) => ({
        eq: async (_col: string, val: string) => {
          deliverableUpdates.push({ id: val, patch });
          const row = deliverables.find((d) => d.id === val);
          if (row) Object.assign(row, patch);
          return { error: null };
        },
      });
      return chain;
    }
    let filteredRows = rows.filter((r) => r.status === 'completed' && r.deferred_action != null);
    chain.select = () => chain;
    chain.eq = (_col: string, _val: unknown) => chain;
    chain.not = (_col: string, _op: string, _val: unknown) => chain;
    chain.gte = (_col: string, val: string) => {
      filteredRows = filteredRows.filter(
        (r) => (r.completed_at ?? '') >= val,
      );
      return chain;
    };
    chain.order = (_col: string, _opts: unknown) => chain;
    chain.limit = (_n: number) => Promise.resolve({ data: filteredRows, error: null });
    chain.update = (patch: Record<string, unknown>) => ({
      eq: async (_col: string, val: string) => {
        updates.push({ id: val, patch });
        const row = rows.find((r) => r.id === val);
        if (row) Object.assign(row, patch);
        return { error: null };
      },
    });
    return chain;
  };
  return { db: { from } as never, updates, deliverableUpdates, deliverables };
}

function seedRow(overrides: Partial<FakeRow>): FakeRow {
  return {
    id: 't-' + Math.random().toString(36).slice(2, 8),
    title: 'Post one tweet today',
    status: 'completed',
    output: null,
    deferred_action: JSON.stringify({ type: 'post_tweet', provider: 'x' }),
    completed_at: '2026-04-16T08:00:00.000Z',
    ...overrides,
  };
}

describe('backfillNarratedFailures', () => {
  it('flags historical capitulation outputs and reports them under dryRun', async () => {
    const rows = [
      seedRow({ id: 't-ok', output: 'Posted the tweet successfully.' }),
      seedRow({
        id: 't-manual',
        output: '## Tweet Ready for Manual Posting\n\nContent: ...',
      }),
      seedRow({
        id: 't-auth',
        output: "I don't have access to the @ohwow_fun account credentials.",
      }),
    ];
    const { db, updates } = makeDb(rows);
    const result = await backfillNarratedFailures(db);
    expect(result.scanned).toBe(3);
    expect(result.flagged.map((h) => h.task_id).sort()).toEqual(['t-auth', 't-manual']);
    expect(result.applied).toBe(0);
    expect(updates).toEqual([]);
    // Original rows are unchanged under dryRun.
    expect(rows.every((r) => r.status === 'completed')).toBe(true);
  });

  it('reroutes flagged rows to status=failed when dryRun=false', async () => {
    const rows = [
      seedRow({ id: 't-auth', output: 'not signed in to the account' }),
      seedRow({ id: 't-ok', output: 'Tweet published.' }),
    ];
    const { db, updates } = makeDb(rows);
    const result = await backfillNarratedFailures(db, { dryRun: false });
    expect(result.applied).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('t-auth');
    expect(updates[0].patch.status).toBe('failed');
    expect(updates[0].patch.failure_category).toBe('narrated_failure_backfill');
    expect(String(updates[0].patch.error_message)).toContain('not signed in');
  });

  it('captures action_type from JSON-string deferred_action', async () => {
    const rows = [
      seedRow({
        id: 't-email',
        output: 'permission denied by gmail',
        deferred_action: JSON.stringify({ type: 'send_email' }),
      }),
    ];
    const { db } = makeDb(rows);
    const result = await backfillNarratedFailures(db);
    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0].action_type).toBe('send_email');
  });

  it('returns flagged=[] on a clean history', async () => {
    const rows = [
      seedRow({ id: 't-1', output: 'Posted. https://x.com/acct/status/1' }),
      seedRow({ id: 't-2', output: 'Tweet sent.' }),
    ];
    const { db } = makeDb(rows);
    const result = await backfillNarratedFailures(db);
    expect(result.scanned).toBe(2);
    expect(result.flagged).toEqual([]);
    expect(result.applied).toBe(0);
  });

  it('reroutes linked approved deliverables to rejected alongside the parent task', async () => {
    const rows = [
      seedRow({ id: 't-cap', output: "## Tweet Ready for Manual Posting\n\n..." }),
    ];
    const deliverables: FakeDeliverable[] = [
      { id: 'd-1', task_id: 't-cap', status: 'approved' },
      { id: 'd-2', task_id: 't-cap', status: 'delivered' }, // already delivered → should NOT be touched
    ];
    const { db, deliverableUpdates } = makeDb(rows, deliverables);
    const result = await backfillNarratedFailures(db, { dryRun: false });
    expect(result.deliverablesRerouted).toBe(1);
    expect(deliverableUpdates).toHaveLength(1);
    expect(deliverableUpdates[0].id).toBe('d-1');
    expect(deliverableUpdates[0].patch.status).toBe('rejected');
    expect(String(deliverableUpdates[0].patch.rejection_reason)).toContain('manual posting');
    // The already-delivered row stays alone — we never touch rows that actually went out.
    expect(deliverables.find((d) => d.id === 'd-2')!.status).toBe('delivered');
  });

  it('deliverablesRerouted is 0 when there are no linked approved rows', async () => {
    const rows = [
      seedRow({ id: 't-cap', output: 'login page blocked me' }),
    ];
    const { db } = makeDb(rows, []);
    const result = await backfillNarratedFailures(db, { dryRun: false });
    expect(result.applied).toBe(1);
    expect(result.deliverablesRerouted).toBe(0);
  });

  it('respects the since= window', async () => {
    const rows = [
      seedRow({ id: 't-old', output: 'login page blocked me', completed_at: '2026-04-10T00:00:00.000Z' }),
      seedRow({ id: 't-new', output: 'cannot authenticate', completed_at: '2026-04-16T00:00:00.000Z' }),
    ];
    const { db } = makeDb(rows);
    const result = await backfillNarratedFailures(db, { since: '2026-04-15T00:00:00.000Z' });
    expect(result.scanned).toBe(1);
    expect(result.flagged.map((h) => h.task_id)).toEqual(['t-new']);
  });
});
