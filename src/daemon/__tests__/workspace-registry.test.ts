/**
 * TEST A — WorkspaceRegistry isolation
 * Verifies register/get/has/getAll/unload/unloadAll contract and
 * discoverWorkspaceNames filesystem scan behaviour.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mock logger to suppress output
// ---------------------------------------------------------------------------
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(name: string) {
  return {
    workspaceName: name,
    workspaceId: 'local',
    dataDir: `/tmp/${name}`,
    sessionToken: `tok-${name}`,
    rawDb: { close: vi.fn() } as unknown as ReturnType<typeof import('../../db/init.js').initDatabase>,
    db: {} as import('../../db/adapter-types.js').DatabaseAdapter,
    config: {} as import('../../config.js').RuntimeConfig,
    businessContext: { businessName: name, businessType: 'saas_startup' },
    engine: null,
    orchestrator: null,
    triggerEvaluator: null,
    channelRegistry: null,
    connectorRegistry: null,
    messageRouter: null,
    scheduler: { stop: vi.fn() } as unknown as import('../../scheduling/local-scheduler.js').LocalScheduler,
    proactiveEngine: { stop: vi.fn() } as unknown as import('../../planning/proactive-engine.js').ProactiveEngine,
    connectorSyncScheduler: { stop: vi.fn() } as unknown as import('../../scheduling/connector-sync-scheduler.js').ConnectorSyncScheduler,
    controlPlane: null,
    bus: {} as import('../../lib/typed-event-bus.js').TypedEventBus<import('../../tui/types.js').RuntimeEvents>,
  } satisfies import('../workspace-context.js').WorkspaceContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkspaceRegistry', () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  let WorkspaceRegistry: typeof import('../workspace-registry.js').WorkspaceRegistry;

  beforeEach(async () => {
    vi.resetModules();
    ({ WorkspaceRegistry } = await import('../workspace-registry.js'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── register + get round-trips ──────────────────────────────────────────

  it('register() + get() round-trips correctly', () => {
    const registry = new WorkspaceRegistry();
    const ctx = makeCtx('default');
    registry.register(ctx);
    expect(registry.get('default')).toBe(ctx);
  });

  it('get() with unknown name throws', () => {
    const registry = new WorkspaceRegistry();
    expect(() => registry.get('nonexistent')).toThrow("Workspace 'nonexistent' is not loaded");
  });

  // ── has() ────────────────────────────────────────────────────────────────

  it('has() returns true when workspace is registered', () => {
    const registry = new WorkspaceRegistry();
    registry.register(makeCtx('default'));
    expect(registry.has('default')).toBe(true);
  });

  it('has() returns false when workspace is not registered', () => {
    const registry = new WorkspaceRegistry();
    expect(registry.has('avenued')).toBe(false);
  });

  // ── two independent contexts ─────────────────────────────────────────────

  it('two registered contexts with different workspaceNames are retrievable independently', () => {
    const registry = new WorkspaceRegistry();
    const ctxA = makeCtx('default');
    const ctxB = makeCtx('avenued');
    registry.register(ctxA);
    registry.register(ctxB);

    expect(registry.get('default')).toBe(ctxA);
    expect(registry.get('avenued')).toBe(ctxB);
    expect(registry.get('default')).not.toBe(ctxB);
  });

  // ── getAll() ─────────────────────────────────────────────────────────────

  it('getAll() returns all registered contexts', () => {
    const registry = new WorkspaceRegistry();
    const ctxA = makeCtx('default');
    const ctxB = makeCtx('avenued');
    registry.register(ctxA);
    registry.register(ctxB);

    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all).toContain(ctxA);
    expect(all).toContain(ctxB);
  });

  it('getAll() returns empty array when no contexts registered', () => {
    const registry = new WorkspaceRegistry();
    expect(registry.getAll()).toHaveLength(0);
  });

  // ── unload() ─────────────────────────────────────────────────────────────

  it('unload() calls scheduler.stop(), proactiveEngine.stop(), connectorSyncScheduler.stop(), rawDb.close()', async () => {
    const registry = new WorkspaceRegistry();
    const ctx = makeCtx('default');
    registry.register(ctx);

    await registry.unload('default');

    expect(ctx.scheduler!.stop).toHaveBeenCalled();
    expect(ctx.proactiveEngine!.stop).toHaveBeenCalled();
    expect(ctx.connectorSyncScheduler!.stop).toHaveBeenCalled();
    expect(ctx.rawDb.close).toHaveBeenCalled();
  });

  it('unload() removes the workspace from the map', async () => {
    const registry = new WorkspaceRegistry();
    registry.register(makeCtx('default'));

    await registry.unload('default');

    expect(registry.has('default')).toBe(false);
    expect(() => registry.get('default')).toThrow();
  });

  it('unload() of an unknown name is a no-op (does not throw)', async () => {
    const registry = new WorkspaceRegistry();
    await expect(registry.unload('nonexistent')).resolves.toBeUndefined();
  });

  it('unload() with null scheduler/engine fields does not throw', async () => {
    const registry = new WorkspaceRegistry();
    const ctx = makeCtx('default');
    // WorkspaceContext types these as non-null in makeCtx; cast via unknown to null for the test
    (ctx as unknown as { scheduler: null }).scheduler = null;
    (ctx as unknown as { proactiveEngine: null }).proactiveEngine = null;
    (ctx as unknown as { connectorSyncScheduler: null }).connectorSyncScheduler = null;
    registry.register(ctx);

    await expect(registry.unload('default')).resolves.toBeUndefined();
  });

  // ── unloadAll() ──────────────────────────────────────────────────────────

  it('unloadAll() calls unload on every registered context', async () => {
    const registry = new WorkspaceRegistry();
    const ctxA = makeCtx('default');
    const ctxB = makeCtx('avenued');
    registry.register(ctxA);
    registry.register(ctxB);

    await registry.unloadAll();

    expect(ctxA.scheduler!.stop).toHaveBeenCalled();
    expect(ctxB.scheduler!.stop).toHaveBeenCalled();
    expect(registry.getAll()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// discoverWorkspaceNames — filesystem scan (using vi.mock for ESM compat)
// ---------------------------------------------------------------------------

// We mock 'os' and 'fs' so we can control homedir() and the directory/file
// layout without touching the real filesystem. ESM module namespaces are not
// re-configurable via vi.spyOn, so vi.mock is the only viable approach here.

const mockHomedir = vi.fn(() => '/mock-home');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExistsSync = vi.fn<(...args: any[]) => boolean>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockReaddirSync = vi.fn<(...args: any[]) => { isDirectory: () => boolean; name: string }[]>();

vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return { ...original, homedir: () => mockHomedir() };
});

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    existsSync: (p: string) => mockExistsSync(p),
    readdirSync: (p: string, opts: { withFileTypes: true }) => mockReaddirSync(p, opts),
  };
});

describe('discoverWorkspaceNames', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHomedir.mockReturnValue('/mock-home');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const wsRoot = path.posix.join('/mock-home', '.ohwow', 'workspaces');

  it('returns workspace name when daemon.token exists', async () => {
    mockExistsSync.mockImplementation((p) => {
      if (p === wsRoot) return true;
      if (p === path.posix.join(wsRoot, 'default', 'daemon.token')) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([
      { isDirectory: () => true, name: 'default' },
    ]);

    const { discoverWorkspaceNames } = await import('../workspace-registry.js');
    expect(discoverWorkspaceNames()).toEqual(['default']);
  });

  it('excludes directories that do NOT have daemon.token', async () => {
    mockExistsSync.mockImplementation((p) => {
      if (p === wsRoot) return true;
      // No daemon.token for any workspace
      return false;
    });
    mockReaddirSync.mockReturnValue([
      { isDirectory: () => true, name: 'default' },
    ]);

    const { discoverWorkspaceNames } = await import('../workspace-registry.js');
    expect(discoverWorkspaceNames()).toEqual([]);
  });

  it('returns multiple workspace names when multiple have daemon.token', async () => {
    const tokenDirs = new Set(['default', 'avenued', 'staging']);
    mockExistsSync.mockImplementation((p) => {
      if (p === wsRoot) return true;
      for (const name of tokenDirs) {
        if (p === path.posix.join(wsRoot, name, 'daemon.token')) return true;
      }
      return false;
    });
    mockReaddirSync.mockReturnValue([
      { isDirectory: () => true, name: 'default' },
      { isDirectory: () => true, name: 'avenued' },
      { isDirectory: () => true, name: 'staging' },
      { isDirectory: () => true, name: 'notoken' }, // no daemon.token — excluded
    ]);

    const { discoverWorkspaceNames } = await import('../workspace-registry.js');
    const names = discoverWorkspaceNames().sort();
    expect(names).toEqual(['avenued', 'default', 'staging']);
  });

  it('returns empty array when workspaces root does not exist', async () => {
    mockExistsSync.mockImplementation(() => false); // root doesn't exist

    const { discoverWorkspaceNames } = await import('../workspace-registry.js');
    expect(discoverWorkspaceNames()).toEqual([]);
  });

  it('excludes non-directory entries (files in workspaces dir)', async () => {
    mockExistsSync.mockImplementation((p) => {
      if (p === wsRoot) return true;
      if (p === path.posix.join(wsRoot, 'default', 'daemon.token')) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([
      { isDirectory: () => true, name: 'default' },
      { isDirectory: () => false, name: 'some-file.txt' }, // not a dir — excluded
    ]);

    const { discoverWorkspaceNames } = await import('../workspace-registry.js');
    expect(discoverWorkspaceNames()).toEqual(['default']);
  });
});
