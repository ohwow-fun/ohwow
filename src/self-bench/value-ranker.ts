/**
 * value-ranker — pure scoring for patch-author candidate selection.
 *
 * Before this module, patch-author picked the first candidate in
 * iteration order — which in practice meant "most-recently-written
 * finding wins." That's cheap but blind to what's actually valuable
 * to the operator. A copy-lint warning for a rarely-viewed dashboard
 * page would outrank an attribution observer warning that the
 * market_signal bucket converts at 0%.
 *
 * The ranker moves the loop closer to the operator's intuition by
 * weighting four signals:
 *
 *   revenue_proximity  (+3x)  does this finding touch the sales funnel?
 *                             (attribution paths, outreach paths, goal
 *                             subjects, revenue-observer experiment ids)
 *   evidence_strength  (+2x)  how many OTHER findings point at the same
 *                             subject or affected files? A single flake
 *                             is worth less than a repeated pattern.
 *   blast_radius       (-1x)  how risky is the surface? Tier-1 sandbox
 *                             is near-free; tier-2 runtime paths carry
 *                             some cost.
 *   recency            (+1x)  fresher findings beat stale ones — linear
 *                             decay to zero over 7 days.
 *
 * Candidates recently reverted (patches_attempted_log) are filtered
 * out UPSTREAM in patch-author's probe. The ranker trusts its input
 * and doesn't re-read the log.
 *
 * Pure: no DB access, no fs reads, no side effects. A mock input
 * produces the same ranking across runs.
 */

import { resolvePathTier } from './path-trust-tiers.js';

export interface RankableCandidate {
  findingId: string;
  experimentId: string;
  subject: string | null;
  /** ISO timestamp when the finding was observed. */
  ranAt: string;
  /** Files the candidate patch would touch (tier-2 allowlisted). */
  tier2Files: string[];
}

export interface EvidencePointer {
  subject: string | null;
  affectedFiles: string[];
}

export interface ScoreBreakdown {
  revenue_proximity: number;
  evidence_strength: number;
  blast_radius: number;
  recency: number;
  /** Phase 6 — 1 when at least one active priority's tag intersects the candidate's signals. */
  priority_match: number;
}

export interface RankedCandidate<T extends RankableCandidate> {
  candidate: T;
  score: number;
  breakdown: ScoreBreakdown;
  rationale: string[];
}

export interface RankInput<T extends RankableCandidate> {
  candidates: readonly T[];
  /**
   * Other findings from the recent window used to compute
   * evidence_strength. Each candidate's subject/files are counted
   * against this list.
   */
  otherFindings?: readonly EvidencePointer[];
  /**
   * Flattened tag list drawn from operator-authored active priorities.
   * A candidate whose subject / experiment id / touched path contains
   * any of these tags (case-insensitive substring) gets the
   * priority_match bonus. Empty/missing = no bonus.
   */
  priorityTags?: readonly string[];
  /** Clock injection for tests. Defaults to `new Date()`. */
  now?: Date;
}

/** Weights on each component. Tuned so revenue_proximity dominates a single-finding baseline. */
const WEIGHT = {
  revenue_proximity: 3,
  evidence_strength: 2,
  blast_radius: -1,
  recency: 1,
  // Priority match is a direct operator override. Weighted alongside
  // evidence_strength — a priority-tagged candidate beats a single-
  // corroboration one, and combined with revenue-proximity it dominates.
  priority_match: 2,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Recency decays linearly to zero across this many days. */
const RECENCY_HALF_LIFE_DAYS = 7;
/** Cap evidence-strength score at this count to avoid runaway. */
const MAX_EVIDENCE_COUNT = 5;

/**
 * Revenue-proximal path prefixes. Any candidate whose tier2Files
 * include a match of any of these gets the full revenue_proximity
 * bonus. Ordered specific-first for readability — all match via
 * startsWith.
 */
const REVENUE_PROXIMAL_PATH_PREFIXES = [
  'src/api/routes/attribution',
  'src/webhooks/stripe-subscription',
  'src/self-bench/experiments/attribution-observer',
  'src/self-bench/experiments/outreach-',
  'src/self-bench/experiments/revenue-',
  'src/self-bench/experiments/x-engagement-observer',
  'src/self-bench/experiments/x-dm-signals-rollup',
  'src/lib/outreach-policy',
  'src/lib/posted-text-log',
  'src/lib/x-dm-dispatch-config',
  'scripts/x-experiments/',
] as const;

/**
 * Revenue-proximal experiment ids. A finding written by any of these
 * experiments is treated as revenue-proximal even if its
 * affected_files miss the path prefixes above.
 */
const REVENUE_PROXIMAL_EXPERIMENT_IDS = new Set([
  'attribution-observer',
  'revenue-pipeline-observer',
  'outreach-thermostat',
  'x-engagement-observer',
  'x-ops-observer',
  'x-dm-signals-rollup',
  'content-cadence-loop-health',
  'content-cadence-tuner',
]);

/**
 * Revenue-proximal subject prefixes. Finding subjects of the form
 * "attribution:...", "goal:...", "revenue:...", "funnel:..." are
 * sales-side signals by construction.
 */
const REVENUE_PROXIMAL_SUBJECT_PREFIXES = [
  'attribution:',
  'goal:',
  'revenue:',
  'funnel:',
  'bucket:',
] as const;

function isRevenueProximalPath(p: string): boolean {
  return REVENUE_PROXIMAL_PATH_PREFIXES.some((prefix) => p.startsWith(prefix));
}

function scoreRevenueProximity<T extends RankableCandidate>(c: T): number {
  if (REVENUE_PROXIMAL_EXPERIMENT_IDS.has(c.experimentId)) return 1;
  if (c.subject && REVENUE_PROXIMAL_SUBJECT_PREFIXES.some((p) => c.subject!.startsWith(p))) return 1;
  if (c.tier2Files.some(isRevenueProximalPath)) return 1;
  return 0;
}

function scoreEvidenceStrength<T extends RankableCandidate>(
  c: T,
  others: readonly EvidencePointer[],
): number {
  if (others.length === 0) return 0;
  const candidateFiles = new Set(c.tier2Files);
  let hits = 0;
  for (const o of others) {
    // Don't double-count the candidate's own finding if it appears in others.
    if (o.subject && c.subject && o.subject === c.subject) {
      hits += 1;
      continue;
    }
    for (const f of o.affectedFiles) {
      if (candidateFiles.has(f)) {
        hits += 1;
        break;
      }
    }
  }
  return Math.min(hits, MAX_EVIDENCE_COUNT) / MAX_EVIDENCE_COUNT;
}

function scoreBlastRadius<T extends RankableCandidate>(c: T): number {
  // Use the HIGHEST-risk tier across touched files. A candidate that
  // spans tier-1 and tier-2 paths is rated by its tier-2 surface.
  let worst = 0;
  for (const f of c.tier2Files) {
    const tier = resolvePathTier(f).tier;
    if (tier === 'tier-2') worst = Math.max(worst, 0.75);
    else if (tier === 'tier-1') worst = Math.max(worst, 0.25);
    // tier-3 should have been filtered upstream; if we see one, treat
    // as maximum blast radius so the score collapses.
    else if (tier === 'tier-3') worst = Math.max(worst, 1.0);
  }
  return worst;
}

function scoreRecency<T extends RankableCandidate>(c: T, now: Date): number {
  const ranAtMs = Date.parse(c.ranAt);
  if (!Number.isFinite(ranAtMs)) return 0;
  const ageDays = Math.max(0, (now.getTime() - ranAtMs) / DAY_MS);
  if (ageDays >= RECENCY_HALF_LIFE_DAYS) return 0;
  return 1 - ageDays / RECENCY_HALF_LIFE_DAYS;
}

function scorePriorityMatch<T extends RankableCandidate>(
  c: T,
  priorityTags: readonly string[],
): number {
  if (priorityTags.length === 0) return 0;
  const haystacks: string[] = [c.experimentId.toLowerCase()];
  if (c.subject) haystacks.push(c.subject.toLowerCase());
  for (const p of c.tier2Files) haystacks.push(p.toLowerCase());
  for (const rawTag of priorityTags) {
    const tag = rawTag.trim().toLowerCase();
    if (tag.length === 0) continue;
    if (haystacks.some((h) => h.includes(tag))) return 1;
  }
  return 0;
}

function combineScore(b: ScoreBreakdown): number {
  return (
    WEIGHT.revenue_proximity * b.revenue_proximity +
    WEIGHT.evidence_strength * b.evidence_strength +
    WEIGHT.blast_radius * b.blast_radius +
    WEIGHT.recency * b.recency +
    WEIGHT.priority_match * b.priority_match
  );
}

function buildRationale<T extends RankableCandidate>(
  c: T,
  breakdown: ScoreBreakdown,
): string[] {
  const parts: string[] = [];
  if (breakdown.revenue_proximity > 0) {
    const reason =
      REVENUE_PROXIMAL_EXPERIMENT_IDS.has(c.experimentId)
        ? `revenue-proximal experiment '${c.experimentId}'`
        : c.subject && REVENUE_PROXIMAL_SUBJECT_PREFIXES.some((p) => c.subject!.startsWith(p))
          ? `revenue-proximal subject '${c.subject}'`
          : 'revenue-proximal path touched';
    parts.push(`+${WEIGHT.revenue_proximity.toFixed(1)} ${reason}`);
  }
  if (breakdown.evidence_strength > 0) {
    parts.push(`+${(WEIGHT.evidence_strength * breakdown.evidence_strength).toFixed(2)} evidence strength (${Math.round(breakdown.evidence_strength * MAX_EVIDENCE_COUNT)} corroborating findings)`);
  }
  if (breakdown.blast_radius > 0) {
    parts.push(`${(WEIGHT.blast_radius * breakdown.blast_radius).toFixed(2)} blast radius`);
  }
  if (breakdown.recency > 0) {
    parts.push(`+${(WEIGHT.recency * breakdown.recency).toFixed(2)} recency`);
  }
  if (breakdown.priority_match > 0) {
    parts.push(`+${WEIGHT.priority_match.toFixed(1)} operator-priority tag match`);
  }
  if (parts.length === 0) parts.push('baseline (no positive signals)');
  return parts;
}

/**
 * Rank a list of patch candidates highest-score-first. Pure function;
 * mutating the input array is safe (a new array is returned). Ties
 * are broken by recency (newer wins), then by findingId for determinism.
 */
export function rankCandidates<T extends RankableCandidate>(
  input: RankInput<T>,
): RankedCandidate<T>[] {
  const now = input.now ?? new Date();
  const others = input.otherFindings ?? [];
  const priorityTags = input.priorityTags ?? [];
  const ranked = input.candidates.map((c) => {
    const breakdown: ScoreBreakdown = {
      revenue_proximity: scoreRevenueProximity(c),
      evidence_strength: scoreEvidenceStrength(c, others),
      blast_radius: scoreBlastRadius(c),
      recency: scoreRecency(c, now),
      priority_match: scorePriorityMatch(c, priorityTags),
    };
    const score = combineScore(breakdown);
    return {
      candidate: c,
      score,
      breakdown,
      rationale: buildRationale(c, breakdown),
    };
  });
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const bRecency = Date.parse(b.candidate.ranAt) || 0;
    const aRecency = Date.parse(a.candidate.ranAt) || 0;
    if (bRecency !== aRecency) return bRecency - aRecency;
    return a.candidate.findingId.localeCompare(b.candidate.findingId);
  });
  return ranked;
}

/**
 * Convenience: return just the single top candidate, or null when
 * the input is empty. The common case for patch-author's one-per-
 * tick budget.
 */
export function topRankedCandidate<T extends RankableCandidate>(
  input: RankInput<T>,
): RankedCandidate<T> | null {
  const all = rankCandidates(input);
  return all[0] ?? null;
}
