import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock `raw-cdp` before importing the module under test so
// `RawCdpBrowser.connect` returns a fake we can steer per test.
const fakeTargetsRef: { current: Array<{ targetId: string; type: string; url: string; browserContextId?: string }> } = {
  current: [],
};

const fakePage = {
  installUnloadEscapes: vi.fn().mockResolvedValue(undefined),
  url: vi.fn().mockResolvedValue('about:blank'),
  goto: vi.fn().mockResolvedValue(undefined),
  close: vi.fn(),
};

const fakeRawBrowser = {
  getTargets: vi.fn(async () => fakeTargetsRef.current),
  attachToPage: vi.fn(async () => fakePage),
  close: vi.fn(),
};

vi.mock('../raw-cdp.js', () => ({
  RawCdpBrowser: {
    connect: vi.fn(async () => fakeRawBrowser),
  },
}));

// `ensureCdpBrowser` in the module under test wraps RawCdpBrowser.connect,
// which is already mocked. But it also calls `ensureDebugChrome` when
// `spawnIfDown` is true. `findReusableTabForHost` passes `spawnIfDown: false`,
// so we don't need to mock chrome-lifecycle for this test.

import { findReusableTabForHost } from '../chrome-profile-router.js';
import { claimTarget, releaseAllForOwner } from '../browser-claims.js';

beforeEach(() => {
  fakeTargetsRef.current = [];
  fakeRawBrowser.getTargets.mockClear();
  fakeRawBrowser.attachToPage.mockClear();
  fakeRawBrowser.close.mockClear();
  fakePage.goto.mockClear();
});

describe('findReusableTabForHost — context + ownership filtering', () => {
  it('skips tabs whose browserContextId does not match expectedBrowserContextId', async () => {
    fakeTargetsRef.current = [
      { targetId: 'human-tab', type: 'page', url: 'https://www.threads.com/someone', browserContextId: 'ctx-profile-B' },
    ];

    const result = await findReusableTabForHost({
      hostMatch: 'threads.com',
      profileDir: 'Profile A',
      owner: 'task-1',
      expectedBrowserContextId: 'ctx-profile-A',
    });

    expect(result).toBeNull();
    expect(fakeRawBrowser.attachToPage).not.toHaveBeenCalled();
  });

  it('claims and returns a tab whose browserContextId matches', async () => {
    fakeTargetsRef.current = [
      { targetId: 'agent-tab', type: 'page', url: 'https://www.threads.com/', browserContextId: 'ctx-profile-A' },
    ];

    const result = await findReusableTabForHost({
      hostMatch: 'threads.com',
      profileDir: 'Profile A',
      owner: 'task-2',
      expectedBrowserContextId: 'ctx-profile-A',
    });

    expect(result).not.toBeNull();
    expect(result?.targetId).toBe('agent-tab');
    expect(fakeRawBrowser.attachToPage).toHaveBeenCalledWith('agent-tab');

    // Cleanup: release the claim this test created so other tests
    // don't see a stale {Profile A, agent-tab} → task-2 entry.
    releaseAllForOwner('task-2');
  });

  it('with ownershipMode="ours" refuses to claim a tab that has no prior claim', async () => {
    fakeTargetsRef.current = [
      { targetId: 'human-tab', type: 'page', url: 'https://www.threads.com/', browserContextId: 'ctx-profile-A' },
    ];

    const result = await findReusableTabForHost({
      hostMatch: 'threads.com',
      profileDir: 'Profile A',
      owner: 'task-3',
      expectedBrowserContextId: 'ctx-profile-A',
      ownershipMode: 'ours',
    });

    expect(result).toBeNull();
    expect(fakeRawBrowser.attachToPage).not.toHaveBeenCalled();
  });

  it('with ownershipMode="ours" reuses a tab that already holds a claim', async () => {
    // Pre-seed a claim so hasAnyClaimForTarget returns true.
    const preClaim = claimTarget({ profileDir: 'persistent', targetId: 'agent-tab-owned' }, 'persistent-owner');
    expect(preClaim).not.toBeNull();

    fakeTargetsRef.current = [
      { targetId: 'agent-tab-owned', type: 'page', url: 'https://www.threads.com/', browserContextId: 'ctx-profile-A' },
    ];

    const result = await findReusableTabForHost({
      hostMatch: 'threads.com',
      profileDir: 'Profile A',
      owner: 'task-4',
      expectedBrowserContextId: 'ctx-profile-A',
      ownershipMode: 'ours',
    });

    expect(result).not.toBeNull();
    expect(result?.targetId).toBe('agent-tab-owned');

    // Cleanup.
    preClaim?.release();
    releaseAllForOwner('task-4');
  });
});
