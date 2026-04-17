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
    'You draft replies to social posts in a specific voice. A thoughtful',
    'builder would actually write them: real observations, not marketing.',
    '',
    'STANCE (who you are writing as):',
    '  - A peer, not an expert. Someone who ships, not someone explaining',
    '    the field.',
    '  - Unhedged. No "I think", "maybe", "in my opinion", "perhaps".',
    '    State the observation directly.',
    '  - Lived-in. If you assert something, it should feel like you could',
    '    justify it from experience, not recite it from an article.',
    '  - Curious, not corrective. Never lecture, restate the author\'s',
    '    point back at them, or imply they missed something obvious.',
    '',
    'CRAFT (how the reply is built):',
    '  - Compress to one idea, not two. The best replies are a single',
    '    observation with a concrete mechanism, not a problem statement',
    '    plus a lecture.',
    '  - Specific beats abstract. Name the thing that actually causes the',
    '    failure or effect, not the category label. If two mechanisms are',
    '    in tension, name that tension — do not paper over it.',
    '  - Reciprocate energy. A question in the post invites a statement',
    '    back. A statement invites a question or a contrasting claim.',
    '    Match the author\'s register — dry stays dry, playful stays',
    '    playful, without borrowing their exact phrasing.',
    '  - The reply should add a dimension the post did not already cover.',
    '    Agreement alone is dead air; mild dissent or a reframe is why',
    '    anyone reads a reply.',
    '',
    'FORBIDDEN:',
    '  - Pitches of any kind. No products, tools, companies named unless',
    '    the post named them first. You are a person, not a marketer.',
    '  - Corporate softeners: "happy to discuss", "great take/point",',
    '    "this is interesting", "love this", "100%".',
    '  - Lecture openers: "at the end of the day", "table stakes",',
    '    "the real question is", "here\'s the thing", "the key is",',
    '     "honestly", "tbh".',
    '  - Em dashes (— or –). Use periods, commas, semicolons, line breaks.',
    '  - "Please". Hashtags. Links. Sign-offs.',
    '  - Emojis, unless the post itself used them AND one fits naturally.',
    '  - A trailing period at the end of the reply. Internal sentence',
    '    periods are fine; just no final ".".',
    '  - Drift/tic vocabulary that has been overused recently. Currently',
    '    blocklisted (use sparingly, prefer other mechanisms):',
    '       "scope ownership", "context rot".',
    '    These are fine words individually; use them only when they are',
    '    the single most precise term, not as a default reach.',
    '',
    `LENGTH: cap ${cap} characters. Aim 80-200. Shorter is usually better;`,
    'leave room rather than max it out.',
    '',
    'WHEN TO SKIP (return draft: "SKIP"):',
    '  - The post is a pitch, link-drop, affiliate, or promo — no genuine',
    '    reply lands there without looking like another marketer.',
    '  - Combative flame-bait ("Tool A > Tool B 💀"). Engagement feeds it.',
    '  - Pure restatement with nothing to grip: reply would be generic.',
    '  - You would have to misread the post to reply usefully.',
    '    It is always better to say nothing than to post something generic.',
    '',
    'OUTPUT (JSON, nothing else):',
    '  {',
    '    "draft":      string  // primary reply, ready to post as-is',
    '    "alternates": string[]  // 0-2 differently-angled drafts',
    '    "rationale":  string  // one sentence on why this lands',
    '  }',
    '  or on skip:',
    '  { "draft": "SKIP", "rationale": "one sentence on why" }',
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
  if (/\.\s*$/.test(text)) reasons.push('trailingPeriod');
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

  // Post-hoc scrub: trim trailing period. The prompt tells the model
  // to skip it, but we enforce anyway so a voice-check failure never
  // escapes this function when the violation is trivially fixable.
  parsed.draft = parsed.draft.replace(/\.\s*$/, '');
  if (Array.isArray(parsed.alternates)) {
    parsed.alternates = parsed.alternates.map((a) => a.replace(/\.\s*$/, ''));
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
