/**
 * Anomaly code → canonical research query mapping.
 *
 * Tier 2 of the "auto-observation feeds self-improvement" loop. The
 * observation probe emits enumerated anomaly codes; this map turns
 * each actionable code into a search query that the research-ingest
 * probe can feed to arXiv (or any other literature source).
 *
 * Rationale for *not* mapping every code:
 *   - Codes like NO_AUTONOMOUS_COMMITS or PATCHES_ATTEMPTED_TABLE_EMPTY
 *     are operational signals, not research questions — papers won't
 *     help when nothing has run yet.
 *   - DAEMON_UNHEALTHY and SESSION_MARKER_PRESENT are infra concerns.
 *
 * Queries are intentionally specific. Generic queries ("agent
 * self-improvement") pull the whole field; anomaly-seeded queries
 * ("UCB exploration repeat-count novelty search") target the exact
 * textbook problem the anomaly describes.
 *
 * Adding a new anomaly code in observation.ts does NOT require adding
 * a query here — the research probe skips codes with no mapping.
 */

import type { AnomalyCode } from './observation.js';

export interface ResearchQuerySpec {
  /** arXiv-style query string. Multiple terms get AND-joined by the scraper. */
  query: string;
  /** arXiv category filter (e.g. "cs.LG", "cs.AI"). Narrows the hit rate. */
  category?: string;
  /**
   * Minimum days between research runs for this code. Prevents the
   * same query from burning budget every tick when the anomaly is
   * chronic (e.g. ATTRIBUTION_FINDINGS_MISSING stays true until
   * someone populates the config key).
   */
  cooldown_days: number;
}

/**
 * Empirical notes on query design after live testing against the arXiv
 * Atom feed:
 *   - Long compound queries (6+ words) with a category filter returned
 *     near-zero strict matches; arXiv fell back to the most recent
 *     paper in the category that shared one keyword → noise.
 *   - `sortBy=relevance` + 2-3 key terms yields the canonical paper
 *     on the problem. That's what the anomaly → query map wants:
 *     the textbook paper, not today's upload.
 *   - Category filter is kept for scope hygiene but redundant in most
 *     cases since the relevance rank pulls from the right field anyway.
 */
export const ANOMALY_RESEARCH_QUERIES: Partial<Record<AnomalyCode, ResearchQuerySpec>> = {
  HIGH_REVERT_RATE: {
    // "Automatic program repair" is the canonical academic term — yields
    // specific repair-technique papers, not general SE. The literal phrase
    // "self-healing" returned inclusion/bots/generic-GAI papers on a first
    // pass. APR is exactly what Layer 5 is trying to be.
    query: 'automatic program repair',
    category: 'cs.SE',
    cooldown_days: 3,
  },
  PATCH_AUTHOR_NOVELTY_REPEAT: {
    // Textbook: contextual bandits with exploration bonuses.
    query: 'contextual bandit exploration bonus',
    category: 'cs.LG',
    cooldown_days: 7,
  },
  PATCH_AUTHOR_TOP_PICK_NULL: {
    // When every candidate scores zero, the problem is sparse reward.
    query: 'sparse reward shaping',
    category: 'cs.LG',
    cooldown_days: 7,
  },
  ATTRIBUTION_FINDINGS_MISSING: {
    query: 'credit assignment reinforcement learning',
    category: 'cs.LG',
    cooldown_days: 14,
  },
  EXPERIMENT_FINDING_FLOOD: {
    // "alert fatigue monitoring" + cs.SE surfaces Dependabot's
    // alert-reduction paper as the canonical hit — good enough.
    // Narrower variants pulled in materials-science papers on metal
    // fatigue instead. Accepting 1/3 signal; downstream filters noise.
    query: 'alert fatigue monitoring',
    category: 'cs.SE',
    cooldown_days: 7,
  },
};

export function queryForAnomaly(code: AnomalyCode): ResearchQuerySpec | null {
  return ANOMALY_RESEARCH_QUERIES[code] ?? null;
}

/**
 * General-curiosity queries for the *unfiltered* research pass.
 *
 * The anomaly-seeded map above is reactive — only fires when the
 * observation probe flags something. That's myopic: techniques
 * ohwow *doesn't yet know it needs* never surface. This list cycles
 * through evergreen topics on its own cooldown so the loop keeps
 * reading even when everything is healthy.
 *
 * Empirical note: fresh-sort + broad queries returned unrelated
 * most-recent uploads (quark physics, astronomical tools). Relevance
 * sort + a tight 2-3 word phrase yields the canonical modern papers
 * on each topic, which is better fuel for the downstream proposal
 * LLM. If we later need "papers from the last 30 days", that's a
 * `submittedDate:` filter on top, not a sort flip.
 *
 * Cycling: the probe picks the first query whose own cooldown has
 * expired, so the list rotates through over time. Keep the list
 * short (≤4) or the cadence will strand later queries.
 */
export interface GeneralResearchSpec extends ResearchQuerySpec {
  /** Stable slug used as the finding subject + cooldown key. */
  slug: string;
}

export const GENERAL_RESEARCH_QUERIES: GeneralResearchSpec[] = [
  {
    slug: 'autonomous-agents',
    query: 'autonomous agents large language model',
    category: 'cs.AI',
    cooldown_days: 3,
  },
  {
    slug: 'llm-tool-use',
    query: 'language model tool use',
    category: 'cs.AI',
    cooldown_days: 3,
  },
  {
    slug: 'self-improving-systems',
    query: 'self-improving language model',
    category: 'cs.LG',
    cooldown_days: 3,
  },
  {
    // Widest net — no category filter. Fallback when the narrower
    // queries are all on cooldown, or when the operator wants the
    // general flavour of "what did cs.AI produce recently".
    slug: 'ai-broad',
    query: 'large language model reasoning',
    cooldown_days: 2,
  },
];
