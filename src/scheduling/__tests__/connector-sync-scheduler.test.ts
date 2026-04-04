import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectorSyncScheduler, type ConnectorRow } from '../connector-sync-scheduler.js';
import type { ConnectorType, ConnectorDocument, DataSourceConnector } from '../../integrations/connector-types.js';
import { ConnectorRegistry } from '../../integrations/connector-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides?: Partial<ConnectorRow>): ConnectorRow {
  return {
    id: 'conn-1',
    type: 'github',
    name: 'Test Connector',
    settings: JSON.stringify({ repo: 'owner/repo' }),
    sync_interval_minutes: 30,
    last_sync_at: null,
    enabled: 1,
    ...overrides,
  };
}

function mockConnector(docs: ConnectorDocument[] = []): DataSourceConnector {
  return {
    type: 'github' as ConnectorType,
    name: 'Mock',
    async *load() {
      for (const d of docs) yield d;
    },
    async testConnection() {
      return { ok: true };
    },
  };
}

function mockDb(connectors: ConnectorRow[] = []): { from: ReturnType<typeof vi.fn>; rpc: ReturnType<typeof vi.fn>; insertCalls: { table: string; row: Record<string, unknown> }[]; updateCalls: { table: string; fields: Record<string, unknown> }[] } {
  const insertCalls: { table: string; row: Record<string, unknown> }[] = [];
  const updateCalls: { table: string; fields: Record<string, unknown> }[] = [];

  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    const wrap = () =>
      new Proxy(chain, {
        get(_t, prop) {
          if (prop === 'then') {
            if (table === 'data_source_connectors') {
              return (resolve: (v: unknown) => void) => resolve({ data: connectors, error: null });
            }
            return (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
          }
          if (prop === 'insert') {
            return (row: Record<string, unknown>) => {
              insertCalls.push({ table, row });
              return wrap();
            };
          }
          if (prop === 'update') {
            return (fields: Record<string, unknown>) => {
              updateCalls.push({ table, fields });
              return wrap();
            };
          }
          // select, eq, order, etc.
          return (..._args: unknown[]) => wrap();
        },
      });
    return wrap();
  });

  return { from, rpc: vi.fn(), insertCalls, updateCalls };
}

function mockBus() {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn(), once: vi.fn() } as unknown as import('../../lib/typed-event-bus.js').TypedEventBus<import('../../tui/types.js').RuntimeEvents>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConnectorSyncScheduler', () => {
  let registry: ConnectorRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new ConnectorRegistry();
    registry.registerFactory('github', () => mockConnector([{ id: 'doc1', title: 'Doc 1', content: 'Hello' }]));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() sets up interval and stop() clears it', () => {
    const db = mockDb();
    const scheduler = new ConnectorSyncScheduler(db as never, 'ws-1', registry, mockBus());

    scheduler.start();
    // Calling start again is a no-op
    scheduler.start();

    scheduler.stop();
    // Safe to call stop again
    scheduler.stop();
  });

  it('tick() syncs connectors that have never been synced (last_sync_at null)', async () => {
    const row = makeRow({ last_sync_at: null });
    const db = mockDb([row]);
    const scheduler = new ConnectorSyncScheduler(db as never, 'ws-1', registry, mockBus());

    await scheduler.tick();

    // Should have insert calls for document and queue job
    expect(db.insertCalls.some((c: { table: string }) => c.table === 'agent_workforce_knowledge_documents')).toBe(true);
    expect(db.insertCalls.some((c: { table: string }) => c.table === 'document_processing_queue')).toBe(true);

    // Should have update calls marking running then success
    const statusUpdates = db.updateCalls
      .filter((c: { table: string }) => c.table === 'data_source_connectors')
      .map((c: { fields: Record<string, unknown> }) => c.fields.last_sync_status);
    expect(statusUpdates).toContain('running');
    expect(statusUpdates).toContain('success');
  });

  it('tick() syncs connectors past their interval', async () => {
    const pastDate = new Date(Date.now() - 60 * 60_000).toISOString(); // 60 min ago
    const row = makeRow({ sync_interval_minutes: 30, last_sync_at: pastDate });
    const db = mockDb([row]);
    const scheduler = new ConnectorSyncScheduler(db as never, 'ws-1', registry, mockBus());

    await scheduler.tick();

    expect(db.insertCalls.some((c: { table: string }) => c.table === 'agent_workforce_knowledge_documents')).toBe(true);
  });

  it('tick() skips connectors synced recently (within interval)', async () => {
    const recentDate = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min ago
    const row = makeRow({ sync_interval_minutes: 30, last_sync_at: recentDate });
    const db = mockDb([row]);
    const scheduler = new ConnectorSyncScheduler(db as never, 'ws-1', registry, mockBus());

    await scheduler.tick();

    // No document inserts — connector not due
    expect(db.insertCalls.length).toBe(0);
  });

  it('tick() prevents overlapping syncs via syncing flag', async () => {
    const row = makeRow();
    const db = mockDb([row]);

    // Create a connector whose load() blocks on a promise we control
    let resolveLoad!: () => void;
    const loadBlocked = new Promise<void>((r) => { resolveLoad = r; });

    const slowConnector: DataSourceConnector = {
      type: 'github' as ConnectorType,
      name: 'Slow',
      async *load() {
        await loadBlocked;
        yield { id: '1', title: 'Slow Doc', content: 'slow' };
      },
      async testConnection() {
        return { ok: true };
      },
    };
    const slowRegistry = new ConnectorRegistry();
    slowRegistry.registerFactory('github', () => slowConnector);

    const scheduler = new ConnectorSyncScheduler(db as never, 'ws-1', slowRegistry, mockBus());

    // Start first tick (will block on loadBlocked)
    const tick1 = scheduler.tick();
    // Immediately call tick again — should be skipped because syncing=true
    await scheduler.tick();

    // No doc inserts yet from either tick
    const docInsertsBefore = db.insertCalls.filter((c: { table: string }) => c.table === 'agent_workforce_knowledge_documents');
    expect(docInsertsBefore.length).toBe(0);

    // Unblock the first tick
    resolveLoad();
    await tick1;

    // Only one set of document inserts
    const docInserts = db.insertCalls.filter((c: { table: string }) => c.table === 'agent_workforce_knowledge_documents');
    expect(docInserts.length).toBe(1);
  });

  it('handles sync errors gracefully (marks failed, continues)', async () => {
    const failConnector: DataSourceConnector = {
      type: 'github' as ConnectorType,
      name: 'Fail',
      async *load() {
        throw new Error('Connection refused');
      },
      async testConnection() {
        return { ok: false, error: 'nope' };
      },
    };
    const failRegistry = new ConnectorRegistry();
    failRegistry.registerFactory('github', () => failConnector);

    const row = makeRow();
    const db = mockDb([row]);
    const scheduler = new ConnectorSyncScheduler(db as never, 'ws-1', failRegistry, mockBus());

    // Should not throw
    await scheduler.tick();

    const statusUpdates = db.updateCalls
      .filter((c: { table: string }) => c.table === 'data_source_connectors')
      .map((c: { fields: Record<string, unknown> }) => c.fields.last_sync_status);
    expect(statusUpdates).toContain('failed');

    const errorUpdates = db.updateCalls
      .filter((c: { table: string; fields: Record<string, unknown> }) => c.table === 'data_source_connectors' && c.fields.last_sync_error);
    expect(errorUpdates.length).toBeGreaterThan(0);
    expect(errorUpdates[0].fields.last_sync_error).toBe('Connection refused');
  });

  it('skips connectors with no registered factory', async () => {
    const row = makeRow({ type: 'slack' }); // no factory registered for slack
    const db = mockDb([row]);
    const scheduler = new ConnectorSyncScheduler(db as never, 'ws-1', registry, mockBus());

    await scheduler.tick();

    // No updates at all (not even 'running')
    expect(db.updateCalls.length).toBe(0);
  });

  it('tick() handles empty connector list', async () => {
    const db = mockDb([]);
    const scheduler = new ConnectorSyncScheduler(db as never, 'ws-1', registry, mockBus());

    // Should not throw
    await scheduler.tick();
    expect(db.insertCalls.length).toBe(0);
  });
});
