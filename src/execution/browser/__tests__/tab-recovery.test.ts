import { describe, it, expect, vi } from 'vitest';

import { isTargetClosedError, withTabRecovery } from '../tab-recovery.js';

describe('isTargetClosedError', () => {
  it('matches each curated fragment case-insensitively as a substring', () => {
    const fragments = [
      'Target closed',
      'Target destroyed',
      'Session closed',
      'Page has been closed',
      'WebSocket is not open',
      'WebSocket not open', // raw-cdp's real wording
      'Disconnected from page',
      'Connection closed',
      'Attached to unexpected target',
    ];
    for (const phrase of fragments) {
      const embedded = new Error(`Protocol error (Page.navigate): ${phrase} after 1s`);
      expect(isTargetClosedError(embedded)).toBe(true);
      // And case variance should not matter.
      expect(isTargetClosedError(new Error(phrase.toUpperCase()))).toBe(true);
      expect(isTargetClosedError(new Error(phrase.toLowerCase()))).toBe(true);
    }
  });

  it('rejects unrelated errors', () => {
    expect(isTargetClosedError(new Error('ENOENT: no such file'))).toBe(false);
    expect(isTargetClosedError(new Error('timed out waiting for selector'))).toBe(false);
    expect(isTargetClosedError(new Error('X composer sidebar probe failed'))).toBe(false);
    expect(isTargetClosedError(null)).toBe(false);
    expect(isTargetClosedError(undefined)).toBe(false);
  });

  it('handles non-Error throwables', () => {
    expect(isTargetClosedError('Target closed unexpectedly')).toBe(true);
    expect(isTargetClosedError('not even close')).toBe(false);
    // Object with message field
    expect(isTargetClosedError({ message: 'session closed' })).toBe(true);
    // Object without message — stringifies to [object Object], no match.
    expect(isTargetClosedError({ foo: 1 })).toBe(false);
    // Object whose JSON contains a fragment still matches via JSON fallback.
    expect(isTargetClosedError({ detail: 'target destroyed' })).toBe(true);
    expect(isTargetClosedError(42)).toBe(false);
  });

  it('matches CDP JSON-RPC error objects with code -32000 + target...closed message', () => {
    expect(
      isTargetClosedError({ code: -32000, message: 'Target with given id was closed' }),
    ).toBe(true);
    // Same code but unrelated message — only the curated substring matches
    // are considered; -32000 alone is not enough.
    expect(
      isTargetClosedError({ code: -32000, message: 'Cannot find context' }),
    ).toBe(false);
    // Error wrapping the stringified CDP error (raw-cdp's serialization path)
    const wrapped = new Error(JSON.stringify({ code: -32000, message: 'Target was closed' }));
    expect(isTargetClosedError(wrapped)).toBe(true);
  });
});

describe('withTabRecovery', () => {
  interface AcquireHarness {
    acquire: () => Promise<{ page: { id: string }; targetId: string; release: () => void }>;
    readonly calls: number;
    readonly releases: number;
    readonly targetIds: readonly string[];
  }
  function makeAcquire(): AcquireHarness {
    const state = { calls: 0, releases: 0, targetIds: [] as string[] };
    const acquire = async () => {
      state.calls += 1;
      const targetId = `target-${state.calls}`;
      state.targetIds.push(targetId);
      return {
        page: { id: targetId },
        targetId,
        release: () => { state.releases += 1; },
      };
    };
    return {
      acquire,
      get calls() { return state.calls; },
      get releases() { return state.releases; },
      get targetIds() { return state.targetIds; },
    };
  }

  it('happy path: acquire once, fn succeeds, release once, returns result', async () => {
    const s = makeAcquire();
    const fn = vi.fn(async (page: { id: string }) => `ok:${page.id}`);
    const result = await withTabRecovery({ acquire: s.acquire, label: 'happy' }, fn);
    expect(result).toBe('ok:target-1');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(s.calls).toBe(1);
    expect(s.releases).toBe(1);
  });

  it('recovers from a target-closed error on first attempt', async () => {
    const s = makeAcquire();
    let callNo = 0;
    const fn = vi.fn(async (page: { id: string }) => {
      callNo += 1;
      if (callNo === 1) throw new Error('Protocol error: Target closed');
      return `ok:${page.id}`;
    });
    const result = await withTabRecovery({ acquire: s.acquire, label: 'recover' }, fn);
    expect(result).toBe('ok:target-2');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(s.calls).toBe(2);
    expect(s.releases).toBe(2);
    expect(s.targetIds).toEqual(['target-1', 'target-2']);
  });

  it('rethrows non-recoverable errors immediately and releases once', async () => {
    const s = makeAcquire();
    const boom = new Error('selector #post-button not found');
    const fn = vi.fn(async () => { throw boom; });
    await expect(
      withTabRecovery({ acquire: s.acquire, label: 'boom' }, fn),
    ).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(s.calls).toBe(1);
    expect(s.releases).toBe(1);
  });

  it('exhaustion: wraps the last error with the "gave up" prefix after maxRetries+1 attempts', async () => {
    const s = makeAcquire();
    const fn = vi.fn(async () => {
      throw new Error('Session closed: page gone');
    });
    await expect(
      withTabRecovery({ acquire: s.acquire, maxRetries: 2, label: 'exhaust' }, fn),
    ).rejects.toThrow(/^\[tab-recovery\] gave up after 3 attempts: Session closed: page gone/);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(s.calls).toBe(3);
    expect(s.releases).toBe(3);
  });

  it('preserves the original error via Error.cause on exhaustion', async () => {
    const s = makeAcquire();
    const original = new Error('target destroyed by user');
    const fn = vi.fn(async () => { throw original; });
    try {
      await withTabRecovery({ acquire: s.acquire, maxRetries: 1, label: 'cause' }, fn);
      expect.fail('expected throw');
    } catch (err) {
      expect((err as Error).message).toContain('gave up after 2 attempts');
      expect((err as Error & { cause?: unknown }).cause).toBe(original);
    }
  });

  it('defaults maxRetries to 2 (total 3 attempts)', async () => {
    const s = makeAcquire();
    const fn = vi.fn(async () => { throw new Error('target closed'); });
    await expect(
      withTabRecovery({ acquire: s.acquire }, fn),
    ).rejects.toThrow(/gave up after 3 attempts/);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
