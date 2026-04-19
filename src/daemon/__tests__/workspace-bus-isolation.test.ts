/**
 * TEST B — Bus isolation
 *
 * Critical invariant: two WorkspaceContexts MUST have independent buses.
 * An event emitted on workspace-A's bus must NOT fire any listener
 * registered on workspace-B's bus.
 *
 * This is the most important test in the Phase 2 QA suite. If it fails,
 * the multi-workspace daemon has a cross-workspace event leak bug.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypedEventBus } from '../../lib/typed-event-bus.js';
import { WorkspaceRegistry } from '../workspace-registry.js';
import type { WorkspaceContext } from '../workspace-context.js';
import type { RuntimeEvents } from '../../tui/types.js';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWsCtx(name: string, bus: TypedEventBus<RuntimeEvents>): WorkspaceContext {
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
    scheduler: null,
    proactiveEngine: null,
    connectorSyncScheduler: null,
    controlPlane: null,
    bus,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkspaceContext bus isolation', () => {
  let busA: TypedEventBus<RuntimeEvents>;
  let busB: TypedEventBus<RuntimeEvents>;
  let ctxA: WorkspaceContext;
  let ctxB: WorkspaceContext;
  let registry: WorkspaceRegistry;

  beforeEach(() => {
    busA = new TypedEventBus<RuntimeEvents>();
    busB = new TypedEventBus<RuntimeEvents>();
    ctxA = makeWsCtx('default', busA);
    ctxB = makeWsCtx('avenued', busB);
    registry = new WorkspaceRegistry();
    registry.register(ctxA);
    registry.register(ctxB);
  });

  it('each workspace gets a distinct bus instance', () => {
    expect(registry.get('default').bus).toBe(busA);
    expect(registry.get('avenued').bus).toBe(busB);
    expect(registry.get('default').bus).not.toBe(registry.get('avenued').bus);
  });

  it('event emitted on bus A fires listener on bus A', () => {
    const listenerA = vi.fn();
    busA.on('shutdown', listenerA);

    busA.emit('shutdown', undefined as unknown as RuntimeEvents['shutdown']);

    expect(listenerA).toHaveBeenCalledOnce();
  });

  it('event emitted on bus A does NOT fire listener on bus B', () => {
    const listenerB = vi.fn();
    busB.on('shutdown', listenerB);

    busA.emit('shutdown', undefined as unknown as RuntimeEvents['shutdown']);

    expect(listenerB).not.toHaveBeenCalled();
  });

  it('event emitted on bus B does NOT fire listener on bus A', () => {
    const listenerA = vi.fn();
    busA.on('shutdown', listenerA);

    busB.emit('shutdown', undefined as unknown as RuntimeEvents['shutdown']);

    expect(listenerA).not.toHaveBeenCalled();
  });

  it('each bus independently fires only its own listeners when both receive the same event', () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    busA.on('shutdown', listenerA);
    busB.on('shutdown', listenerB);

    busA.emit('shutdown', undefined as unknown as RuntimeEvents['shutdown']);

    expect(listenerA).toHaveBeenCalledOnce();
    expect(listenerB).not.toHaveBeenCalled();

    busB.emit('shutdown', undefined as unknown as RuntimeEvents['shutdown']);

    expect(listenerA).toHaveBeenCalledOnce(); // still once — not called again
    expect(listenerB).toHaveBeenCalledOnce();
  });

  it('bus instances retrieved from registry are the same objects that were registered', () => {
    // Verify registry does not wrap or replace bus instances
    expect(registry.get('default').bus).toBe(busA);
    expect(registry.get('avenued').bus).toBe(busB);
  });
});
