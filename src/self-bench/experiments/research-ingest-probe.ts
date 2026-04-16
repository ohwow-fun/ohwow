/**
 * ResearchIngestProbeExperiment — Tier 2 of the auto-observation loop.
 *
 * Two passes per tick:
 *   1. General curiosity — pulls from GENERAL_RESEARCH_QUERIES on a
 *      rotating cooldown. Runs even when everything is healthy so the
 *      loop keeps reading recent work on broad self-improvement
 *      topics it doesn't yet know it needs.
 *   2. Anomaly-seeded — reads the most recent observation-probe
 *      finding, picks codes with a query mapping, fetches matching
 *      papers. Reactive lane; closes the "loop stuck → read the
 *      textbook paper" flow.
 *
 * Each fetched paper lands two rows: a self_findings row (for the
 * ledger) + a knowledge_documents row (for BM25 + semantic search).
 * The KB ingest happens via the same queue the DocumentWorker
 * already drains, so the probe stays synchronous.
 *
 * Surprise model:
 *   - observation-probe flags PATCH_AUTHOR_NOVELTY_REPEAT=116.
 *   - this probe maps the code to "contextual bandit exploration
 *     bonus" and fetches 3 canonical papers, relevance-sorted.
 *   - papers land in the KB. A later Rule 5 proposal-generator
 *     tick (Tier 3, deferred) pulls them into its LLM prompt via
 *     searchKnowledge; proposals cite them with
 *     `Cites-Research-Paper:`.
 *   - observation-probe's trailer parser (already wired) lifts
 *     the citation; a future resolver writes it into
 *     research_citations_ledger against held/reverted outcome.
 *
 * Cadence: 15 minutes, runOnBoot: true. Short on purpose for the
 * current observation window; bump to 1h for steady-state.
 */

import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import {
  ANOMALY_RESEARCH_QUERIES,
  GENERAL_RESEARCH_QUERIES,
  queryForAnomaly,
  type GeneralResearchSpec,
  type ResearchQuerySpec,
} from '../anomaly-research-queries.js';
import type { AnomalyCode, Observation } from '../observation.js';
import { searchArxiv, type ArxivPaper } from '../../integrations/arxiv-scraper.js';
import { ingestKnowledgeText } from '../knowledge-ingest.js';
import { logger } from '../../lib/logger.js';

const PROBE_EVERY_MS = 15 * 60 * 1000;
/** Upper bound on arXiv calls per tick. Keeps us polite on the free API. */
const MAX_FETCHES_PER_TICK = 2;
const PAPERS_PER_QUERY = 3;
const INTER_FETCH_DELAY_MS = 1500;

export interface ResearchFetchEntry {
  /** `general` for curiosity pass, the anomaly code for the filtered pass. */
  source: 'general' | AnomalyCode;
  /** Slug for general queries ('autonomous-agents'), empty for anomaly pass. */
  slug: string | null;
  query: string;
  category: string | null;
  paper_count: number;
  papers: Array<Pick<ArxivPaper, 'id' | 'title' | 'primary_category' | 'published'>>;
  /** Per-paper ingestion outcome into the KB. One-for-one with `papers`. */
  ingested: Array<{ id: string; inserted: boolean; reason?: string }>;
  error: string | null;
}

export interface ResearchIngestEvidence extends Record<string, unknown> {
  /** Anomaly codes we saw in the source observation-probe finding. */
  candidate_codes: AnomalyCode[];
  /** Anomaly codes with a mapping that we *could* have fetched this tick. */
  eligible_codes: AnomalyCode[];
  /** Anomaly codes skipped because they were inside their cooldown window. */
  cooldown_skipped: AnomalyCode[];
  /** General-pass slug fetched this tick, or null if all on cooldown. */
  general_slug: string | null;
  /** Per-fetch summary — one entry per arXiv call this tick. */
  fetches: ResearchFetchEntry[];
  /** ISO ts of the source observation-probe finding used. */
  source_finding_ran_at: string | null;
}

export type ArxivFetcher = (spec: ResearchQuerySpec) => Promise<ArxivPaper[]>;

const defaultArxivFetcher: ArxivFetcher = (spec) =>
  searchArxiv({
    query: spec.query,
    category: spec.category,
    max_results: PAPERS_PER_QUERY,
    // Relevance > freshness for anomaly-seeded research — we want the
    // canonical paper on the problem, not today's upload.
    sort_by: 'relevance',
  });

/**
 * Read the most recent observation-probe finding and pull its
 * anomaly list. The experiment is a no-op when observation-probe has
 * never run (empty loop) — we only look at one source row so the
 * probe stays cheap.
 */
async function readLatestObservation(
  ctx: ExperimentContext,
): Promise<{ ran_at: string; anomalies: Array<{ code: AnomalyCode; severity: string }> } | null> {
  const { data } = await ctx.db
    .from<{ ran_at: string; evidence: string }>('self_findings')
    .select('ran_at,evidence')
    .eq('experiment_id', 'observation-probe')
    .order('ran_at', { ascending: false })
    .limit(1);
  const rows = (data ?? []) as Array<{ ran_at: string; evidence: string }>;
  if (rows.length === 0) return null;
  try {
    const ev = JSON.parse(rows[0].evidence) as Partial<Observation>;
    return {
      ran_at: rows[0].ran_at,
      anomalies: (ev.anomalies ?? []) as Array<{ code: AnomalyCode; severity: string }>,
    };
  } catch {
    return null;
  }
}

/**
 * For each candidate code, decide if the cooldown has expired by
 * reading our own most recent finding with the matching subject.
 * Absent finding = not on cooldown.
 */
/**
 * Pick the first general-pass spec whose cooldown has expired. Returns
 * null if all are on cooldown. Uses the same self_findings history the
 * anomaly-pass cooldown uses, keyed on `research-ingest:general:<slug>`.
 */
async function firstGeneralPastCooldown(
  ctx: ExperimentContext,
  specs: GeneralResearchSpec[],
  nowMs: number,
): Promise<GeneralResearchSpec | null> {
  if (specs.length === 0) return null;
  const subjects = specs.map((s) => `research-ingest:general:${s.slug}`);
  const { data } = await ctx.db
    .from<{ subject: string; ran_at: string }>('self_findings')
    .select('subject,ran_at')
    .eq('experiment_id', 'research-ingest-probe')
    .in('subject', subjects)
    .order('ran_at', { ascending: false });
  const latestBySubject = new Map<string, string>();
  for (const r of (data ?? []) as Array<{ subject: string; ran_at: string }>) {
    if (!latestBySubject.has(r.subject)) latestBySubject.set(r.subject, r.ran_at);
  }
  for (const spec of specs) {
    const latest = latestBySubject.get(`research-ingest:general:${spec.slug}`);
    if (!latest) return spec;
    const ageMs = nowMs - new Date(latest).getTime();
    if (ageMs >= spec.cooldown_days * 24 * 60 * 60 * 1000) return spec;
  }
  return null;
}

function pickSubject(fetches: ResearchFetchEntry[], generalSlug: string | null): string {
  if (fetches.length === 0) return 'research-ingest:idle';
  // Prefer the anomaly-seeded fetch as the primary subject when present —
  // it's the one that most plausibly needs its own cooldown ledger row.
  const anomalyFetch = fetches.find((f) => f.source !== 'general');
  if (anomalyFetch) return `research-ingest:${anomalyFetch.source}`;
  if (generalSlug) return `research-ingest:general:${generalSlug}`;
  return 'research-ingest:idle';
}

async function codesPastCooldown(
  ctx: ExperimentContext,
  codes: AnomalyCode[],
  nowMs: number,
): Promise<{ eligible: AnomalyCode[]; cooldown_skipped: AnomalyCode[] }> {
  if (codes.length === 0) return { eligible: [], cooldown_skipped: [] };
  const { data } = await ctx.db
    .from<{ subject: string; ran_at: string }>('self_findings')
    .select('subject,ran_at')
    .eq('experiment_id', 'research-ingest-probe')
    .in('subject', codes.map((c) => `research-ingest:${c}`))
    .order('ran_at', { ascending: false });
  const rows = (data ?? []) as Array<{ subject: string; ran_at: string }>;
  const latestBySubject = new Map<string, string>();
  for (const r of rows) {
    if (!latestBySubject.has(r.subject)) latestBySubject.set(r.subject, r.ran_at);
  }
  const eligible: AnomalyCode[] = [];
  const skipped: AnomalyCode[] = [];
  for (const code of codes) {
    const spec = queryForAnomaly(code);
    if (!spec) continue;
    const latest = latestBySubject.get(`research-ingest:${code}`);
    if (!latest) {
      eligible.push(code);
      continue;
    }
    const ageMs = nowMs - new Date(latest).getTime();
    if (ageMs >= spec.cooldown_days * 24 * 60 * 60 * 1000) {
      eligible.push(code);
    } else {
      skipped.push(code);
    }
  }
  return { eligible, cooldown_skipped: skipped };
}

export class ResearchIngestProbeExperiment implements Experiment {
  readonly id = 'research-ingest-probe';
  readonly name = 'Research ingest (anomaly-seeded arXiv fetch)';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'Reading arXiv papers targeted by the observation probe\'s enumerated anomaly codes produces more useful research signal than broad keyword sweeps. A paper fetched in response to HIGH_REVERT_RATE is, by construction, about rollback / regression detection; the LLM doesn\'t have to filter general agent literature to find the relevant subset.';
  readonly cadence = { everyMs: PROBE_EVERY_MS, runOnBoot: true };

  constructor(private readonly fetcher: ArxivFetcher = defaultArxivFetcher) {}

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const nowMs = Date.now();
    const fetches: ResearchFetchEntry[] = [];

    // -- Pass 1: general curiosity (at most one per tick). --
    const general = await firstGeneralPastCooldown(ctx, GENERAL_RESEARCH_QUERIES, nowMs);
    let generalSlug: string | null = null;
    if (general) {
      generalSlug = general.slug;
      const fetched = await this.runFetch('general', general, ctx);
      fetches.push({ ...fetched, source: 'general', slug: general.slug });
      if (fetches.length > 0) await new Promise((r) => setTimeout(r, INTER_FETCH_DELAY_MS));
    }

    // -- Pass 2: anomaly-seeded. --
    const latest = await readLatestObservation(ctx);
    const candidates: AnomalyCode[] = latest
      ? latest.anomalies.filter((a) => a.severity !== 'info').map((a) => a.code)
      : [];
    const { eligible, cooldown_skipped } = await codesPastCooldown(ctx, candidates, nowMs);

    let fetchesDone = fetches.length;
    for (const code of eligible) {
      if (fetchesDone >= MAX_FETCHES_PER_TICK) break;
      const spec = queryForAnomaly(code);
      if (!spec) continue;
      if (fetchesDone > 0) await new Promise((r) => setTimeout(r, INTER_FETCH_DELAY_MS));
      const entry = await this.runFetch(code, spec, ctx);
      fetches.push({ ...entry, source: code, slug: null });
      fetchesDone += 1;
    }

    const evidence: ResearchIngestEvidence = {
      candidate_codes: candidates,
      eligible_codes: eligible,
      cooldown_skipped,
      general_slug: generalSlug,
      fetches,
      source_finding_ran_at: latest?.ran_at ?? null,
    };

    const subject = pickSubject(fetches, generalSlug);
    const totalPapers = fetches.reduce((n, f) => n + f.paper_count, 0);
    const newlyIngested = fetches.reduce((n, f) => n + f.ingested.filter((i) => i.inserted).length, 0);
    const summary =
      fetches.length === 0
        ? `idle — ${candidates.length} candidates, ${cooldown_skipped.length} on cooldown`
        : `fetched ${totalPapers} paper(s), ingested ${newlyIngested} new: ` +
          fetches.map((f) => `${f.source}=${f.paper_count}/${f.ingested.filter((i) => i.inserted).length}`).join(' ');

    return { subject, summary, evidence: evidence as unknown as Record<string, unknown> };
  }

  /** Run a single fetch + per-paper KB ingest. Shared by both passes. */
  private async runFetch(
    source: 'general' | AnomalyCode,
    spec: ResearchQuerySpec,
    ctx: ExperimentContext,
  ): Promise<Omit<ResearchFetchEntry, 'source' | 'slug'>> {
    let papers: ArxivPaper[] = [];
    let error: string | null = null;
    try {
      papers = await this.fetcher(spec);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.debug({ source, err }, '[research-ingest] fetch error');
    }
    const ingested: ResearchFetchEntry['ingested'] = [];
    for (const p of papers) {
      const sourceUrl = `https://arxiv.org/abs/${p.id}`;
      const title = `[arxiv/${p.primary_category ?? 'unknown'}] ${p.title}`;
      const text = `${p.title}\n\n${p.summary}\n\nAuthors: ${p.authors.join(', ')}\nPublished: ${p.published}\narXiv: ${p.id}`;
      const result = await ingestKnowledgeText(ctx.db, {
        workspaceId: ctx.workspaceId,
        title,
        text,
        sourceType: 'arxiv',
        sourceUrl,
        description: `Ingested by research-ingest-probe (${source})`,
      });
      ingested.push({
        id: p.id,
        inserted: result.inserted,
        reason: result.inserted ? undefined : result.reason,
      });
    }
    return {
      query: spec.query,
      category: spec.category ?? null,
      paper_count: papers.length,
      papers: papers.map((p) => ({
        id: p.id,
        title: p.title,
        primary_category: p.primary_category,
        published: p.published,
      })),
      ingested,
      error,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ResearchIngestEvidence;
    if (ev.fetches.length === 0) return 'pass'; // idle tick, cooldowns doing their job
    const allErrored = ev.fetches.every((f) => f.error !== null);
    if (allErrored) return 'fail';
    const anyPapers = ev.fetches.some((f) => f.paper_count > 0);
    if (!anyPapers) return 'warning'; // queries returned nothing — tune the mapping
    return 'pass';
  }

  readonly burnDownKeys: string[] = [];
}

/** Exported for the experiment's own tests. */
export const _internal = {
  MAX_FETCHES_PER_TICK,
  PAPERS_PER_QUERY,
  ANOMALY_RESEARCH_QUERIES,
  codesPastCooldown,
};
