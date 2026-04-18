/**
 * Insight distiller — the "organized surprises" query.
 *
 * Raw findings land in self_findings continuously. Supersession hides
 * text-equal duplicates. Baselines (insight-baseline.ts) write the
 * novelty score into each finding's evidence.__novelty. This module
 * assembles a ranked, cluster-aware view on top of both tables so the
 * operator (or the daily-surprise-digest experiment) can pull "top N
 * things worth knowing right now" without skimming hundreds of rows.
 *
 * Ranking signal (descending):
 *   1. evidence.__novelty.score (baselines-derived, 0..1)
 *   2. consecutive_fails from the baseline (tiebreaker so truly stuck
 *      problems rise above freshly-surprising ones of equal score).
 *   3. ran_at (newest first — when everything else ties).
 *
 * Cluster id is the subject string (which already scopes experiments
 * semantically). Findings sharing a subject collapse to one row in the
 * distilled view, carrying the latest evidence + the accumulated
 * repeat_count from the baseline.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { Verdict, FindingStatus } from './experiment-types.js';

export interface DistilledInsight {
  cluster_id: string;
  experiment_id: string;
  subject: string;
  latest_finding_id: string;
  verdict: Verdict;
  summary: string;
  novelty_score: number;
  novelty_reason: string;
  novelty_detail: string | null;
  z_score: number | null;
  consecutive_fails: number;
  sample_count: number;
  first_seen_at: string | null;
  last_seen_at: string;
  tracked_field: string | null;
  last_value: number | null;
  running_mean: number | null;
  evidence: Record<string, unknown>;
}

interface FindingRow {
  id: string;
  experiment_id: string;
  subject: string | null;
  verdict: string;
  summary: string;
  evidence: string | Record<string, unknown>;
  ran_at: string;
  status: string;
}

interface BaselineRow {
  experiment_id: string;
  subject: string;
  first_seen_at: string;
  last_seen_at: string;
  sample_count: number;
  tracked_field: string | null;
  running_mean: number | null;
  last_value: number | null;
  consecutive_fails: number;
}

function parseEvidence(raw: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) return raw;
  if (typeof raw !== 'string') return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface DistillFilters {
  /** Minimum novelty score to include. Default 0 — include everything ranked. */
  minScore?: number;
  /** Cap on returned rows after ranking. Default 25, hard max 200. */
  limit?: number;
  /** Return only rows about active findings (default). Pass 'any' to include superseded. */
  status?: FindingStatus | 'any';
  /**
   * Restrict the candidate pool to findings whose subject starts with
   * this prefix BEFORE ranking + limit. Prevents a high-novelty
   * population (e.g. digest/ops/proposal rows at novelty 1.0) from
   * starving a smaller target population (e.g. `market:*` clusters)
   * out of the top-N window. Matched as a literal string prefix on
   * the in-memory candidate list — no SQL LIKE, no wildcards.
   */
  subjectPrefix?: string;
}

/**
 * Pull the most recent active finding per (experiment_id, subject),
 * join with its baseline, rank by novelty_score + consecutive_fails,
 * and return the top N.
 */
export async function listDistilledInsights(
  db: DatabaseAdapter,
  filters: DistillFilters = {},
): Promise<DistilledInsight[]> {
  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 200);
  const minScore = Math.max(filters.minScore ?? 0, 0);
  const statusFilter = filters.status ?? 'active';
  const subjectPrefix = filters.subjectPrefix ?? null;

  let findingsQ = db
    .from<FindingRow>('self_findings')
    .select('id, experiment_id, subject, verdict, summary, evidence, ran_at, status');
  if (statusFilter !== 'any') {
    findingsQ = findingsQ.eq('status', statusFilter);
  }
  // pre-cap the candidate pool before per-cluster dedup
  const { data: findings } = await findingsQ
    .order('ran_at', { ascending: false })
    .limit(2000);
  const findingRows = (findings ?? []) as FindingRow[];

  const { data: baselines } = await db
    .from<BaselineRow>('self_observation_baselines')
    .select(
      'experiment_id, subject, first_seen_at, last_seen_at, sample_count, tracked_field, running_mean, last_value, consecutive_fails',
    )
    .limit(5000);
  const baselineRows = (baselines ?? []) as BaselineRow[];
  const baselineIndex = new Map<string, BaselineRow>();
  for (const b of baselineRows) {
    baselineIndex.set(`${b.experiment_id}::${b.subject}`, b);
  }

  // Dedupe to latest per (experiment_id, subject). findings already
  // sorted newest-first by order() above so first-wins is correct.
  const seen = new Set<string>();
  const distilled: DistilledInsight[] = [];
  for (const row of findingRows) {
    const subject = row.subject ?? '';
    if (!subject) continue;
    // Subject-shape pre-filter: applied before dedup + limit so a
    // smaller target population (e.g. `market:*`) isn't starved out
    // of the top-N window by a larger high-novelty population.
    if (subjectPrefix !== null && !subject.startsWith(subjectPrefix)) continue;
    const key = `${row.experiment_id}::${subject}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const ev = parseEvidence(row.evidence);
    const nov = (ev.__novelty ?? {}) as Record<string, unknown>;
    const score = typeof nov.score === 'number' ? nov.score : 0;
    if (score < minScore) continue;

    const baseline = baselineIndex.get(key);

    distilled.push({
      cluster_id: key,
      experiment_id: row.experiment_id,
      subject,
      latest_finding_id: row.id,
      verdict: row.verdict as Verdict,
      summary: row.summary,
      novelty_score: score,
      novelty_reason: typeof nov.reason === 'string' ? nov.reason : 'normal',
      novelty_detail: typeof nov.detail === 'string' ? nov.detail : null,
      z_score: typeof nov.z_score === 'number' ? nov.z_score : null,
      consecutive_fails: baseline?.consecutive_fails ?? 0,
      sample_count: baseline?.sample_count ?? 0,
      first_seen_at: baseline?.first_seen_at ?? null,
      last_seen_at: baseline?.last_seen_at ?? row.ran_at,
      tracked_field: baseline?.tracked_field ?? null,
      last_value: baseline?.last_value ?? null,
      running_mean: baseline?.running_mean ?? null,
      evidence: ev,
    });
  }

  distilled.sort((a, b) => {
    if (b.novelty_score !== a.novelty_score) return b.novelty_score - a.novelty_score;
    if (b.consecutive_fails !== a.consecutive_fails) return b.consecutive_fails - a.consecutive_fails;
    return b.last_seen_at.localeCompare(a.last_seen_at);
  });

  return distilled.slice(0, limit);
}
