/**
 * ModelReleaseMonitorExperiment — tracks new model releases every 12h.
 *
 * Two data sources per tick:
 *   1. HuggingFace Hub REST API — scans tracked model families for repos
 *      updated within the look-back window. No auth required for public models.
 *   2. arXiv — searches for papers mentioning each family, sorted by
 *      submission date, to catch technical reports before HF listings appear.
 *
 * Notable finds are ingested into the knowledge base via ingestKnowledgeText()
 * so agents can answer "what do we know about qwen3?" via searchKnowledge.
 *
 * A finding is written every tick regardless of verdict so the ledger
 * captures the full scan history. Filter on category='model_releases' to
 * get a clean feed via ohwow_list_findings.
 */

import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { searchArxiv, type ArxivPaper } from '../../integrations/arxiv-scraper.js';
import { ingestKnowledgeText } from '../knowledge-ingest.js';
import { logger } from '../../lib/logger.js';

const PROBE_EVERY_MS = 12 * 60 * 60 * 1000;
const WINDOW_HOURS = 12;
const HF_MODELS_PER_FAMILY = 20;
const ARXIV_PAPERS_PER_FAMILY = 3;
const INTER_FAMILY_DELAY_MS = 800;

/** Model families to watch. Extend this list as new players emerge. */
export const TRACKED_FAMILIES = [
  'qwen',
  'kimi',
  'moonshot',
  'glm',
  'chatglm',
  'deepseek',
  'mistral',
  'llama',
  'gemma',
  'phi',
  'yi',
  'internlm',
  'baichuan',
] as const;

export type ModelFamily = (typeof TRACKED_FAMILIES)[number];

export interface HfModelEntry {
  id: string;
  lastModified: string;
  downloads: number;
  likes: number;
  tags: string[];
}

export interface FamilyScanResult {
  family: ModelFamily;
  new_hf_models: HfModelEntry[];
  new_papers: Array<Pick<ArxivPaper, 'id' | 'title' | 'primary_category' | 'published'>>;
  hf_ingested: Array<{ id: string; inserted: boolean; reason?: string }>;
  paper_ingested: Array<{ id: string; inserted: boolean; reason?: string }>;
  hf_error: string | null;
  arxiv_error: string | null;
}

/** Compact per-family summary stored in evidence (no full API payloads). */
export interface FamilyScanSummary {
  family: ModelFamily;
  new_models: number;
  new_papers: number;
  ingested: number;
  top_model_ids: string[];
  top_paper_ids: string[];
  hf_error: string | null;
  arxiv_error: string | null;
}

export interface ModelReleaseEvidence extends Record<string, unknown> {
  window_hours: number;
  families_checked: number;
  total_new_models: number;
  total_new_papers: number;
  total_ingested: number;
  families: FamilyScanSummary[];
  scanned_at: string;
}

/** Fetcher abstraction for testability. */
export type HfFetcher = (family: string, windowHours: number) => Promise<HfModelEntry[]>;
export type AxFetcher = (family: string) => Promise<ArxivPaper[]>;

async function defaultHfFetcher(family: string, windowHours: number): Promise<HfModelEntry[]> {
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const url = `https://huggingface.co/api/models?sort=lastModified&direction=-1&limit=${HF_MODELS_PER_FAMILY}&search=${encodeURIComponent(family)}`;
  const resp = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`HF API ${resp.status}: ${resp.statusText}`);
  const rows = (await resp.json()) as HfModelEntry[];
  return rows.filter((m) => m.lastModified && new Date(m.lastModified) >= cutoff);
}

async function defaultAxFetcher(family: string): Promise<ArxivPaper[]> {
  return searchArxiv({
    query: `${family} language model`,
    max_results: ARXIV_PAPERS_PER_FAMILY,
    sort_by: 'submittedDate',
  });
}

export class ModelReleaseMonitorExperiment implements Experiment {
  readonly id = 'model-release-monitor';
  readonly name = 'Model release monitor (HuggingFace + arXiv, 12h)';
  readonly category: ExperimentCategory = 'model_releases';
  readonly hypothesis =
    'Scanning HuggingFace and arXiv every 12 hours for tracked model families (Qwen, Kimi, DeepSeek, etc.) keeps ohwow informed of the latest open-source releases before they surface via manual discovery.';
  readonly cadence = { everyMs: PROBE_EVERY_MS, runOnBoot: true };

  constructor(
    private readonly hfFetcher: HfFetcher = defaultHfFetcher,
    private readonly axFetcher: AxFetcher = defaultAxFetcher,
  ) {}

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const scannedAt = new Date().toISOString();
    const families: FamilyScanResult[] = [];

    for (let i = 0; i < TRACKED_FAMILIES.length; i++) {
      const family = TRACKED_FAMILIES[i];
      if (i > 0) await new Promise((r) => setTimeout(r, INTER_FAMILY_DELAY_MS));

      const result = await this.scanFamily(family, ctx);
      families.push(result);
    }

    const totalNewModels = families.reduce((n, f) => n + f.new_hf_models.length, 0);
    const totalNewPapers = families.reduce((n, f) => n + f.new_papers.length, 0);
    const totalIngested = families.reduce(
      (n, f) =>
        n +
        f.hf_ingested.filter((x) => x.inserted).length +
        f.paper_ingested.filter((x) => x.inserted).length,
      0,
    );

    const familySummaries: FamilyScanSummary[] = families.map((f) => ({
      family: f.family,
      new_models: f.new_hf_models.length,
      new_papers: f.new_papers.length,
      ingested:
        f.hf_ingested.filter((x) => x.inserted).length +
        f.paper_ingested.filter((x) => x.inserted).length,
      top_model_ids: f.new_hf_models.slice(0, 3).map((m) => m.id),
      top_paper_ids: f.new_papers.slice(0, 2).map((p) => p.id),
      hf_error: f.hf_error,
      arxiv_error: f.arxiv_error,
    }));

    const evidence: ModelReleaseEvidence = {
      window_hours: WINDOW_HOURS,
      families_checked: TRACKED_FAMILIES.length,
      total_new_models: totalNewModels,
      total_new_papers: totalNewPapers,
      total_ingested: totalIngested,
      families: familySummaries,
      scanned_at: scannedAt,
    };

    const topFinds = families
      .flatMap((f) => f.new_hf_models.slice(0, 2).map((m) => m.id))
      .slice(0, 5);

    const summary =
      totalNewModels === 0 && totalNewPapers === 0
        ? `no new releases in last ${WINDOW_HOURS}h across ${TRACKED_FAMILIES.length} families`
        : `${totalNewModels} new model(s), ${totalNewPapers} paper(s) — ${totalIngested} ingested` +
          (topFinds.length > 0 ? ` — top: ${topFinds.join(', ')}` : '');

    return {
      subject: `model-releases:scan:${scannedAt.slice(0, 13)}`,
      summary,
      evidence: evidence as unknown as Record<string, unknown>,
    };
  }

  private async scanFamily(family: ModelFamily, ctx: ExperimentContext): Promise<FamilyScanResult> {
    let newHfModels: HfModelEntry[] = [];
    let hfError: string | null = null;
    const hfIngested: FamilyScanResult['hf_ingested'] = [];

    try {
      newHfModels = await this.hfFetcher(family, WINDOW_HOURS);
    } catch (err) {
      hfError = err instanceof Error ? err.message : String(err);
      logger.debug({ family, err }, '[model-release-monitor] HF fetch error');
    }

    for (const model of newHfModels) {
      const sourceUrl = `https://huggingface.co/${model.id}`;
      const title = `[HuggingFace] ${model.id}`;
      const text = [
        model.id,
        `Last modified: ${model.lastModified}`,
        `Downloads: ${model.downloads}  Likes: ${model.likes}`,
        model.tags.length > 0 ? `Tags: ${model.tags.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const result = await ingestKnowledgeText(ctx.db, {
        workspaceId: ctx.workspaceId,
        title,
        text,
        sourceType: 'model_release',
        sourceUrl,
        description: `HuggingFace model release — family: ${family}`,
      });
      hfIngested.push({
        id: model.id,
        inserted: result.inserted,
        reason: result.inserted ? undefined : result.reason,
      });
    }

    let newPapers: ArxivPaper[] = [];
    let arxivError: string | null = null;
    const paperIngested: FamilyScanResult['paper_ingested'] = [];

    try {
      newPapers = await this.axFetcher(family);
    } catch (err) {
      arxivError = err instanceof Error ? err.message : String(err);
      logger.debug({ family, err }, '[model-release-monitor] arXiv fetch error');
    }

    for (const paper of newPapers) {
      const sourceUrl = `https://arxiv.org/abs/${paper.id}`;
      const title = `[arxiv/${paper.primary_category ?? 'unknown'}] ${paper.title}`;
      const text = `${paper.title}\n\n${paper.summary}\n\nAuthors: ${paper.authors.join(', ')}\nPublished: ${paper.published}\narXiv: ${paper.id}`;

      const result = await ingestKnowledgeText(ctx.db, {
        workspaceId: ctx.workspaceId,
        title,
        text,
        sourceType: 'arxiv',
        sourceUrl,
        description: `arXiv paper — model family: ${family}`,
      });
      paperIngested.push({
        id: paper.id,
        inserted: result.inserted,
        reason: result.inserted ? undefined : result.reason,
      });
    }

    return {
      family,
      new_hf_models: newHfModels,
      new_papers: newPapers.map((p) => ({
        id: p.id,
        title: p.title,
        primary_category: p.primary_category,
        published: p.published,
      })),
      hf_ingested: hfIngested,
      paper_ingested: paperIngested,
      hf_error: hfError,
      arxiv_error: arxivError,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ModelReleaseEvidence;
    const allHfFailed = ev.families.every((f) => f.hf_error !== null);
    const allArxivFailed = ev.families.every((f) => f.arxiv_error !== null);
    if (allHfFailed && allArxivFailed) return 'fail';
    if (ev.total_new_models > 0 || ev.total_new_papers > 0) return 'warning';
    return 'pass';
  }

  async intervene(
    verdict: Verdict,
    result: ProbeResult,
    _ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    if (verdict !== 'warning') return null;
    const ev = result.evidence as ModelReleaseEvidence;
    const topModels = ev.families
      .flatMap((f) => f.top_model_ids)
      .slice(0, 10);
    return {
      description: `Ingested ${ev.total_ingested} new model release(s) into knowledge base`,
      details: { top_models: topModels, total_ingested: ev.total_ingested },
    };
  }

  readonly burnDownKeys: string[] = [];
}

export const _internal = {
  TRACKED_FAMILIES,
  WINDOW_HOURS,
  HF_MODELS_PER_FAMILY,
  ARXIV_PAPERS_PER_FAMILY,
  defaultHfFetcher,
};
