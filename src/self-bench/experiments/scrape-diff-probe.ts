/**
 * ScrapeDiffProbeExperiment — parametrized probe that watches an
 * external URL for content drift and writes a finding per run.
 *
 * Lifecycle per probe:
 *   1. Fetch url via ctx.scraplingService (auto-escalating HTTP → stealth → dynamic)
 *   2. Extract visible text (selector-narrowed when config.selector is set)
 *   3. normalizeScrapeContent → strip timestamps, counters, etc.
 *   4. SHA-256 hash the normalized snapshot
 *   5. Read the prior finding for (experiment_id, subject_key) via
 *      ctx.recentFindings(this.id, 1). Compare hashes.
 *   6. Decide verdict:
 *        - no prior finding                  → pass  (change_kind='first_seen')
 *        - same hash                         → pass  (change_kind='unchanged')
 *        - different hash                    → warning (change_kind='changed',
 *                                              evidence carries a structural diff)
 *        - fetch / normalize error           → fail  (error in evidence)
 *
 * The novelty pass in findings-store handles downstream signal:
 *   - first run           → __novelty.reason='first_seen',   score=1.0
 *   - unchanged run       → __novelty.reason='normal',       score=0.0
 *   - verdict flip (pass↔warning) → __novelty.reason='verdict_flipped', score=0.9
 *
 * Category is validated against the runtime ExperimentCategory enum
 * at construction time. Invalid categories throw — explicitly guards
 * against the `data_freshness` bug shipped with LlmAuthoredProbeParams
 * (see experiment-template.ts, where the type permits a value the
 * runtime enum does not).
 *
 * One instance per (url, subject). Registered from
 * src/self-bench/registries/scrape-diff-registry.ts via
 * auto-registry.ts.
 */

import { createHash } from 'node:crypto';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import type { ScraplingService } from '../../execution/scrapling/index.js';
import { autoEscalateFetch, cleanContent } from '../../execution/scrapling/index.js';
import { normalizeScrapeContent } from '../normalize-scrape-content.js';
import { diffScrapeSnapshots, type ScrapeDiffResult } from '../scrape-diff.js';

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_EVERY_MS = 6 * HOUR_MS;

/** Cap on snapshot length we persist in evidence (avoid bloating rows). */
const MAX_SNAPSHOT_BYTES = 10_000;

/**
 * Valid category values accepted by ScrapeDiffProbeExperiment.
 * Mirrors the ExperimentCategory enum in experiment-types.ts — kept as
 * a runtime array so the constructor can validate a config string
 * against it. Update both together if the enum grows.
 */
const VALID_CATEGORIES: readonly ExperimentCategory[] = [
  'model_health',
  'trigger_stability',
  'tool_reliability',
  'handler_audit',
  'prompt_calibration',
  'canary',
  'validation',
  'experiment_proposal',
  'business_outcome',
  'dm_intel',
  'other',
];

export interface ScrapeDiffProbeConfig {
  /** Stable experiment id, e.g. 'scrape-diff:linear-pricing'. */
  id: string;
  /** Human-readable name for logs and the dashboard. */
  name: string;
  /** URL to fetch. */
  url: string;
  /** Optional CSS selector to narrow the observed region. */
  selector?: string;
  /** Stable subject key (e.g. 'market:linear.app/pricing'). */
  subjectKey: string;
  /** Must be a valid ExperimentCategory — validated at construction. */
  category: ExperimentCategory | string;
  /** One-sentence hypothesis; defaults to a generic drift-watch statement. */
  hypothesis?: string;
  /** Probe cadence. Default 6h. */
  everyMs?: number;
  /** Fire once on runner boot? Default false to stagger cold start. */
  runOnBoot?: boolean;
}

export interface ScrapeDiffEvidence extends Record<string, unknown> {
  url: string;
  selector: string | null;
  tier: string | null;
  status: number | null;
  content_hash: string;
  normalized_snapshot: string;
  normalized_length: number;
  change_kind: 'first_seen' | 'unchanged' | 'changed' | 'error';
  diff?: ScrapeDiffResult;
  error?: string;
}

export class ScrapeDiffProbeExperiment implements Experiment {
  readonly id: string;
  readonly name: string;
  readonly category: ExperimentCategory;
  readonly hypothesis: string;
  readonly cadence: { everyMs: number; runOnBoot: boolean };

  private readonly url: string;
  private readonly selector: string | null;
  private readonly subjectKey: string;

  constructor(config: ScrapeDiffProbeConfig) {
    if (!VALID_CATEGORIES.includes(config.category as ExperimentCategory)) {
      throw new Error(
        `ScrapeDiffProbeExperiment: invalid category "${String(config.category)}". ` +
          `Valid: ${VALID_CATEGORIES.join(', ')}.`,
      );
    }
    if (!config.id || !config.url || !config.subjectKey) {
      throw new Error('ScrapeDiffProbeExperiment: id, url, subjectKey are required');
    }

    this.id = config.id;
    this.name = config.name;
    this.category = config.category as ExperimentCategory;
    this.hypothesis =
      config.hypothesis ??
      `External surface ${config.subjectKey} drifts in ways worth surfacing.`;
    this.cadence = {
      everyMs: config.everyMs ?? DEFAULT_EVERY_MS,
      runOnBoot: config.runOnBoot ?? false,
    };
    this.url = config.url;
    this.selector = config.selector ?? null;
    this.subjectKey = config.subjectKey;
  }

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const service = ctx.scraplingService;
    if (!service) {
      return this.errorResult('scrapingService unavailable in ExperimentContext');
    }

    let text: string;
    let tier: string | null = null;
    let status: number | null = null;
    try {
      const result = await autoEscalateFetch(service as ScraplingService, this.url, {
        selector: this.selector ?? undefined,
      });
      if (!result.response || result.error) {
        return this.errorResult(result.error ?? 'scrape returned no response', tier);
      }
      tier = result.tier;
      status = result.response.status;
      text = cleanContent(result.response, 'text');
    } catch (err) {
      return this.errorResult(err instanceof Error ? err.message : String(err), tier);
    }

    const normalized = normalizeScrapeContent(text);
    const hash = sha256(normalized);
    const snapshot = truncate(normalized, MAX_SNAPSHOT_BYTES);

    const prior = await this.readPriorFinding(ctx);
    const priorHash = prior ? extractPriorHash(prior) : null;
    const priorSnapshot = prior ? extractPriorSnapshot(prior) : null;

    if (!prior || !priorHash) {
      const evidence: ScrapeDiffEvidence = {
        url: this.url,
        selector: this.selector,
        tier,
        status,
        content_hash: hash,
        normalized_snapshot: snapshot,
        normalized_length: normalized.length,
        change_kind: 'first_seen',
        __tracked_field: 'content_hash',
      };
      return {
        subject: this.subjectKey,
        summary: `First snapshot recorded for ${this.subjectKey}.`,
        evidence,
      };
    }

    if (priorHash === hash) {
      const evidence: ScrapeDiffEvidence = {
        url: this.url,
        selector: this.selector,
        tier,
        status,
        content_hash: hash,
        normalized_snapshot: snapshot,
        normalized_length: normalized.length,
        change_kind: 'unchanged',
        __tracked_field: 'content_hash',
      };
      return {
        subject: this.subjectKey,
        summary: `No change on ${this.subjectKey}.`,
        evidence,
      };
    }

    const diff = diffScrapeSnapshots(priorSnapshot ?? '', normalized);
    const evidence: ScrapeDiffEvidence = {
      url: this.url,
      selector: this.selector,
      tier,
      status,
      content_hash: hash,
      normalized_snapshot: snapshot,
      normalized_length: normalized.length,
      change_kind: 'changed',
      diff,
      __tracked_field: 'content_hash',
    };
    return {
      subject: this.subjectKey,
      summary: `Content drift on ${this.subjectKey}: +${diff.added.length}/-${diff.removed.length} lines.`,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const change = (result.evidence as ScrapeDiffEvidence | undefined)?.change_kind;
    switch (change) {
      case 'changed':
        return 'warning';
      case 'error':
        return 'fail';
      case 'first_seen':
      case 'unchanged':
        return 'pass';
      default:
        return 'fail';
    }
  }

  private errorResult(message: string, tier: string | null = null): ProbeResult {
    const evidence: ScrapeDiffEvidence = {
      url: this.url,
      selector: this.selector,
      tier,
      status: null,
      content_hash: '',
      normalized_snapshot: '',
      normalized_length: 0,
      change_kind: 'error',
      error: message,
    };
    return {
      subject: this.subjectKey,
      summary: `Scrape failed for ${this.subjectKey}: ${message}`,
      evidence,
    };
  }

  private async readPriorFinding(ctx: ExperimentContext): Promise<Finding | null> {
    const recent = await ctx.recentFindings(this.id, 5);
    for (const f of recent) {
      if (f.subject !== this.subjectKey) continue;
      const ev = f.evidence as Partial<ScrapeDiffEvidence> | undefined;
      if (ev?.change_kind && ev.change_kind !== 'error' && ev.content_hash) {
        return f;
      }
    }
    return null;
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

function extractPriorHash(f: Finding): string | null {
  const ev = f.evidence as Partial<ScrapeDiffEvidence> | undefined;
  return typeof ev?.content_hash === 'string' && ev.content_hash.length > 0
    ? ev.content_hash
    : null;
}

function extractPriorSnapshot(f: Finding): string | null {
  const ev = f.evidence as Partial<ScrapeDiffEvidence> | undefined;
  return typeof ev?.normalized_snapshot === 'string' ? ev.normalized_snapshot : null;
}
