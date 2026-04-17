/**
 * reply-copy-generator.ts — draft a reply to a scanned post in a
 * calibrated conversational voice.
 *
 * Voice spec (locked in 2026-04-17 with operator review):
 *   - One observation + one concrete mechanism. Not a two-step lecture.
 *   - Specific mechanisms beat abstract principles ("context rot" >
 *     "coherence failure"). Name the thing.
 *   - Sound like you've done the work, not explained the work. Skip
 *     "table stakes", "at the end of the day", consultant openers.
 *   - Reciprocate the post's energy — question gets a statement, a
 *     statement gets a question.
 *   - No em dashes. No "please". No sign-offs. No hashtags.
 *   - Length: ≤240 chars (X), ≤280 chars (Threads). Leave room.
 *   - Never pitch. Never name the product. Never self-reference.
 *
 * Calibration examples (the winning drafts from the Apr-17 review):
 *   "Confidence without a verifier is the default failure mode of LLM
 *    agents right now."
 *   "Compaction is the quiet one. Most long-running agents I've seen
 *    die from context rot, not lack of checkpoints."
 *   "What kind of office work are you trying to offload first? The
 *    hardest part is usually scoping which bottleneck the agent
 *    actually owns."
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { RuntimeEngine } from '../../execution/engine.js';
import { runLlmCall } from '../../execution/llm-organ.js';
import type { ReplyCandidate } from './reply-target-selector.js';
import { logger } from '../../lib/logger.js';

export interface GenerateReplyInput {
  target: ReplyCandidate;
  platform: 'x' | 'threads';
  /** Optional extra steering per-call. Kept short; long prompts drift. */
  extraGuidance?: string;
  /** How many alt drafts to generate alongside the primary. Default 2. */
  alternatesCount?: number;
}

export interface GenerateReplyOutput {
  ok: boolean;
  error?: string;
  draft?: string;
  alternates?: string[];
  rationale?: string;
  modelUsed?: string;
}

const X_MAX = 240;
const THREADS_MAX = 280;

function buildSystemPrompt(platform: 'x' | 'threads'): string {
  const cap = platform === 'x' ? X_MAX : THREADS_MAX;
  return [
    'You draft replies on social posts in a specific voice. Your job is to',
    'produce a reply that someone thoughtful would actually write: a real',
    'observation, not a marketing intervention.',
    '',
    'VOICE RULES (non-negotiable):',
    '  1. One observation plus one concrete mechanism. Not two separate',
    '     thoughts. Not a problem statement followed by a lecture.',
    '  2. Name the specific mechanism. Say "context rot" instead of',
    '     "coherence failure". Say "scope ownership" instead of',
    '     "stakeholder alignment". Nouns do work.',
    '  3. Sound like someone who has done the work. Do NOT explain the',
    '     work. Skip phrases like: "at the end of the day",',
    '     "table stakes", "the real question is", "I think the key is",',
    '     "here\'s the thing".',
    '  4. Reciprocate energy. If the post asks a question, answer with',
    '     a statement. If the post makes a claim, end with a question',
    '     that invites their next thought.',
    '  5. No em dashes (use periods, commas, semicolons, or line breaks).',
    '     No "please". No sign-offs. No hashtags. No links. No emojis',
    '     unless the post itself used them AND one fits naturally.',
    `  6. Length cap ${cap} characters. Aim for 120-200. Leave room.`,
    '  7. Never pitch anything. Never describe a product. Never name a',
    '     company or tool unless the post did first. You are a person,',
    '     not a marketer.',
    '  8. No corporate softeners ("happy to discuss", "great take",',
    '     "this is interesting"). Get to the point.',
    '  9. If the post is low-effort or off-topic, return the literal word',
    '     "SKIP" (without quotes). It is better to say nothing than',
    '     something generic.',
    '',
    'OUTPUT FORMAT:',
    '  Return a JSON object (and nothing else) with fields:',
    '    draft:      string — the primary reply, ready to post as-is',
    '    alternates: array of 0-2 alternate drafts in different',
    '                directions (shorter, question-first, etc)',
    '    rationale:  one short sentence on why this reply fits',
    '  OR if the post should be skipped:',
    '    draft:      "SKIP"',
    '    rationale:  one short sentence on why',
    '',
    'CALIBRATION EXAMPLES (these are the voice):',
    '  Post: "Your LLM agent just mass-deleted a production database..."',
    '  Reply: "Confidence without a verifier is the default failure mode of LLM agents right now."',
    '',
    '  Post: "Anthropic published an article on how to build a long-running agent..."',
    '  Reply: "Compaction is the quiet one. Most long-running agents I\'ve seen die from context rot, not lack of checkpoints."',
    '',
    '  Post: "I\'m looking for someone that can build ai agents to automate an office"',
    '  Reply: "What kind of office work are you trying to offload first? The hardest part is usually scoping which bottleneck the agent actually owns."',
  ].join('\n');
}

function buildUserPrompt(target: ReplyCandidate, platform: 'x' | 'threads', extra?: string): string {
  return [
    `Platform: ${platform}`,
    `Author: @${target.authorHandle}`,
    `Post URL: ${target.url}`,
    `Post text:`,
    '```',
    (target.text || '').slice(0, 2000),
    '```',
    '',
    extra ? `Additional steering: ${extra}` : '',
    'Now return the JSON.',
  ].filter(Boolean).join('\n');
}

function parseLlmJson(raw: string): { draft: string; alternates?: string[]; rationale?: string } | null {
  // Strip common wrappers: markdown fences, leading prose.
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

/**
 * Light post-processing on a draft to catch voice violations the model
 * slipped past. We do NOT rewrite — if something egregious, the caller
 * should reject and re-draft (or skip).
 */
export function voiceCheck(text: string, platform: 'x' | 'threads'): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const cap = platform === 'x' ? X_MAX : THREADS_MAX;
  if (text.length > cap) reasons.push(`length(${text.length}>cap${cap})`);
  if (/—|–/.test(text)) reasons.push('emDash');
  if (/\bplease\b/i.test(text)) reasons.push('please');
  if (/#\w/.test(text)) reasons.push('hashtag');
  if (/\bhttps?:\/\//.test(text)) reasons.push('link');
  // Corporate softeners
  const softeners = ['great take', 'this is interesting', 'happy to', 'at the end of the day', 'table stakes', 'the real question is', "here's the thing", 'the key is'];
  for (const s of softeners) {
    if (text.toLowerCase().includes(s)) reasons.push(`softener:${s}`);
  }
  // Sign-offs
  const signoffs = ['thanks!', 'cheers', 'best,', 'hope this helps'];
  for (const s of signoffs) {
    if (text.toLowerCase().includes(s)) reasons.push(`signoff:${s}`);
  }
  return { ok: reasons.length === 0, reasons };
}

export interface GenerateReplyDeps {
  db: DatabaseAdapter;
  engine: RuntimeEngine;
  workspaceId: string;
}

export async function generateReplyCopy(
  deps: GenerateReplyDeps,
  input: GenerateReplyInput,
): Promise<GenerateReplyOutput> {
  if (!input.target.text || input.target.text.trim().length < 10) {
    return { ok: false, error: 'target post has no text to respond to' };
  }
  if (!deps.engine.modelRouter) {
    return { ok: false, error: 'modelRouter not available' };
  }

  const system = buildSystemPrompt(input.platform);
  const prompt = buildUserPrompt(input.target, input.platform, input.extraGuidance);

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
      temperature: 0.4, // some variation but not wild
    },
  );

  if (!llm.ok) {
    logger.warn({ err: llm.error }, '[reply-copy] llm call failed');
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
    return {
      ok: true,
      draft: 'SKIP',
      rationale: parsed.rationale,
      modelUsed: llm.data.model_used,
    };
  }

  const check = voiceCheck(parsed.draft, input.platform);
  if (!check.ok) {
    logger.info(
      { reasons: check.reasons, draft: parsed.draft.slice(0, 80) },
      '[reply-copy] draft tripped voice check',
    );
  }

  return {
    ok: true,
    draft: parsed.draft,
    alternates: parsed.alternates,
    rationale: parsed.rationale,
    modelUsed: llm.data.model_used,
  };
}
