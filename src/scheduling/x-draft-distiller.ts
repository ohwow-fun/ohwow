/**
 * x-draft-distiller — hourly job that turns novel market-radar
 * findings into candidate X posts.
 *
 * Per tick:
 *   1. listDistilledInsights({ minScore: 0.7, limit: 5,
 *                              subjectPrefix: 'market:' })
 *   2. Belt-and-braces re-filter to subjects starting with `market:`
 *      (the distiller already enforces this pre-rank, but the local
 *      check keeps downstream assertions — `considered` counter,
 *      draft pipeline — honest if the query contract ever shifts).
 *   3. For each unseen latest_finding_id, prompt an LLM (purpose=
 *      generation, difficulty=simple, max_cost_cents capped) to draft
 *      1-2 tweet-length posts grounded in the finding evidence.
 *   4. Insert into x_post_drafts with status='pending'.
 *
 * Dedup is two-layered: an explicit findDraftByFindingId check to
 * avoid burning an LLM call on a finding we've already drafted, and
 * the UNIQUE (workspace_id, source_finding_id) constraint on the
 * table so concurrent ticks race-safely.
 *
 * Drafting follows the repo's outreach philosophy: conversational,
 * observational, no pitch CTAs, no competitor framing, no corporate
 * boilerplate. See memory `feedback_outreach_philosophy`.
 *
 * Runs only on the 'default' workspace — avenued has its own goals.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { ModelRouter } from '../execution/model-router.js';
import { runLlmCall, type LlmCallDeps } from '../execution/llm-organ.js';
import {
  listDistilledInsights,
  type DistilledInsight,
} from '../self-bench/insight-distiller.js';
import { getRuntimeConfig } from '../self-bench/runtime-config.js';
import { logger } from '../lib/logger.js';
import { findDraftByFindingId, insertDraft } from './x-draft-store.js';
import { buildVoicePrinciples, buildLengthDirective, voiceCheck } from '../lib/voice/voice-core.js';

/**
 * runtime_config_overrides key for the distiller's min novelty score.
 * Read per-tick via getRuntimeConfig so experiments can flip the
 * threshold live (cache TTL is 60s) without a daemon restart — the
 * constructor-provided value is the fallback when no override is set.
 */
export const X_DRAFT_DISTILLER_MIN_SCORE_KEY = 'x_draft_distiller_min_score';

export const MARKET_SUBJECT_PREFIX = 'market:';

const DEFAULT_MIN_SCORE = 0.7;
const DEFAULT_LIMIT = 5;
const MAX_COST_CENTS = 50;
const EXPERIMENT_ID_TAG = 'x-draft-distiller';

export interface XDraftDistillerOptions {
  /** Minimum novelty_score to consider. */
  minScore?: number;
  /** How many insights to pull per tick. */
  limit?: number;
  /** LLM override hook for unit tests. */
  draftTweet?: (insight: DistilledInsight) => Promise<string | null>;
  /**
   * Gap 13: lazy accessor for the engine's autonomous-budget deps.
   * Scheduler-driven distilling is autonomous by definition, so when
   * the daemon wires the middleware via `engine.setBudgetDeps`, each
   * tick's LLM call enrolls in the daily cap + operator toasts. Lazy
   * (not a value) so the distiller can be constructed before
   * `setBudgetDeps` runs during daemon boot. Returns `undefined` when
   * the middleware is unwired (early boot / unit tests) so the call
   * still dispatches.
   */
  getBudgetDeps?: () => LlmCallDeps['budget'];
}

export class XDraftDistillerScheduler {
  private readonly minScore: number;
  private readonly limit: number;
  private readonly draftTweetFn: (insight: DistilledInsight) => Promise<string | null>;
  private readonly getBudgetDeps: () => LlmCallDeps['budget'];

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly modelRouter: ModelRouter | null,
    private readonly workspaceId: string,
    opts: XDraftDistillerOptions = {},
  ) {
    this.minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
    this.limit = opts.limit ?? DEFAULT_LIMIT;
    this.draftTweetFn = opts.draftTweet ?? ((insight) => this.defaultDraft(insight));
    this.getBudgetDeps = opts.getBudgetDeps ?? (() => undefined);
  }

  async tick(): Promise<{ considered: number; drafted: number; skipped: number }> {
    // Read the min-score threshold per tick so experiments can flip
    // it live via runtime_config_overrides without a daemon restart.
    // The constructor-provided value is the fallback when no override
    // is set. Coerce from the stored JSON (which may be a string) to a
    // number; fall back to the instance default if coercion fails.
    const overrideRaw = getRuntimeConfig<unknown>(
      X_DRAFT_DISTILLER_MIN_SCORE_KEY,
      this.minScore,
    );
    const overrideNum =
      typeof overrideRaw === 'number' ? overrideRaw : Number(overrideRaw);
    const effectiveMinScore = Number.isFinite(overrideNum)
      ? overrideNum
      : this.minScore;

    const insights = await listDistilledInsights(this.db, {
      minScore: effectiveMinScore,
      limit: this.limit,
      // Pre-filter inside the distiller so the top-N window is drawn
      // from the market population only. Without this, high-novelty
      // digest/ops/proposal rows at novelty 1.0 crowd out 0.9-score
      // market clusters before the scheduler ever sees them.
      subjectPrefix: MARKET_SUBJECT_PREFIX,
    });
    const market = insights.filter((i) => i.subject?.startsWith(MARKET_SUBJECT_PREFIX));
    let drafted = 0;
    let skipped = 0;

    for (const insight of market) {
      if (!insight.latest_finding_id) {
        skipped += 1;
        continue;
      }
      // Gate the LLM call on whether the finding actually contains a
      // concrete external event. A `verdict_flipped` novelty on static
      // content (change_kind=unchanged, or empty diff) is an artifact
      // of the baseline model reassessing itself — no news the reader
      // would care about. Drafting from it produces the "we've been
      // watching, the verdict flipped" meta-posts. Drop them here so
      // we don't burn LLM budget turning noise into filler.
      if (!hasExternalSignal(insight)) {
        skipped += 1;
        continue;
      }
      if (!hasConcreteContent(insight)) {
        skipped += 1;
        continue;
      }
      const existing = await findDraftByFindingId(
        this.db,
        this.workspaceId,
        insight.latest_finding_id,
      );
      if (existing) {
        skipped += 1;
        continue;
      }
      const body = await this.draftTweetFn(insight);
      if (!body || body.trim().length === 0) {
        skipped += 1;
        continue;
      }
      const row = await insertDraft(this.db, {
        workspaceId: this.workspaceId,
        body: body.trim(),
        sourceFindingId: insight.latest_finding_id,
      });
      if (row) drafted += 1;
      else skipped += 1;
    }

    if (drafted > 0 || market.length > 0) {
      logger.info(
        { considered: market.length, drafted, skipped },
        '[x-draft-distiller] tick complete',
      );
    }
    return { considered: market.length, drafted, skipped };
  }

  private async defaultDraft(insight: DistilledInsight): Promise<string | null> {
    if (!this.modelRouter) {
      logger.debug('[x-draft-distiller] no modelRouter — skipping LLM draft');
      return null;
    }
    const prompt = buildPrompt(insight);
    const result = await runLlmCall(
      {
        modelRouter: this.modelRouter,
        db: this.db,
        workspaceId: this.workspaceId,
        experimentId: EXPERIMENT_ID_TAG,
        // Gap 13: hourly autonomous distillation counts against the
        // daily cap. `getBudgetDeps` is injected by the daemon
        // scheduling phase once the engine's middleware is wired.
        budget: this.getBudgetDeps(),
      },
      {
        purpose: 'generation',
        difficulty: 'simple',
        max_cost_cents: MAX_COST_CENTS,
        prompt,
        max_tokens: 400,
        temperature: 0.7,
      },
    );
    if (!result.ok) {
      logger.info({ err: result.error }, '[x-draft-distiller] LLM call failed');
      return null;
    }
    return sanitizeDraft(result.data.text);
  }
}

/**
 * Gate: does this insight describe a real thing that moved in the
 * world, or just an internal baseline flip? A useful post needs
 * external source material. `verdict_flipped` on `change_kind=unchanged`
 * is the model reassessing itself; an empty diff means nothing the
 * reader could actually repeat. Neither deserves the LLM's time.
 */
export function hasExternalSignal(insight: DistilledInsight): boolean {
  const ev = insight.evidence ?? {};
  if (ev.change_kind !== 'changed') return false;
  const diff = ev.diff as { added?: string[]; removed?: string[] } | undefined;
  const added = diff?.added?.length ?? 0;
  const removed = diff?.removed?.length ?? 0;
  return added + removed > 0;
}

const LOW_SIGNAL_PATTERNS: RegExp[] = [
  /no changes/i,
  /no new releases/i,
  /no updates/i,
  /nothing new/i,
  /unchanged/i,
  /no activity/i,
  /no commits/i,
  /no modifications/i,
];

/**
 * Pre-LLM content quality filter. Returns false when the insight's diff
 * contains only boilerplate low-signal lines (e.g. "No changes", "No new
 * releases") that would produce vacuous posts. Saves an LLM call on findings
 * that technically changed but carry no reader-facing news.
 */
export function hasConcreteContent(insight: DistilledInsight): boolean {
  const ev = insight.evidence ?? {};
  if (ev.change_kind !== 'changed') return false;
  const diff = ev.diff as { added?: string[]; removed?: string[] } | undefined;
  const added = diff?.added ?? [];
  const removed = diff?.removed ?? [];
  if (added.length === 0 && removed.length === 0) return false;
  const allLines = [...added, ...removed].filter((l) => l.trim().length > 0);
  if (allLines.length === 0) return false;
  // If every non-empty line matches a low-signal pattern, there is nothing concrete.
  return allLines.some((line) => !LOW_SIGNAL_PATTERNS.some((p) => p.test(line)));
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has',
  'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his',
  'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way', 'who',
  'boy', 'did', 'she', 'use', 'say',
]);

function isProperNoun(word: string): boolean {
  return (
    word.length >= 8 &&
    /^[A-Z]/.test(word) &&
    !STOP_WORDS.has(word.toLowerCase())
  );
}

/**
 * Scans diff lines for the most salient named entity: a version string or a
 * title-case proper noun. Returns the first matching line, or null.
 */
function extractNamedEntity(diff: { added: string[]; removed: string[] }): string | null {
  const lines = [...diff.added, ...diff.removed];
  for (const line of lines) {
    if (/\b\d+\.\d+/.test(line)) return line;
    const words = line.split(/\s+/);
    if (words.some(isProperNoun)) return line;
  }
  return null;
}

/**
 * Build the LLM prompt for a single insight.
 *
 * Prompt design is from-first-principles on purpose. Older revisions
 * were a list of bans (NO CTA, NO corporate voice, NO product pitch)
 * and produced evasive, passive "we've been watching..." posts —
 * bans describe the shape of failure but leave the LLM with no
 * positive direction, so it retreats into safe meta-commentary.
 *
 * The prompt below instead tells the model who the reader is, what
 * earns a place in their feed, and gives it explicit permission to
 * return `SKIP` when the evidence doesn't support a real post.
 * No banned-phrase list, no example tweets — the model is trusted
 * to be a competent writer if it knows what it's writing for.
 *
 * Mechanism vocabulary (change_kind, novelty_reason, verdict) is
 * deliberately kept out of the evidence summary: every time we leak
 * those labels into the context, the LLM copies them into the post.
 */
export function buildPrompt(insight: DistilledInsight): string {
  const evidenceSummary = summarizeEvidence(insight.evidence);
  return [
    "You're drafting a single short post for a Threads feed.",
    '',
    "The reader is a stranger scrolling. They don't know your account,",
    "your tooling, or that an observation happened at all. You have a",
    'second or two to earn their attention.',
    '',
    'Before writing, identify the one specific thing that moved (not a',
    'category of movement, the actual named change). If you cannot name',
    'it in a clause of under 10 words, return SKIP.',
    '',
    'A post earns its place when one of two things is true:',
    ' - it names a specific thing that moved in the world, concrete enough',
    '   that the reader could repeat it to someone else, or',
    " - it offers a read on that movement the reader didn't have before,",
    '   an implication, a pattern, a take worth a nod.',
    '',
    'Voice is a person thinking out loud. Not a dashboard, not a',
    "newsletter. Don't describe watching, scanning, or flipping verdicts,",
    "that's internal vocabulary the reader neither sees nor cares about.",
    'The post is about the thing, not the act of seeing it.',
    '',
    'The evidence below is source material, not a script. Pull from it',
    "what a human would actually notice. If it doesn't contain something",
    'a reader would care about, reply with exactly `SKIP`. Silence beats',
    "filler, and you're trusted to judge that.",
    '',
    'Format: one post, up to 500 characters. Plain text.',
    'No labels, no surrounding quotes, no hashtags.',
    '',
    '---',
    `Subject: ${insight.subject}`,
    `Summary: ${insight.summary}`,
    evidenceSummary ? `Evidence:\n${evidenceSummary}` : '',
    '',
    buildVoicePrinciples(),
    '',
    'Before writing the post, write one internal line:',
    'ANGLE: <one clause explaining what this change implies for builders, not what changed>',
    'If you cannot fill the ANGLE clause with something specific, return SKIP instead.',
    'The ANGLE line must NOT appear in the final post — it is a scratchpad gate only.',
    '',
    buildLengthDirective({ platform: 'threads', useCase: 'post' }),
  ]
    .filter(Boolean)
    .join('\n');
}

function summarizeEvidence(evidence: Record<string, unknown> | undefined | null): string {
  if (!evidence) return '';
  const parts: string[] = [];
  const url = evidence.url;
  if (typeof url === 'string') parts.push(`url: ${url}`);
  const diff = evidence.diff as
    | { added?: string[]; removed?: string[] }
    | undefined;
  // Prepend the most salient named entity so the LLM has it front-of-context.
  const namedEntity = extractNamedEntity({
    added: diff?.added ?? [],
    removed: diff?.removed ?? [],
  });
  if (namedEntity !== null) parts.unshift(`Named entity: ${namedEntity}`);
  if (diff?.added && diff.added.length > 0) {
    parts.push(`added:\n${diff.added.slice(0, 15).map((l) => `  + ${l}`).join('\n')}`);
  }
  if (diff?.removed && diff.removed.length > 0) {
    parts.push(`removed:\n${diff.removed.slice(0, 15).map((l) => `  - ${l}`).join('\n')}`);
  }
  return parts.join('\n');
}

export function sanitizeDraft(raw: string): string | null {
  if (!raw) return null;
  // Strip any ANGLE: scratchpad lines the model may have leaked into output.
  const stripped = raw
    .split('\n')
    .filter((line) => !/^ANGLE:/i.test(line.trim()))
    .join('\n');
  // Strip leading/trailing quotes the LLM sometimes wraps around output.
  let body = stripped.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  // Drop any "Post:" / "Draft:" prefix an LLM might add despite instructions.
  body = body.replace(/^(?:post|draft|tweet|reply)[:\-\s]+/i, '').trim();
  if (body.length === 0) return null;
  // The prompt invites SKIP when evidence is thin — honor it as a null draft.
  if (/^skip\.?$/i.test(body)) return null;
  // Run the full voice gate (intel leak, AI cliché, structural checks,
  // first-person, etc.) so every rule in voice-core applies here without
  // reimplementing phrase loops in this file.
  const { ok, reasons } = voiceCheck(body, { platform: 'threads', useCase: 'post' });
  if (!ok) {
    logger.info({ reasons }, '[x-draft-distiller] draft rejected by voice gate');
    return null;
  }
  return body;
}
