/**
 * Regression test: profileDir key-match requirement in claim registry.
 *
 * Bug being pinned: getCdpPage / getCdpPageForPlatform called claimTarget
 * with profileDir set to the browserContextId UUID (e.g.
 * "c3d2a1b0-f09e-4f7a-8e1d-0123456789ab") instead of the filesystem
 * profile directory (e.g. "Profile 1"). findReusableTabForHost also uses
 * the filesystem profileDir to build its lookup key. The mismatch meant
 * composer-opened tabs were invisible to the reuse check — every call
 * opened a new tab instead of reusing the one it just opened.
 *
 * Fix landed in: e36a6fd (getCdpPage + getCdpPageForPlatform + 5 caller
 * files). This file freezes the invariant so a future regression is
 * caught at the unit level before it reaches production.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  claimTarget,
  currentOwner,
  releaseAllForOwner,
  debugSnapshot,
} from '../browser-claims.js';

// Reset the singleton registry between tests.
function resetClaims(): void {
  for (const entry of debugSnapshot()) releaseAllForOwner(entry.owner);
}

const FILESYSTEM_PROFILE_DIR = 'Profile 1';
const UUID_CONTEXT_ID = 'c3d2a1b0-f09e-4f7a-8e1d-0123456789ab';
const TARGET_ID = 'deadbeef-cafe-1234-abcd-000000000001';
const COMPOSER_OWNER = 'x-composer:12345';
const REUSE_OWNER = 'x-posting-executor:task-99';

describe('browser-claims profileDir key-match regression', () => {
  beforeEach(resetClaims);

  it('UUID profileDir does NOT match filesystem profileDir lookup — key-mismatch bug is detectable', () => {
    // Simulate the OLD broken behavior: composer claims with UUID profileDir.
    claimTarget({ profileDir: UUID_CONTEXT_ID, targetId: TARGET_ID }, COMPOSER_OWNER);

    // findReusableTabForHost looks up by filesystem profileDir.
    // It should find NOTHING — the keys don't match.
    const owner = currentOwner({ profileDir: FILESYSTEM_PROFILE_DIR, targetId: TARGET_ID });
    expect(owner).toBeNull();

    // Confirm the claim does exist under the wrong key.
    const ownerUnderUuid = currentOwner({ profileDir: UUID_CONTEXT_ID, targetId: TARGET_ID });
    expect(ownerUnderUuid).toBe(COMPOSER_OWNER);
  });

  it('filesystem profileDir DOES match filesystem profileDir lookup — fixed path is correct', () => {
    // Simulate the FIXED behavior: composer claims with filesystem profileDir.
    claimTarget({ profileDir: FILESYSTEM_PROFILE_DIR, targetId: TARGET_ID }, COMPOSER_OWNER);

    // findReusableTabForHost looks up by filesystem profileDir.
    // It should find the claim — the keys match.
    const owner = currentOwner({ profileDir: FILESYSTEM_PROFILE_DIR, targetId: TARGET_ID });
    expect(owner).toBe(COMPOSER_OWNER);
  });

  it('same-owner reclaim by filesystem profileDir succeeds when claim was registered with filesystem profileDir', () => {
    // Composer opens tab and claims it.
    const composerHandle = claimTarget(
      { profileDir: FILESYSTEM_PROFILE_DIR, targetId: TARGET_ID },
      COMPOSER_OWNER,
    );
    expect(composerHandle).not.toBeNull();

    // A different executor task cannot steal it.
    const stolenHandle = claimTarget(
      { profileDir: FILESYSTEM_PROFILE_DIR, targetId: TARGET_ID },
      REUSE_OWNER,
    );
    expect(stolenHandle).toBeNull();

    // Lookup by filesystem profileDir confirms original owner.
    const existingOwner = currentOwner({ profileDir: FILESYSTEM_PROFILE_DIR, targetId: TARGET_ID });
    expect(existingOwner).toBe(COMPOSER_OWNER);
  });

  it('after composer releases, executor can claim by filesystem profileDir', () => {
    // Composer opens tab and claims it.
    const composerHandle = claimTarget(
      { profileDir: FILESYSTEM_PROFILE_DIR, targetId: TARGET_ID },
      COMPOSER_OWNER,
    );
    expect(composerHandle).not.toBeNull();

    // Composer releases (e.g. at end of its async work unit).
    composerHandle!.release();

    // Now the executor can claim by the same filesystem profileDir key.
    const executorHandle = claimTarget(
      { profileDir: FILESYSTEM_PROFILE_DIR, targetId: TARGET_ID },
      REUSE_OWNER,
    );
    expect(executorHandle).not.toBeNull();
    expect(executorHandle!.owner).toBe(REUSE_OWNER);
  });

  it('__composer_unpinned__ sentinel is distinct from both UUID and filesystem profileDir', () => {
    // The sentinel is used by the no-context fallback path in x-posting.ts
    // and social-cdp-helpers.ts. Verify it never accidentally collides with
    // a real filesystem or UUID key.
    claimTarget({ profileDir: '__composer_unpinned__', targetId: TARGET_ID }, COMPOSER_OWNER);

    expect(currentOwner({ profileDir: FILESYSTEM_PROFILE_DIR, targetId: TARGET_ID })).toBeNull();
    expect(currentOwner({ profileDir: UUID_CONTEXT_ID, targetId: TARGET_ID })).toBeNull();
    expect(currentOwner({ profileDir: '__composer_unpinned__', targetId: TARGET_ID })).toBe(COMPOSER_OWNER);
  });
});
