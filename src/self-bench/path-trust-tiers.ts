/**
 * Layer 9 of the autonomous-fixing safety floor — per-directory trust
 * tiers.
 *
 * The capstone. Today the autonomous author can write to a narrow
 * sandbox (src/self-bench/experiments/ + a couple registries). Layer 9
 * is the mechanism that lets us widen the surface one directory at a
 * time, with tier-appropriate guarantees attached to each.
 *
 * Tiers
 * -----
 *   tier-1   Autonomous ok. The existing self-bench sandbox. Commits
 *            go through the usual gates; no extra requirements.
 *   tier-2   Autonomous ok BUT must carry a Fixes-Finding-Id trailer
 *            linking to a recent warning/fail finding whose
 *            affected_files intersects the patch. Layer 2 already
 *            implements the gate; Layer 9 turns it from opt-in into
 *            mandatory for tier-2 paths. Reserved for future bug-fix
 *            territory (formatters, pure utility helpers, etc).
 *   tier-3   Never autonomous. The default for everything not in the
 *            registry. Orchestrator, api, migrations, db, execution,
 *            everything load-bearing. Humans only.
 *
 * Today's registry assigns tier-1 to every current allowlist entry and
 * has ZERO tier-2 entries — so Layer 9 lands as pure infrastructure
 * with no behavior change. Future PRs add tier-2 paths one at a time,
 * each with an explicit rationale.
 *
 * Resolution
 * ----------
 * resolvePathTier uses longest-prefix match. `src/self-bench/` prefixes
 * are tier-1; anything else is tier-3 by default. A single path can
 * only match one registry entry — the longest prefix wins, so a
 * narrower tier-2 override inside a tier-1 dir is expressible if ever
 * needed.
 */

import path from 'node:path';

export type TrustTier = 'tier-1' | 'tier-2' | 'tier-3';

export interface PathTierEntry {
  /** Prefix, relative, forward-slashed. Prefix match — trailing slash recommended. */
  prefix: string;
  tier: Exclude<TrustTier, 'tier-3'>;
  /** One-sentence human-readable rationale. Shows up in refusal messages. */
  rationale: string;
}

const DEFAULT_REGISTRY: PathTierEntry[] = [
  {
    prefix: 'src/self-bench/experiments/',
    tier: 'tier-1',
    rationale:
      'self-bench experiment sandbox — probes are isolated from runtime code paths',
  },
  {
    prefix: 'src/self-bench/__tests__/',
    tier: 'tier-1',
    rationale: 'vitest tests for self-bench probes',
  },
  {
    prefix: 'src/self-bench/auto-registry.ts',
    tier: 'tier-1',
    rationale: 'append-only registry of autonomous probes',
  },
  {
    prefix: 'src/self-bench/registries/migration-schema-registry.ts',
    tier: 'tier-1',
    rationale: 'append-only migration-schema probe registry (Layer 1)',
  },
  {
    prefix: 'src/self-bench/registries/toolchain-test-registry.ts',
    tier: 'tier-1',
    rationale: 'append-only toolchain-test probe registry (Layer 1)',
  },
  // ─── First tier-2 entry — see Layer 9 audit log ────────────────────
  // Pure ms→string formatter, fully covered by
  // __tests__/format-duration.test.ts, single internal caller.
  // A patch here must carry a Fixes-Finding-Id trailer (Layer 2)
  // pointing at a recent warning|fail finding whose affected_files
  // intersects this path. The Layer 3 invariant suite blocks commits
  // that break the formatter test; Layer 4's AST bound limits the
  // patch to the single top-level `formatDuration` symbol; Layer 5b
  // cool-off + auto-revert close the heal cycle if the patch
  // misbehaves in production.
  {
    prefix: 'src/lib/format-duration.ts',
    tier: 'tier-2',
    rationale:
      'pure ms→string formatter, fully test-covered, single caller — first tier-2 trial',
  },
];

let registryOverride: PathTierEntry[] | null = null;

/**
 * Test-only injection for the tier registry. Tests override this to
 * exercise tier-2 behavior without committing real tier-2 paths to
 * the production registry. Pass null to clear.
 */
export function _setPathTierRegistryForTests(
  entries: PathTierEntry[] | null,
): void {
  registryOverride = entries;
}

function getRegistry(): PathTierEntry[] {
  return registryOverride ?? DEFAULT_REGISTRY;
}

/**
 * Resolve the trust tier for a repo-relative path. Longest prefix
 * match; defaults to tier-3 (deny-by-default). Path traversal and
 * absolute paths resolve to tier-3 so the caller's allowlist check
 * is the sole authority on them, not a subtle tier interaction.
 */
export function resolvePathTier(relPath: string): {
  tier: TrustTier;
  entry: PathTierEntry | null;
} {
  const normalized = path.normalize(relPath).replace(/\\/g, '/');
  if (normalized.includes('..') || normalized.startsWith('/') || path.isAbsolute(normalized)) {
    return { tier: 'tier-3', entry: null };
  }
  let best: PathTierEntry | null = null;
  for (const entry of getRegistry()) {
    if (normalized.startsWith(entry.prefix)) {
      if (best === null || entry.prefix.length > best.prefix.length) {
        best = entry;
      }
    }
  }
  if (best === null) return { tier: 'tier-3', entry: null };
  return { tier: best.tier, entry: best };
}

/**
 * Returns all allowed prefixes (tier-1 + tier-2). safeSelfCommit uses
 * this in place of the old hard-coded ALLOWED_PATH_PREFIXES so the
 * two stay in sync automatically.
 */
export function getAllowedPrefixes(): readonly string[] {
  return getRegistry()
    .filter((e) => e.tier === 'tier-1' || e.tier === 'tier-2')
    .map((e) => e.prefix);
}
