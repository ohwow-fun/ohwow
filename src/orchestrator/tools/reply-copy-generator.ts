/**
 * reply-copy-generator.ts — draft a reply to a scanned post in a
 * calibrated conversational voice.
 *
 * Voice spec (first-principles only — deliberately no canonical
 * example drafts. Examples anchor the model on phrasing it then
 * copies wholesale or ablates into tics. Revised 2026-04-17 after
 * observing first-person narrative slippage like "I've lost so
 * many threads trying to switch models..." / "You end up spending
 * more time reconciling agent decisions than writing the original
 * prompt").
 *
 * STANCE principles:
 *   - Observational, not narrative. The voice notices and opines,
 *     it does not claim to have lived through specific events.
 *   - Curious, not corrective. Opens a question or reframe; does not
 *     restate the author's point back at them.
 *   - Reciprocates energy. Questions invite statements, statements
 *     invite questions or contrasting claims.
 *
 * CRAFT principles:
 *   - One observation + one concrete mechanism. Not a two-step lecture.
 *   - Specific beats abstract. Name the thing that causes the effect,
 *     not the category label.
 *   - Adds a dimension the post did not already cover. Agreement
 *     alone is dead air; mild dissent or a reframe earns the read.
 *
 * FORBIDDEN (structural, not stylistic):
 *   - First-person: I, me, my, mine, we, us, our, I've, I'm, I'd.
 *     These turn opinions into claims about the author's private
 *     experience — the voice does not have private experience.
 *   - Fake-experience phrasing: "I've seen", "my experience",
 *     "when I tried", "I lost", "in practice I", "I've been", "I ran
 *     into", "we found". Same reason as first-person.
 *   - Self-reference, pitches, product names (unless the post named
 *     them first). Sign-offs. Hashtags. Em dashes. "Please".
 *     Trailing period. Corporate softeners ("great take",
 *     "happy to"), lecture openers ("at the end of the day",
 *     "here's the thing", "the key is").
 *
 * LENGTH: 80-200 chars typical. Hard cap 240 X / 280 Threads.
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
    'You draft replies to social posts in a specific voice.',
    'These are first-principles rules — follow them structurally. Do NOT',
    'imitate example replies (none are given, deliberately).',
    '',
    'STANCE:',
    '  - Observational, not narrative. The voice notices and opines,',
    '    but never claims to have personally experienced specific events.',
    '  - Curious + exploring, not corrective. Open a question or reframe;',
    '    never restate the author\'s point back at them or imply they',
    '    missed something obvious.',
    '  - Peer-to-peer. Same level as the author — not an expert teaching,',
    '    not a fan praising.',
    '  - Reciprocate energy. A question invites a statement back; a',
    '    statement invites a question or a contrasting claim. Match',
    '    register (dry / playful / technical) without copying phrasing.',
    '',
    'CRAFT:',
    '  - Compress to one idea + one concrete mechanism. Not a two-step',
    '    lecture, not a question + answer combo.',
    '  - Specific beats abstract. Name the actual cause, not its category.',
    '  - Add a dimension the post did not already cover. Agreement alone',
    '    is dead air; mild dissent or a reframe is why anyone reads a reply.',
    '',
    'FORBIDDEN:',
    '  - FIRST-PERSON pronouns: I, me, my, mine, we, us, our, I\'ve, I\'m,',
    '    I\'d, I\'ll, I was. These make the voice sound like a marketer',
    '    dropping fake experience. The voice does not have private',
    '    experience to share.',
    '  - FAKE-EXPERIENCE phrasing: "I\'ve seen", "my experience",',
    '    "when I tried", "I lost", "in practice I", "I ran into",',
    '    "we found", "when we", "we ended up", "I spent". Same reason.',
    '    Opinions and observations land; personal narrative does not.',
    '  - Pitches of any kind. No products, tools, companies named unless',
    '    the post named them first.',
    '  - Corporate softeners: "happy to discuss", "great take/point",',
    '    "this is interesting", "love this", "100%".',
    '  - Lecture openers: "at the end of the day", "table stakes",',
    '    "the real question is", "here\'s the thing", "the key is",',
    '    "honestly", "tbh".',
    '  - Em dashes (— or –). Use periods, commas, semicolons, line breaks.',
    '  - "Please". Hashtags. Links. Sign-offs.',
    '  - Emojis, unless the post itself used them AND one fits naturally.',
    '  - A trailing period at the end of the reply. Internal sentence',
    '    periods are fine; just no final ".".',
    '  - Drift/tic vocabulary overused recently, use sparingly:',
    '    "scope ownership", "context rot". Use only when they are the',
    '    single most precise term, never as a default reach.',
    '',
    `LENGTH: cap ${cap} characters. Aim 80-200. Shorter usually better.`,
    '',
    'WHEN TO SKIP (return draft: "SKIP"):',
    '  - The post is a pitch, link-drop, affiliate, or promo.',
    '  - Combative flame-bait. Engagement feeds it.',
    '  - Pure restatement with nothing to grip.',
    '  - You would have to misread the post to reply usefully.',
    '    Better to say nothing than to post something generic.',
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

  // First-person markers. The voice is observational, not narrative:
  // opinions + mechanisms, never personal experience claims. These
  // patterns are the tell that the model slipped into "builder voice"
  // and started inventing fake lived-through moments.
  //
  // Word-boundary '\bI\b' matches the pronoun but not words containing
  // 'i' like 'interesting'. Case-sensitive on purpose — lowercase 'i'
  // isn't the pronoun in English-legitimate writing.
  const firstPersonPatterns: Array<[RegExp, string]> = [
    [/\bI\b/, 'firstPerson:I'],
    [/\bI'(?:ve|m|d|ll|s|re)\b/i, 'firstPerson:I-contraction'],
    [/\bme\b/i, 'firstPerson:me'],
    [/\bmy\b/i, 'firstPerson:my'],
    [/\bmine\b/i, 'firstPerson:mine'],
    [/\bwe\b/i, 'firstPerson:we'],
    [/\bus\b/i, 'firstPerson:us'],
    [/\bour\b/i, 'firstPerson:our'],
  ];
  for (const [re, label] of firstPersonPatterns) {
    if (re.test(text)) reasons.push(label);
  }

  // Fake-experience phrasing. Catches common second-person narrative
  // that reads as recycled "you know when you..." experience-mining.
  const fakeExperiencePatterns: Array<[RegExp, string]> = [
    [/\byou end up\b/i, 'fakeExperience:you-end-up'],
    [/\byou (?:find|found)\b/i, 'fakeExperience:you-found'],
    [/\bin (?:my|our) experience\b/i, 'fakeExperience:my-experience'],
    [/\bwhen (?:you|i) tr(?:y|ied)\b/i, 'fakeExperience:when-you-try'],
  ];
  for (const [re, label] of fakeExperiencePatterns) {
    if (re.test(text)) reasons.push(label);
  }

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

  // Voice-check is a gate, not a warning. If a draft contains
  // first-person / fake-experience / softeners / etc., an alternate
  // that passes gets promoted to primary; if no alternate passes,
  // the whole candidate gets SKIP'd so the scheduler moves on to
  // the next target. Previously the failing draft was published
  // anyway with just a log line, which is how the 10:28 "I've lost
  // so many threads" reply escaped.
  const primaryCheck = voiceCheck(parsed.draft, input.platform);
  if (primaryCheck.ok) {
    return {
      ok: true,
      draft: parsed.draft,
      alternates: parsed.alternates,
      rationale: parsed.rationale,
      modelUsed: llm.data.model_used,
    };
  }

  logger.info(
    { reasons: primaryCheck.reasons, draft: parsed.draft.slice(0, 80) },
    '[reply-copy] primary draft tripped voice check; scanning alternates',
  );

  // Try alternates in order; first passing one becomes the primary.
  for (const alt of parsed.alternates ?? []) {
    const altCheck = voiceCheck(alt, input.platform);
    if (altCheck.ok) {
      logger.info(
        { chars: alt.length },
        '[reply-copy] promoted alternate draft after primary voice-check failure',
      );
      return {
        ok: true,
        draft: alt,
        alternates: (parsed.alternates ?? []).filter((a) => a !== alt),
        rationale: parsed.rationale,
        modelUsed: llm.data.model_used,
      };
    }
  }

  logger.info(
    { primaryReasons: primaryCheck.reasons, alternatesCount: parsed.alternates?.length ?? 0 },
    '[reply-copy] all drafts tripped voice check; skipping candidate',
  );
  return {
    ok: true,
    draft: 'SKIP',
    rationale: `voice check failed: ${primaryCheck.reasons.join(', ')}`,
    modelUsed: llm.data.model_used,
  };
}
