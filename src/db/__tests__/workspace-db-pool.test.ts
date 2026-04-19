import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock better-sqlite3 so no real filesystem access is needed.
// Must use a real function (not arrow) so `new Database(...)` works.
vi.mock('better-sqlite3', () => {
  const instances: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  function MockDatabase(this: { close: ReturnType<typeof vi.fn> }) {
    this.close = vi.fn();
    instances.push(this);
  }
  MockDatabase._instances = instances;
  return { default: MockDatabase };
});

// Mock workspaceLayoutFor so no ~/.ohwow directory is required
vi.mock('../../config.js', () => ({
  workspaceLayoutFor: vi.fn().mockImplementation((name: string) => ({
    name,
    dataDir: `/tmp/ohwow-test/workspaces/${name}`,
    dbPath: `/tmp/ohwow-test/workspaces/${name}/runtime.db`,
    skillsDir: `/tmp/ohwow-test/workspaces/${name}/skills`,
    tokenPath: `/tmp/ohwow-test/workspaces/${name}/daemon.token`,
    pidPath: `/tmp/ohwow-test/workspaces/${name}/daemon.pid`,
    logPath: `/tmp/ohwow-test/workspaces/${name}/daemon.log`,
  })),
}));

import Database from 'better-sqlite3';
import { WorkspaceDbPool } from '../workspace-db-pool.js';

// Access the tracked instances array from the mock
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MockDb = Database as any;

describe('WorkspaceDbPool', () => {
  let pool: WorkspaceDbPool;

  beforeEach(() => {
    vi.clearAllMocks();
    MockDb._instances.length = 0;
    pool = new WorkspaceDbPool();
  });

  it('get() returns an object with a close method', () => {
    const db = pool.get('default');
    expect(db).toBeDefined();
    expect(typeof db.close).toBe('function');
  });

  it('two calls to get("default") return the same instance (caching)', () => {
    const a = pool.get('default');
    const b = pool.get('default');
    expect(a).toBe(b);
    // Only one Database constructor call
    expect(MockDb._instances.length).toBe(1);
  });

  it('get("avenued") and get("default") return different instances', () => {
    const def = pool.get('default');
    const ave = pool.get('avenued');
    expect(def).not.toBe(ave);
    expect(MockDb._instances.length).toBe(2);
  });

  it('close() calls db.close() and removes from cache', () => {
    const db = pool.get('default') as unknown as { close: ReturnType<typeof vi.fn> };
    pool.close('default');
    expect(db.close).toHaveBeenCalledTimes(1);
    // After close, get() should open a new connection
    MockDb._instances.length = 0;
    pool.get('default');
    expect(MockDb._instances.length).toBe(1);
  });

  it('close() on non-existent workspace does nothing', () => {
    expect(() => pool.close('nonexistent')).not.toThrow();
  });

  it('closeAll() closes all open connections', () => {
    const def = pool.get('default') as unknown as { close: ReturnType<typeof vi.fn> };
    const ave = pool.get('avenued') as unknown as { close: ReturnType<typeof vi.fn> };
    pool.closeAll();
    expect(def.close).toHaveBeenCalledTimes(1);
    expect(ave.close).toHaveBeenCalledTimes(1);
  });

  it('closeAll() on empty pool does nothing', () => {
    expect(() => pool.closeAll()).not.toThrow();
  });
});
