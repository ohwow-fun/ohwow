/**
 * x-draft-distiller — hourly job that turns novel market-radar
 * findings into candidate X posts.
 *
 * Per tick:
 *   1. listDistilledInsights({ minScore: 0.7, limit: 5 })
 *   2. Filter to subjects starting with `market:`
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
import { runLlmCall } from '../execution/llm-organ.js';
import {
  listDistilledInsights,
  type DistilledInsight,
} from '../self-bench/insight-distiller.js';
import { logger } from '../lib/logger.js';
import { findDraftByFindingId, insertDraft } from './x-draft-store.js';

export const MARKET_SUBJECT_PREFIX = 'market:';

const DEFAULT_MIN_SCORE = 0.7;
const DEFAULT_LIMIT = 5;
const TWEET_CHAR_CAP = 280;
const MAX_COST_CENTS = 50;
const EXPERIMENT_ID_TAG = 'x-draft-distiller';

export interface XDraftDistillerOptions {
  /** Minimum novelty_score to consider. */
  minScore?: number;
  /** How many insights to pull per tick. */
  limit?: number;
  /** LLM override hook for unit tests. */
  draftTweet?: (insight: DistilledInsight) => Promise<string | null>;
}

export class XDraftDistillerScheduler {
  private readonly minScore: number;
  private readonly limit: number;
  private readonly draftTweetFn: (insight: DistilledInsight) => Promise<string | null>;

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly modelRouter: ModelRouter | null,
    private readonly workspaceId: string,
    opts: XDraftDistillerOptions = {},
  ) {
    this.minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
    this.limit = opts.limit ?? DEFAULT_LIMIT;
    this.draftTweetFn = opts.draftTweet ?? ((insight) => this.defaultDraft(insight));
  }

  async tick(): Promise<{ considered: number; drafted: number; skipped: number }> {
    const insights = await listDistilledInsights(this.db, {
      minScore: this.minScore,
      limit: this.limit,
    });
    const market = insights.filter((i) => i.subject?.startsWith(MARKET_SUBJECT_PREFIX));
    let drafted = 0;
    let skipped = 0;

    for (const insight of market) {
      if (!insight.latest_finding_id) {
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
 * Build the LLM prompt for a single insight. Grounded in the finding
 * evidence, conservative, anti-promotional. The prompt explicitly
 * bans pitch CTAs and corporate framing — see the outreach
 * philosophy in CLAUDE.md / memory.
 */
export function buildPrompt(insight: DistilledInsight): string {
  const evidenceSummary = summarizeEvidence(insight.evidence);
  return [
    'You draft a single short post for X, grounded in a piece of market-drift',
    'evidence I just observed. Constraints:',
    '',
    '- Write ONE post, 1-2 tweets long, each tweet ≤ 280 chars.',
    '- Conversational tone. First-person plural is fine. No corporate voice.',
    '- NO call-to-action. NO "check out", "sign up", "try our", "DM me".',
    '- NO product pitch. NO mention of ohwow or competitors by name unless',
    '  they are the subject of the observation itself.',
    '- Do not make claims you cannot support from the evidence below.',
    '- If the evidence is thin, stay observational. Describe what shifted.',
    '- Output just the post text. No preamble, no quotes, no hashtags.',
    '',
    `Subject: ${insight.subject}`,
    `Signal summary: ${insight.summary}`,
    `Novelty reason: ${insight.novelty_reason}`,
    evidenceSummary ? `Evidence:\n${evidenceSummary}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function summarizeEvidence(evidence: Record<string, unknown> | undefined | null): string {
  if (!evidence) return '';
  const parts: string[] = [];
  const url = evidence.url;
  if (typeof url === 'string') parts.push(`url: ${url}`);
  const changeKind = evidence.change_kind;
  if (typeof changeKind === 'string') parts.push(`change_kind: ${changeKind}`);
  const diff = evidence.diff as
    | { added?: string[]; removed?: string[] }
    | undefined;
  if (diff?.added && diff.added.length > 0) {
    parts.push(`added:\n${diff.added.slice(0, 15).map((l) => `  + ${l}`).join('\n')}`);
  }
  if (diff?.removed && diff.removed.length > 0) {
    parts.push(`removed:\n${diff.removed.slice(0, 15).map((l) => `  - ${l}`).join('\n')}`);
  }
  return parts.join('\n');
}

function sanitizeDraft(raw: string): string | null {
  if (!raw) return null;
  // Strip leading/trailing quotes the LLM sometimes wraps around output.
  let body = raw.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  // Drop any "Post:" / "Draft:" prefix an LLM might add despite instructions.
  body = body.replace(/^(?:post|draft|tweet|reply)[:\-\s]+/i, '').trim();
  if (body.length === 0) return null;
  if (body.length > TWEET_CHAR_CAP * 2 + 10) {
    body = body.slice(0, TWEET_CHAR_CAP * 2 + 10);
  }
  return body;
}
