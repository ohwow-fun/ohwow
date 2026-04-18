/**
 * Browser-tab claims registry — task-scoped, atomic ownership of CDP page
 * targets inside the debug Chrome.
 *
 * Why this exists
 * ---------------
 * The old `ownedTargets: Set<string>` in chrome-profile-router encoded a
 * single bit per targetId ("some agent made this tab") with no notion of
 * WHICH task/session owned it. When two tasks fired against the same
 * profile concurrently — e.g. an x-posting cadence and an x-reply scan
 * overlapping — both would call `findExistingTabForHost + attachToPage`
 * on the same targetId and clobber each other's CDP sessions, producing
 * "Target detached" mid-compose or the wrong tweet typed into the other
 * task's tab.
 *
 * Claims fix the race: each call to `claimTarget` either wins the claim
 * (first in) or returns null (someone else owns it). The winning owner
 * holds it until `release()` or `releaseAllForOwner` runs. A task end
 * always releases, so claims don't outlive the tasks that created them.
 *
 * Atomicity: Node.js runs JS on a single thread, so a `map.has()` check
 * followed by a `map.set()` inside the SAME synchronous block executes
 * without interleaving. No locks needed; no async gap between check and
 * write. This is the whole point of keeping the helper tiny + sync.
 *
 * Process-scoped and in-memory. A daemon restart clears the registry —
 * by design; restart implies no in-flight tasks, so there are no claims
 * to preserve. We re-derive ownership from the DOM marker
 * (window.name='ohwow-owned') lazily on the next lookup if needed.
 */

export interface ClaimKey {
  /** Chrome profile directory name, e.g. 'Default' or 'Profile 1'. Namespaces the claim so two profiles can't collide on a shared targetId. */
  profileDir: string;
  /** CDP target id of the page (from `Target.getTargets`). */
  targetId: string;
}

export interface ClaimHandle {
  /** Opaque owner id — typically task id or session id. */
  owner: string;
  profileDir: string;
  targetId: string;
  claimedAt: number;
  /** Idempotent. Safe to call repeatedly; only the first call removes the claim. */
  release: () => void;
}

interface ClaimEntry {
  owner: string;
  claimedAt: number;
}

// Module-level state. One process = one registry. Map-keyed by
// `${profileDir}::${targetId}` — a plain string so map lookups stay O(1)
// and we don't need a custom hash.
const claims = new Map<string, ClaimEntry>();

function keyStr(key: ClaimKey): string {
  return `${key.profileDir}::${key.targetId}`;
}

/**
 * Atomic. Returns null when the key is already claimed by a DIFFERENT
 * owner. Re-claiming by the SAME owner returns a fresh handle that
 * releases the existing claim — idempotent semantics.
 *
 * Synchronous by design: the has()/set() pair runs without yielding
 * to the event loop, so two callers can't both win the same key.
 */
export function claimTarget(key: ClaimKey, owner: string): ClaimHandle | null {
  const k = keyStr(key);
  const existing = claims.get(k);
  if (existing && existing.owner !== owner) return null;
  const claimedAt = existing?.claimedAt ?? Date.now();
  if (!existing) claims.set(k, { owner, claimedAt });
  return {
    owner,
    profileDir: key.profileDir,
    targetId: key.targetId,
    claimedAt,
    release: () => {
      const current = claims.get(k);
      if (current && current.owner === owner) claims.delete(k);
    },
  };
}

/** Read-only lookup. Returns the current owner or null. */
export function currentOwner(key: ClaimKey): string | null {
  return claims.get(keyStr(key))?.owner ?? null;
}

/**
 * Quick "is this target claimed by anyone?" scan. Used by composer-
 * internal `isUsable` checks that don't know the profileDir (targetIds
 * are globally unique within the debug Chrome, so scanning by targetId
 * suffix is correct and cheap — the map is bounded by the number of
 * open agent tabs, typically <10).
 */
export function hasAnyClaimForTarget(targetId: string): boolean {
  const suffix = `::${targetId}`;
  for (const k of claims.keys()) {
    if (k.endsWith(suffix)) return true;
  }
  return false;
}

/** Release every claim held by `owner`. Returns the number released. */
export function releaseAllForOwner(owner: string): number {
  let n = 0;
  for (const [k, entry] of claims) {
    if (entry.owner === owner) {
      claims.delete(k);
      n++;
    }
  }
  return n;
}

/**
 * Release every claim for a given targetId (across profileDirs and
 * owners). Use when a tab is about to be closed — keeping a claim for
 * a dead target is meaningless and pollutes future lookups.
 */
export function releaseTarget(targetId: string): number {
  const suffix = `::${targetId}`;
  let n = 0;
  for (const k of claims.keys()) {
    if (k.endsWith(suffix)) {
      claims.delete(k);
      n++;
    }
  }
  return n;
}

/** Diagnostic snapshot, not live. Useful for dashboards + debugging. */
export function debugSnapshot(): Array<{ key: ClaimKey; owner: string; claimedAt: number }> {
  const out: Array<{ key: ClaimKey; owner: string; claimedAt: number }> = [];
  for (const [k, entry] of claims) {
    const sep = k.indexOf('::');
    const profileDir = sep >= 0 ? k.slice(0, sep) : '';
    const targetId = sep >= 0 ? k.slice(sep + 2) : k;
    out.push({ key: { profileDir, targetId }, owner: entry.owner, claimedAt: entry.claimedAt });
  }
  return out;
}
