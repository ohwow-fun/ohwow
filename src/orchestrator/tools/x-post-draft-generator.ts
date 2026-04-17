/**
 * x-post-draft-generator — draft a standalone X post (or Threads post)
 * via the LLM organ, gated by the shared voice-core.
 *
 * Different from reply-copy-generator:
 *   - No target post to reciprocate. Posts are declarations, not
 *     conversation beats.
 *   - A SHAPE menu — the caller picks (or the generator rotates)
 *     between observation / reframe / compression / pattern-spot /
 *     micro-disagreement / absurd-parallel / zinger / reveal. The
 *     menu exists because a single shape ("observation") collapses
 *     to a single sentence pattern over time ("The X is Y, but Z").
 *   - Viral permissions: asymmetric rhythm, pattern-break endings,
 *     cultural range, specific names. Replies operate under
 *     "reciprocate energy"; posts can be bolder.
 *
 * Same as reply-copy-generator:
 *   - voice-core forbiddens (no first-person, no fake-experience,
 *     no corporate softeners, no em dashes, no trailing period).
 *   - The post-LLM voice-check gate is the REAL enforcement — on
 *     failure, try alternates; on total failure, SKIP.
 *
 * mjs parity: scripts/x-experiments/x-compose.mjs has an earlier
 * implementation of this pipeline (JSONL-queued approvals) with a
 * richer prompt. This TS module is designed for in-process callers
 * (schedulers, the orchestrator); the mjs can eventually be retired
 * or delegated to this module once the approval flow is consolidated.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { RuntimeEngine } from '../../execution/engine.js';
import { runLlmCall } from '../../execution/llm-organ.js';
import { logger } from '../../lib/logger.js';
import {
  buildVoicePrinciples,
  buildLengthDirective,
  voiceCheck,
} from '../../lib/voice/voice-core.js';

/**
 * Shape menu — each shape is a structural frame the post can take.
 * Rotating through these prevents single-shape collapse (e.g.,
 * "The X is Y, but Z" becoming every draft). Callers can pin a
 * shape; when not pinned, the generator picks based on topic fit.
 */
export type PostShape =
  /** Notice a specific weird thing + its implication. */
  | 'observation'
  /** Take a settled framing and flip it. */
  | 'reframe'
  /** Compress a general principle into a mundane concrete. */
  | 'compression'
  /** Name a recurring shape across the ecosystem. */
  | 'pattern_spot'
  /** Specific wrong-think that someone is definitely doing. */
  | 'micro_disagreement'
  /** Two unlike things linked structurally. */
  | 'absurd_parallel'
  /** One-line punchline, no setup. */
  | 'zinger'
  /** Setup + pivot + reveal (≤ 3 beats, ending is not a question). */
  | 'reveal';

export const ALL_POST_SHAPES: PostShape[] = [
  'observation',
  'reframe',
  'compression',
  'pattern_spot',
  'micro_disagreement',
  'absurd_parallel',
  'zinger',
  'reveal',
];

/**
 * Short description of each shape, shown to the LLM so it picks the
 * right frame for the topic. Kept tight — the voice-core already
 * covers the stance/craft/forbiddens.
 */
const SHAPE_GUIDANCE: Record<PostShape, string> = {
  observation:
    'Notice one specific weird thing happening in the ecosystem + why it matters. Not a summary, not a thesis — a noticed detail with a small claim.',
  reframe:
    'Take a framing that\'s become consensus and show why it\'s incomplete or wrong. Name the consensus explicitly so the reframe lands.',
  compression:
    'Compress a general principle into a mundane concrete example. The specific beats the abstract.',
  pattern_spot:
    'Name a recurring shape you see across many teams/tools/products. One pattern, stated cleanly. No list.',
  micro_disagreement:
    'Call out a specific wrong-think someone is definitely doing right now. Not contrarian for its own sake — specific enough that the target would recognize themselves.',
  absurd_parallel:
    'Link two unlike things via a shared structure. The tension is the joke; the analogy does the work.',
  zinger:
    'One-line punchline. No setup, no explanation. The whole post is the joke. 40-100 chars.',
  reveal:
    'Setup in 1-2 beats, pivot or reveal at the end. The last line is not a summary and not a Socratic question — it is a twist that reframes the setup.',
};

export interface GeneratePostInput {
  platform: 'x' | 'threads';
  /**
   * Optional shape. When omitted, the generator rotates by hashing
   * the topic + current hour so variety increases over time without
   * stateful tracking.
   */
  shape?: PostShape;
  /**
   * Topic / seed the post is about. Free-form — a headline, a
   * pattern, an insight. When omitted, the generator asks the LLM
   * to pick from its own ecosystem observation.
   */
  topic?: string;
  /** Number of alt drafts to produce alongside the primary. Default 2. */
  alternatesCount?: number;
}

export interface GeneratePostOutput {
  ok: boolean;
  error?: string;
  draft?: string;
  shape?: PostShape;
  alternates?: string[];
  rationale?: string;
  modelUsed?: string;
}

export interface GeneratePostDeps {
  db: DatabaseAdapter;
  engine: RuntimeEngine;
  workspaceId: string;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function pickShape(input: GeneratePostInput): PostShape {
  if (input.shape) return input.shape;
  // Deterministic rotation by topic+hour: same topic in the same
  // hour gets the same shape, but across hours or topics it rotates.
  // No persistent state needed.
  const key = `${input.topic ?? 'freeform'}:${Math.floor(Date.now() / (60 * 60 * 1000))}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return ALL_POST_SHAPES[Math.abs(hash) % ALL_POST_SHAPES.length];
}

function buildSystemPrompt(platform: 'x' | 'threads', shape: PostShape): string {
  return [
    'You draft standalone posts for X / Threads. A senior builder who',
    'ships agents for a living must either save, agree, or disagree.',
    '"Competent dev-tip energy" is a FAIL. "Vaguely on-brand" is a FAIL.',
    '',
    buildVoicePrinciples(),
    '',
    'POST-SPECIFIC (standalone, not a reply):',
    '  - Asymmetric rhythm is welcome. Short punchy sentences beat',
    '    balanced medium ones. A 4-word stab is a valid post.',
    '  - Pattern-break endings only. The last line pivots or reveals —',
    '    it is NOT a summary, NOT a Socratic "what do you think" question.',
    '  - Specific names and numbers > abstract categories. "Claude",',
    '    "Anthropic", "the new Sonnet release", "MCP servers" — not',
    '    "LLMs" / "AI tools" / "the ecosystem".',
    '  - Cultural range allowed but sparingly. Tech history, adjacent',
    '    fields, an occasional non-tech reference — only when organic.',
    '    Forced pop-culture is worse than none.',
    '  - Stay in lane: agents, AI runtimes, prompt engineering, MCP,',
    '    agent orchestration, local-first infra. Do NOT fake expertise',
    '    in verticals (trading, bioinformatics, legal, game dev) we',
    '    do not live in.',
    '',
    'SHAPE for this draft: ' + shape.toUpperCase(),
    '  ' + SHAPE_GUIDANCE[shape],
    '',
    buildLengthDirective({ platform, useCase: 'post' }),
    '',
    'WHEN TO SKIP (return draft: "SKIP"):',
    '  - The topic is too generic to say anything specific.',
    '  - The natural post would be a pitch, hype, or product-mention.',
    '  - The claim would need evidence you cannot support.',
    '  - You would have to misread the topic to say something good.',
    '    Better to say nothing than post something generic.',
    '',
    'OUTPUT (JSON, nothing else):',
    '  {',
    '    "draft":      string  // primary post, ready to publish as-is',
    '    "alternates": string[]  // 0-2 differently-angled drafts of the same shape',
    '    "rationale":  string  // one sentence on why this lands',
    '  }',
    '  or on skip:',
    '  { "draft": "SKIP", "rationale": "one sentence on why" }',
  ].join('\n');
}

function buildUserPrompt(input: GeneratePostInput): string {
  return [
    `Platform: ${input.platform}`,
    input.topic ? `Topic / seed:\n${input.topic.slice(0, 2000)}` : 'No specific topic — pick one observation from the current ecosystem that the shape fits.',
    '',
    'Draft ONE post. Return the JSON.',
  ].join('\n');
}

function parseLlmJson(raw: string): { draft: string; alternates?: string[]; rationale?: string } | null {
  let cleaned = raw.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < firstBrace) return null;
  cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const draft = typeof parsed.draft === 'string' ? parsed.draft.trim() : null;
    if (!draft) return null;
    const alternates = Array.isArray(parsed.alternates)
      ? parsed.alternates.filter((s: unknown): s is string => typeof s === 'string').map((s: string) => s.trim())
      : undefined;
    const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim() : undefined;
    return { draft, alternates, rationale };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function generatePostDraft(
  deps: GeneratePostDeps,
  input: GeneratePostInput,
): Promise<GeneratePostOutput> {
  if (!deps.engine.modelRouter) {
    return { ok: false, error: 'modelRouter not available' };
  }

  const shape = pickShape(input);
  const system = buildSystemPrompt(input.platform, shape);
  const prompt = buildUserPrompt(input);

  const llm = await runLlmCall(
    {
      modelRouter: deps.engine.modelRouter,
      db: deps.db,
      workspaceId: deps.workspaceId,
    },
    {
      purpose: 'reasoning',
      system,
      prompt,
      max_tokens: 600,
      // Slightly higher than reply-generator's 0.4 — shapes like
      // zinger + absurd_parallel benefit from a little more variance.
      temperature: 0.6,
    },
  );

  if (!llm.ok) {
    logger.warn({ err: llm.error, shape }, '[x-post-draft] llm call failed');
    return { ok: false, error: llm.error };
  }

  const parsed = parseLlmJson(llm.data.text);
  if (!parsed) {
    return {
      ok: false,
      error: `could not parse LLM output as JSON: ${llm.data.text.slice(0, 200)}`,
    };
  }

  if (parsed.draft === 'SKIP') {
    logger.info({ shape, rationale: parsed.rationale }, '[x-post-draft] LLM returned SKIP');
    return {
      ok: true,
      draft: 'SKIP',
      shape,
      rationale: parsed.rationale,
      modelUsed: llm.data.model_used,
    };
  }

  // Post-hoc scrub: trailing period. voice-core's gate would reject
  // it anyway, but fixing trivially-fixable violations here saves a
  // whole generation round.
  parsed.draft = parsed.draft.replace(/\.\s*$/, '');
  if (Array.isArray(parsed.alternates)) {
    parsed.alternates = parsed.alternates.map((a) => a.replace(/\.\s*$/, ''));
  }

  // Voice gate. Same cascade as reply-generator: primary fails → try
  // alternates → first passing wins. No alternate passes → SKIP so
  // the caller moves on instead of publishing voice-violating copy.
  const ctx = { platform: input.platform, useCase: 'post' as const };
  const primaryCheck = voiceCheck(parsed.draft, ctx);
  if (primaryCheck.ok) {
    return {
      ok: true,
      draft: parsed.draft,
      shape,
      alternates: parsed.alternates,
      rationale: parsed.rationale,
      modelUsed: llm.data.model_used,
    };
  }

  logger.info(
    { shape, reasons: primaryCheck.reasons, draft: parsed.draft.slice(0, 80) },
    '[x-post-draft] primary draft tripped voice check; scanning alternates',
  );

  for (const alt of parsed.alternates ?? []) {
    const altCheck = voiceCheck(alt, ctx);
    if (altCheck.ok) {
      logger.info({ shape, chars: alt.length }, '[x-post-draft] promoted alternate after primary failure');
      return {
        ok: true,
        draft: alt,
        shape,
        alternates: (parsed.alternates ?? []).filter((a) => a !== alt),
        rationale: parsed.rationale,
        modelUsed: llm.data.model_used,
      };
    }
  }

  logger.info(
    { shape, primaryReasons: primaryCheck.reasons, alternatesCount: parsed.alternates?.length ?? 0 },
    '[x-post-draft] all drafts tripped voice check; skipping',
  );
  return {
    ok: true,
    draft: 'SKIP',
    shape,
    rationale: `voice check failed: ${primaryCheck.reasons.join(', ')}`,
    modelUsed: llm.data.model_used,
  };
}
