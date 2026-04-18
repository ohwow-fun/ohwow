import { describe, it, expect, beforeEach } from 'vitest';
import {
  claimTarget,
  currentOwner,
  hasAnyClaimForTarget,
  releaseAllForOwner,
  releaseTarget,
  debugSnapshot,
} from '../browser-claims.js';

// Each test starts from a clean slate — releaseAllForOwner on every
// owner the prior test could have used. The module is singleton, so
// this matters even across `describe` blocks.
function resetClaims(): void {
  for (const entry of debugSnapshot()) releaseAllForOwner(entry.owner);
}

describe('browser-claims', () => {
  beforeEach(resetClaims);

  it('first claim wins; second caller with different owner gets null', () => {
    const h1 = claimTarget({ profileDir: 'Default', targetId: 't-1' }, 'task-a');
    expect(h1).not.toBeNull();
    const h2 = claimTarget({ profileDir: 'Default', targetId: 't-1' }, 'task-b');
    expect(h2).toBeNull();
  });

  it('re-claiming by the same owner is idempotent and returns a handle', () => {
    const h1 = claimTarget({ profileDir: 'Default', targetId: 't-1' }, 'task-a');
    const h2 = claimTarget({ profileDir: 'Default', targetId: 't-1' }, 'task-a');
    expect(h1).not.toBeNull();
    expect(h2).not.toBeNull();
    expect(h1!.claimedAt).toBe(h2!.claimedAt);
  });

  it('release() frees the claim so a different owner can take it', () => {
    const h1 = claimTarget({ profileDir: 'Default', targetId: 't-1' }, 'task-a');
    h1!.release();
    const h2 = claimTarget({ profileDir: 'Default', targetId: 't-1' }, 'task-b');
    expect(h2).not.toBeNull();
  });

  it('release() is idempotent — safe to call repeatedly', () => {
    const h1 = claimTarget({ profileDir: 'Default', targetId: 't-1' }, 'task-a');
    h1!.release();
    expect(() => h1!.release()).not.toThrow();
    expect(currentOwner({ profileDir: 'Default', targetId: 't-1' })).toBeNull();
  });

  it('profileDir namespaces the claim — same targetId across profiles is independent', () => {
    const h1 = claimTarget({ profileDir: 'Default', targetId: 't-1' }, 'task-a');
    const h2 = claimTarget({ profileDir: 'Profile 1', targetId: 't-1' }, 'task-b');
    expect(h1).not.toBeNull();
    expect(h2).not.toBeNull();
    expect(currentOwner({ profileDir: 'Default', targetId: 't-1' })).toBe('task-a');
    expect(currentOwner({ profileDir: 'Profile 1', targetId: 't-1' })).toBe('task-b');
  });

  it('hasAnyClaimForTarget scans across profileDirs', () => {
    expect(hasAnyClaimForTarget('t-1')).toBe(false);
    claimTarget({ profileDir: 'Default', targetId: 't-1' }, 'task-a');
    expect(hasAnyClaimForTarget('t-1')).toBe(true);
    expect(hasAnyClaimForTarget('t-2')).toBe(false);
  });

  it('releaseAllForOwner releases everything for that owner only', () => {
    claimTarget({ profileDir: 'Default', targetId: 't-1' }, 'task-a');
    claimTarget({ profileDir: 'Default', targetId: 't-2' }, 'task-a');
    claimTarget({ profileDir: 'Profile 1', targetId: 't-3' }, 'task-b');
    const released = releaseAllForOwner('task-a');
    expect(released).toBe(2);
    expect(currentOwner({ profileDir: 'Default', targetId: 't-1' })).toBeNull();
    expect(currentOwner({ profileDir: 'Default', targetId: 't-2' })).toBeNull();
    expect(currentOwner({ profileDir: 'Profile 1', targetId: 't-3' })).toBe('task-b');
  });

  it('releaseTarget releases every claim on that targetId across profileDirs/owners', () => {
    claimTarget({ profileDir: 'Default', targetId: 't-1' }, 'task-a');
    claimTarget({ profileDir: 'Profile 1', targetId: 't-1' }, 'task-b');
    claimTarget({ profileDir: 'Default', targetId: 't-2' }, 'task-a');
    const released = releaseTarget('t-1');
    expect(released).toBe(2);
    expect(currentOwner({ profileDir: 'Default', targetId: 't-1' })).toBeNull();
    expect(currentOwner({ profileDir: 'Profile 1', targetId: 't-1' })).toBeNull();
    expect(currentOwner({ profileDir: 'Default', targetId: 't-2' })).toBe('task-a');
  });
});
