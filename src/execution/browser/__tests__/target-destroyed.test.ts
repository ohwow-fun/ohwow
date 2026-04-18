import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  claimTarget,
  currentOwner,
  debugSnapshot,
  releaseAllForOwner,
} from '../browser-claims.js';
import { ensureTargetDestroyedSubscription } from '../chrome-profile-router.js';
import type { RawCdpBrowser } from '../raw-cdp.js';

/**
 * These tests verify the target-destroyed → releaseByTargetId wiring
 * without requiring a live Chrome. A fake RawCdpBrowser-shaped object
 * records the listener registered via `.on('Target.targetDestroyed', ...)`
 * and a test helper invokes it directly to simulate the CDP event.
 *
 * We also verify:
 *   - `Target.setDiscoverTargets({discover: true})` is sent on subscribe
 *     (required by the CDP spec; without it targetDestroyed never fires)
 *   - Double-subscription on the same browser instance is a no-op
 *     (the module-level WeakSet guard)
 */

function resetClaims(): void {
  for (const entry of debugSnapshot()) releaseAllForOwner(entry.owner);
}

interface FakeBrowser {
  listeners: Array<(params: unknown, sessionId?: string) => void>;
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  fireDestroyed(targetId: string): void;
}

function makeFakeBrowser(): FakeBrowser {
  const fake: FakeBrowser = {
    listeners: [],
    send: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((_method: string, handler: (params: unknown, sessionId?: string) => void) => {
      fake.listeners.push(handler);
      return () => {
        const idx = fake.listeners.indexOf(handler);
        if (idx >= 0) fake.listeners.splice(idx, 1);
      };
    }),
    fireDestroyed(targetId: string) {
      for (const l of fake.listeners) l({ targetId });
    },
  };
  return fake;
}

function asBrowser(fake: FakeBrowser): RawCdpBrowser {
  return fake as unknown as RawCdpBrowser;
}

describe('ensureTargetDestroyedSubscription', () => {
  beforeEach(resetClaims);

  it('registers a Target.targetDestroyed listener and enables target discovery', async () => {
    const fake = makeFakeBrowser();
    await ensureTargetDestroyedSubscription(asBrowser(fake));

    expect(fake.on).toHaveBeenCalledWith('Target.targetDestroyed', expect.any(Function));
    expect(fake.send).toHaveBeenCalledWith('Target.setDiscoverTargets', { discover: true });
  });

  it('releases claims for the destroyed targetId when the CDP event fires', async () => {
    const fake = makeFakeBrowser();
    await ensureTargetDestroyedSubscription(asBrowser(fake));

    claimTarget({ profileDir: 'Default', targetId: 't-closed' }, 'task-a');
    claimTarget({ profileDir: 'Default', targetId: 't-alive' }, 'task-a');

    fake.fireDestroyed('t-closed');

    expect(currentOwner({ profileDir: 'Default', targetId: 't-closed' })).toBeNull();
    expect(currentOwner({ profileDir: 'Default', targetId: 't-alive' })).toBe('task-a');
  });

  it('is idempotent when the destroyed target has no outstanding claim', async () => {
    const fake = makeFakeBrowser();
    await ensureTargetDestroyedSubscription(asBrowser(fake));

    // Nothing claimed. Event for an unknown target must not throw.
    expect(() => fake.fireDestroyed('t-unknown')).not.toThrow();
  });

  it('releases every profileDir-scoped claim for the destroyed targetId', async () => {
    const fake = makeFakeBrowser();
    await ensureTargetDestroyedSubscription(asBrowser(fake));

    claimTarget({ profileDir: 'Default', targetId: 't-shared' }, 'task-a');
    claimTarget({ profileDir: 'Profile 1', targetId: 't-shared' }, 'task-b');

    fake.fireDestroyed('t-shared');

    expect(currentOwner({ profileDir: 'Default', targetId: 't-shared' })).toBeNull();
    expect(currentOwner({ profileDir: 'Profile 1', targetId: 't-shared' })).toBeNull();
  });

  it('does not double-subscribe on the same browser instance', async () => {
    const fake = makeFakeBrowser();
    await ensureTargetDestroyedSubscription(asBrowser(fake));
    await ensureTargetDestroyedSubscription(asBrowser(fake));

    // Exactly one listener registered; exactly one discovery enable.
    expect(fake.on).toHaveBeenCalledTimes(1);
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.listeners).toHaveLength(1);
  });

  it('ignores malformed event payloads without throwing', async () => {
    const fake = makeFakeBrowser();
    await ensureTargetDestroyedSubscription(asBrowser(fake));

    claimTarget({ profileDir: 'Default', targetId: 't-1' }, 'task-a');
    for (const l of fake.listeners) {
      // Missing targetId
      expect(() => l({})).not.toThrow();
      // Non-string targetId
      expect(() => l({ targetId: 42 })).not.toThrow();
      // Null payload
      expect(() => l(null)).not.toThrow();
    }
    // Claim should still be intact.
    expect(currentOwner({ profileDir: 'Default', targetId: 't-1' })).toBe('task-a');
  });

  it('survives a setDiscoverTargets error and still registers the listener', async () => {
    const fake = makeFakeBrowser();
    fake.send.mockRejectedValueOnce(new Error('discover failed'));

    await expect(
      ensureTargetDestroyedSubscription(asBrowser(fake)),
    ).resolves.toBeUndefined();

    // Listener is registered even though setDiscoverTargets failed —
    // the subscription itself is the valuable part; Chrome may have
    // discovery enabled from another path.
    expect(fake.on).toHaveBeenCalledWith('Target.targetDestroyed', expect.any(Function));

    claimTarget({ profileDir: 'Default', targetId: 't-1' }, 'task-a');
    fake.fireDestroyed('t-1');
    expect(currentOwner({ profileDir: 'Default', targetId: 't-1' })).toBeNull();
  });
});
