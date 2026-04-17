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

/**
 * Permitted shape of an autonomous patch against a tier-2 path.
 *
 *   'whole-file'     — model returns full new file contents. Layer 4
 *                      AST-bound gate restricts changes to one
 *                      top-level symbol. Suits pure utility files
 *                      small enough to rewrite safely.
 *   'string-literal' — model returns a JSON list of find/replace
 *                      edits. Layer 4 gate verifies (via TS compiler)
 *                      that only string-literal, template-literal
 *                      chunk, and JSX-text nodes differ between
 *                      before/after — every other AST node is
 *                      structurally identical. Suits UI source files
 *                      that are too big to rewrite but that we want
 *                      to heal at copy-level granularity.
 */
export type TierPatchMode = 'whole-file' | 'string-literal';

export interface PathTierEntry {
  /** Prefix, relative, forward-slashed. Prefix match — trailing slash recommended. */
  prefix: string;
  tier: Exclude<TrustTier, 'tier-3'>;
  /** One-sentence human-readable rationale. Shows up in refusal messages. */
  rationale: string;
  /**
   * How autonomous patches against this path must be shaped. Defaults
   * to 'whole-file' for backward compatibility with the existing
   * pure-util tier-2 entries.
   */
  patchMode?: TierPatchMode;
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
  // Tier-2 wave 2 — each paired with a property fuzz under
  // src/self-bench/experiments/*-fuzz.ts that emits findings with
  // evidence.affected_files pointing at the matching path.
  {
    prefix: 'src/lib/token-similarity.ts',
    tier: 'tier-2',
    rationale:
      'pure jaccard + normalize, fuzzed by token-similarity-fuzz (symmetry, range, idempotence)',
  },
  {
    prefix: 'src/lib/stagnation.ts',
    tier: 'tier-2',
    rationale:
      'pure hash + sliding-window predicate, fuzzed by stagnation-fuzz (md5 shape, detect contract)',
  },
  {
    prefix: 'src/lib/error-classification.ts',
    tier: 'tier-2',
    rationale:
      'pure error→category dispatch, fuzzed by error-classification-fuzz (totality + fixtures + retry-contract)',
  },
  // Components that carry user-facing copy and are safe for string-literal
  // patching (structure is frozen by the Layer 4 skeleton gate).
  {
    prefix: 'src/web/src/components/ErrorBoundary.tsx',
    tier: 'tier-2',
    patchMode: 'string-literal',
    rationale:
      'error boundary fallback copy — structure is a single render method, copy-only edits safe',
  },
  // Phase 1 of the revenue-path widening: outreach-policy is the one
  // gate every outbound channel consults before sending. DEFAULT_COOLDOWN_HOURS,
  // the per-channel resolver, and COOLDOWN_EVENT_KINDS are exactly the
  // knobs the revenue bucket should be able to heal autonomously. Pure
  // helpers + DB reads, well-covered contract; fuzzed by
  // outreach-policy-fuzz which emits affected_files on any invariant
  // regression (range, positivity, override handling, core event kinds).
  {
    prefix: 'src/lib/outreach-policy.ts',
    tier: 'tier-2',
    rationale:
      'cooldown policy gate for every outbound channel — tier-2 whole-file so the loop can autonomously tune cooldown hours + event-kind set, fuzzed by outreach-policy-fuzz',
  },
  // Cross-domain tier-2: outreach-thermostat's draft-message template is
  // the copy surface the operator rejects most often (see Phase 2
  // context-pack's operator-rejections section). The Layer 4 string-
  // literal gate freezes every AST node except StringLiteral /
  // NoSubstitutionTemplateLiteral / TemplateHead|Middle|Tail so the
  // author can only edit the message bodies, not the control flow that
  // picks a channel or applies a cooldown. Combined with tier-2's
  // Fixes-Finding-Id receipt gate + Layer 5 auto-revert + the new
  // Cites-Sales-Signal trailer, this is the first file where the
  // autonomous loop can close a true cross-domain feedback cycle:
  // operator rejection → finding → copy rewrite → next tick's rejection
  // rate moves.
  {
    prefix: 'src/self-bench/experiments/outreach-thermostat.ts',
    tier: 'tier-2',
    patchMode: 'string-literal',
    rationale:
      'outreach draft-message copy — string-literal-only edits heal the patterns the operator keeps rejecting (Phase 4 cross-domain surface)',
  },
  // UI pages — bulk-promoted under string-literal patch mode. The
  // Layer 4 AST skeleton gate (patch-string-literal-bounds.ts) is
  // the load-bearing safety here: only StringLiteral /
  // NoSubstitutionTemplateLiteral / TemplateHead|Middle|Tail /
  // JsxText node contents may differ between pre-write and post-
  // write. Component structure, imports, identifiers, JSX attrs,
  // booleans, numerics — all frozen. Widening the prefix from one
  // named file (Agents.tsx) to the whole pages/ tree trades the
  // "review per file" norm for faster copy healing; the gate's
  // guarantee doesn't weaken with surface area.
  {
    prefix: 'src/web/src/pages/',
    tier: 'tier-2',
    patchMode: 'string-literal',
    rationale:
      'dashboard pages tree, copy-level edits only — Layer 4 skeleton gate freezes structure/imports/identifiers',
  },
  // Autonomous-loop status doc suite. Hand-split into index + two
  // companions so the updater can touch a specific surface instead of
  // rewriting a monolith. Rewritten whole-file by
  // RoadmapUpdaterExperiment when the live loop state drifts from
  // what the docs say. Layer 4 AST gate is a no-op for non-TS files
  // (see self-commit.ts step 3b); safety envelope is the tier-2
  // Fixes-Finding-Id trailer + typecheck/test gates + cool-off.
  {
    prefix: 'AUTONOMY_ROADMAP.md',
    tier: 'tier-2',
    patchMode: 'whole-file',
    rationale:
      'autonomous-loop top-level index — Active Focus + Next Steps rewrites by RoadmapUpdaterExperiment',
  },
  {
    prefix: 'roadmap/gaps.md',
    tier: 'tier-2',
    patchMode: 'whole-file',
    rationale:
      'autonomous-loop Known Gaps companion — whole-file rewrites by RoadmapUpdaterExperiment',
  },
  {
    prefix: 'roadmap/iteration-log.md',
    tier: 'tier-2',
    patchMode: 'whole-file',
    rationale:
      'autonomous-loop Recent Iterations companion — whole-file rewrites by RoadmapUpdaterExperiment',
  },
  // Generic tier-2 entry for any future markdown file the updater
  // decides to author inside roadmap/. New-file creation under this
  // prefix is gated by ~/.ohwow/roadmap-restructure-disabled
  // (opt-out) in self-commit.ts; existing-file edits on the three
  // explicit companions above always work regardless. The
  // roadmap-shape-probe gate (L4c in self-commit) auto-reverts any
  // patch that breaks the cross-link graph so new files can't orphan
  // the suite silently.
  {
    prefix: 'roadmap/',
    tier: 'tier-2',
    patchMode: 'whole-file',
    rationale:
      'roadmap/ companion directory — new companion files the updater may author (opt-out via kill switch)',
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
 * Resolve the patch mode declared by the longest-prefix tier-2 entry
 * covering `relPath`. Tier-1 and tier-3 paths return 'whole-file' —
 * tier-1 paths are always create-only (no patch) so the mode is moot,
 * and tier-3 is refused upstream. Entries without an explicit
 * patchMode default to 'whole-file' (the historical behavior).
 */
export function resolvePatchMode(relPath: string): TierPatchMode {
  const { entry } = resolvePathTier(relPath);
  if (!entry) return 'whole-file';
  return entry.patchMode ?? 'whole-file';
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
