/**
 * reply-copy-generator.ts — draft a reply to a scanned post in the
 * ohwow voice. Voice principles + forbidden-phrase list live in
 * src/lib/voice/voice-core.ts (single source of truth); this file
 * layers the reply-specific shape menu + opening-diversity rules
 * on top, and runs the post-hoc voiceCheck gate.
 *
 * Revised 2026-04-17: removed first-person narrative slippage
 * (voice-core.FIRST_PERSON_PATTERNS).
 * Revised 2026-04-18 (d74965b): demoted questions from default
 * to earned-only. Default ending is a statement, not "?".
 * Revised 2026-04-18 (this commit): banned "The "-initial openings
 * and the "The X. The Y." parallel-clause template. Moved the
 * opening-diversity rule above the shape menu so it constrains
 * shape selection rather than post-correcting it. Added voiceCheck
 * machine gate for both patterns.
 *
 * Intentional non-feature: no canonical example drafts in the
 * system prompt. Examples anchor the model on phrasing which it
 * then copies wholesale or ablates into tics. First-principles
 * only — see the SHAPE MENU + OPENING rule for structure.
 *
 * LENGTH: see LENGTH_CAPS in voice-core.ts. Reply target ~40-200.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { RuntimeEngine } from '../../execution/engine.js';
import { runLlmCall } from '../../execution/llm-organ.js';
import type { ReplyCandidate } from './reply-target-selector.js';
import { logger } from '../../lib/logger.js';
import {
  buildVoicePrinciples,
  buildLengthDirective,
  voiceCheck as voiceCoreCheck,
  autoFixCosmetic,
  LENGTH_CAPS,
} from '../../lib/voice/voice-core.js';

export type ReplyMode = 'direct' | 'viral' | 'buyer_intent' | 'praise';

/**
 * Map a classifier verdict class to the right drafter mode. The scheduler
 * calls this after classification to pick the prompt that matches the
 * post's audience. Keep the mapping narrow: if the classifier confidently
 * labels the post as a hiring-intent buyer or an adjacent prospect, we
 * switch voice; everything else stays on the 'direct' observational
 * drafter.
 */
export function drafterModeForClass(
  queryMode: 'direct' | 'viral',
  classifierClass: string,
): ReplyMode {
  if (queryMode === 'viral') return 'viral';
  if (classifierClass === 'buyer_intent') return 'buyer_intent';
  if (classifierClass === 'adjacent_prospect') return 'praise';
  return 'direct';
}

export interface GenerateReplyInput {
  target: ReplyCandidate;
  platform: 'x' | 'threads';
  /**
   * Reply mode drives the system prompt.
   *   - direct: 1:1 reply to a real operator (genuine_pain or
   *     solo_service_provider). Prompts for one observation + one
   *     concrete mechanism.
   *   - viral: broadcast reply into a crowded ICP-packed thread. Prompts
   *     for a sharp counter / unexpected cost / category-mistake that
   *     stands out against 30-150 other replies.
   * Default 'direct' for backward compat with existing callers.
   */
  mode?: ReplyMode;
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

// Length caps kept as re-exports for call-sites that still import them
// directly. voiceCheck uses LENGTH_CAPS from voice-core under the hood.
const X_MAX = LENGTH_CAPS.x.reply;
const THREADS_MAX = LENGTH_CAPS.threads.reply;

// Exported for testing and for the classifier's rationale prompts.
export function buildReplySystemPrompt(platform: 'x' | 'threads', mode: ReplyMode = 'direct'): string {
  switch (mode) {
    case 'viral': return buildViralPiggybackSystemPrompt(platform);
    case 'buyer_intent': return buildBuyerIntentSystemPrompt(platform);
    case 'praise': return buildPraiseSystemPrompt(platform);
    case 'direct':
    default: return buildSystemPrompt(platform);
  }
}

function buildSystemPrompt(platform: 'x' | 'threads'): string {
  return [
    'You draft replies to social posts in a specific voice.',
    'These are first-principles rules — follow them structurally. Do NOT',
    'imitate example replies (none are given, deliberately).',
    '',
    buildVoicePrinciples(),
    '',
    'OPENING — structural rule, not suggestion:',
    '  Do NOT start a draft with "The ". It is the default output shape of',
    '  a templated generator and the single clearest tell that a reply was',
    '  written by a bot. Start with one of:',
    '    - a verb or gerund:        "Naming the specific shade..."',
    '    - a concrete proper noun:  "Shop fees are real."',
    '    - a contrast fragment:     "Not quite — ..."  "Almost, but..."',
    '    - a number or quantity:    "Four years at Michaels..."',
    '    - the author\'s own word, recontextualised',
    '  BEFORE: "The booking links are right there."',
    '  AFTER:  "Booking links are right there."',
    '  BEFORE: "The job description is a list of verbs. The reality is a',
    '           spreadsheet of timestamps."  ← parallel-clause template, banned',
    '  AFTER:  "Job description is a list of verbs. Reality is a spreadsheet',
    '           of timestamps."',
    '  The parallel "The X. The Y." two-clause shape is specifically banned —',
    '  even when the content is good, the shape is the tell.',
    '',
    'REPLY-SPECIFIC — pick ONE shape, vary across drafts:',
    '  - Plain observation. Notice something specific in the post and',
    '    name it. Full stop. No follow-up question.',
    '  - Dry agreement with a twist. Agree, then add the part the',
    '    author skipped. One or two sentences max.',
    '  - Flat disagreement. "That\'s not quite it" + the actual thing.',
    '    Never hedged. Never phrased as a question.',
    '  - Parallel note. Offer a related observation from a different',
    '    angle. Lets the author keep talking without asking them to.',
    '  - One-word / one-clause reaction. Rare. Only when it truly lands.',
    '  - Genuine question. ONLY if the parent is itself an open question,',
    '    OR a question is measurably sharper than a statement. Default',
    '    is no question.',
    '',
    'Questions are earned, not default. No more than roughly one in three',
    'drafts should end with a question mark. Most replies end on a statement.',
    '',
    'Match the parent\'s register (dry / playful / technical) without',
    'copying its phrasing. A merchant listing a price doesn\'t need',
    'philosophy. A philosopher listing a thought doesn\'t need a',
    'checkout question.',
    '',
    'Compress to one idea + one concrete mechanism. Not a two-step',
    'lecture, not a question + answer combo.',
    '',
    'ANTI-PATTERNS — auto-skip the draft yourself if it matches any:',
    '  - "Statement. Question?" two-sentence template where the question',
    '    exists mainly to fill space. If the question is not strictly',
    '    better than silence, delete it and publish the statement alone.',
    '  - Opening with "The " — see OPENING rule above. Not a preference.',
    '  - The "The X. The Y." parallel-clause template — see OPENING rule.',
    '  - "Curious how/what...", "What\'s the X that Y?", "Does the X',
    '    actually Y?" — these constructions have been overused. Find',
    '    another way in.',
    '  - Asking the author about their own product/booking/service',
    '    logistics ("What\'s the booking flow?" "Does that include a',
    '    consultation?"). It reads as a cold-email qualification probe.',
    '  - Restating the author\'s own words back at them with a question',
    '    attached ("Four years at Michaels sounds like a long time.',
    '    What finally..."). The restatement is filler.',
    '',
    buildLengthDirective({ platform, useCase: 'reply' }),
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

/**
 * Viral-piggyback system prompt. Used when replying into a crowded ICP-
 * packed thread where the POSTER isn't the target but the REPLY CROWD
 * is. Replies must stand out against 30-150 other comments, not be
 * helpful 1:1 to the poster. Sandbox-validated pattern.
 */
function buildViralPiggybackSystemPrompt(platform: 'x' | 'threads'): string {
  return [
    'You draft replies to viral social-media threads from creator-economy voices.',
    'The POSTER is not the target — the *reply crowd* is. Dozens to hundreds of',
    'solopreneurs, indie hackers, and small-business operators are scrolling the',
    'comment section. Your reply has to stand out against 30-150 other replies and',
    'make those lurkers stop and think. Nobody remembers the 40th "great point!"',
    'reply.',
    '',
    buildVoicePrinciples(),
    '',
    'VIRAL-REPLY SHAPE — pick ONE of these. The example framings are for shape',
    'only; do NOT copy them verbatim. Find your own words so the reply feels',
    'original, not templated:',
    '',
    '  - Specific counter. Push back on the dominant framing in a precise way.',
    '    Must name the missing variable, not just disagree.',
    '  - Sharp reduction. Restate the post\'s claim in a smaller, truer form.',
    '    Makes the lurker feel the claim click.',
    '  - Unexpected cost. Name a hidden cost the post ignored. Vary the phrasing;',
    '    "the real cost of X isn\'t Y" is stale — find fresher construction.',
    '  - Minimum viable rule. If the post is a poll/question, answer it with a',
    '    one-line rule that\'s obviously right once said.',
    '  - Category mistake. Point out the post is asking about Level-1 when the',
    '    real problem is Level-2.',
    '',
    'AVOID in viral mode:',
    '  - Agreement. "Great point" / "so true" / "100%" is invisible.',
    '  - Generic advice (focus on customers / keep shipping). Everyone says this.',
    '  - Long explanations. 1-2 sentences. Density beats completeness.',
    '  - Cleverness without substance. If it doesn\'t teach a mechanism, cut it.',
    '',
    buildLengthDirective({ platform, useCase: 'reply' }),
    '',
    'WHEN TO SKIP (return draft: "SKIP"):',
    '  - The post is pure self-promotion with no substantive claim to counter.',
    '  - You would have to misread the post to reply usefully.',
    '',
    'OUTPUT (JSON, nothing else):',
    '  {',
    '    "draft":      string  // primary reply, ready to post as-is',
    '    "alternates": string[]  // 0-2 differently-angled drafts',
    '    "rationale":  string  // one sentence on why this stops the scroll',
    '  }',
    '  or on skip:',
    '  { "draft": "SKIP", "rationale": "one sentence on why" }',
  ].join('\n');
}

/**
 * Buyer-intent system prompt. Used when the classifier labels the post
 * `buyer_intent` — someone actively hiring for an AI-automatable role
 * (virtual assistant, copywriter, video editor, social media manager,
 * etc.). Unlike the default direct drafter (observational, statements
 * over questions, no product names), this drafter names ohwow directly
 * and frames it as a concrete, cheaper, better alternative to the human
 * hire they were about to make. Tone is warm and matter-of-fact, not
 * salesy.
 *
 * The voice gate (voice-core) still applies: no first-person ("we offer",
 * "I use"), no softeners, no em-dashes, no sign-offs, no hashtags/links.
 * "ohwow" the product name is allowed. Mentioning a price or concrete
 * comparison is encouraged when it helps the buyer see the fit quickly.
 */
function buildBuyerIntentSystemPrompt(platform: 'x' | 'threads'): string {
  return [
    'You draft replies to posts where the author is actively hiring (or',
    'about to hire) for a task ohwow can do cheaper and better — virtual',
    'assistant, copywriter, content writer, video editor, social media',
    'manager, community manager, researcher, executive assistant,',
    'customer support, ghostwriter, UGC creator, thumbnail artist,',
    'podcast editor, and similar AI-automatable roles.',
    '',
    'The author has already decided the task is worth paying for. They',
    'are not asking for opinions or pain-relief advice. They want a',
    'concrete option. Your reply names ohwow as that option — warm,',
    'matter-of-fact, one specific capability.',
    '',
    buildVoicePrinciples(),
    '',
    'BUYER-INTENT SHAPE — pick ONE:',
    '  - Concrete fit. "ohwow does [their exact task] for [price or',
    '    simple comparison]." Keep it factual, not salesy.',
    '  - Capability name-drop. "For [role] work, ohwow handles [one',
    '    specific mechanism they\'ll recognise]." One mechanism, not a',
    '    feature list.',
    '  - Cost contrast. "[Annualized cost of human hire] for a [role]',
    '    vs. ohwow\'s [lower tier]. Worth a look." Only when the post',
    '    mentions a budget or standard-market price.',
    '  - Gentle suggestion. "Might be worth a look at ohwow before',
    '    committing to the full-time hire — [one reason tailored to',
    '    their task]."',
    '',
    'CRITICAL — ohwow (lowercase, one word) is the product name. Use it',
    'exactly once in the draft. Do not link, do not add hashtags, do not',
    'write "ohwow.fun" or "@ohwow_fun" — the name alone is enough; the',
    'reader can search.',
    '',
    'AVOID:',
    '  - Questions. The author already knows what they want.',
    '  - Qualification probes ("What\'s your budget?", "What tools do',
    '    you use now?"). Cold-email energy.',
    '  - Hedging / "might want to consider" / "you should look at".',
    '    Flat recommendation reads as a peer sharing a tip.',
    '  - Restating the author\'s own post back at them.',
    '  - More than one sentence when one will do. Two sentences max.',
    '  - First-person ("we", "I", "our") — the voice gate rejects these.',
    '  - Links, hashtags, em-dashes, "please", trailing periods.',
    '',
    buildLengthDirective({ platform, useCase: 'reply' }),
    '',
    'WHEN TO SKIP (return draft: "SKIP"):',
    '  - The role is physical, licensed, or credential-gated (nurse,',
    '    teacher, construction engineer, architect, clinician, driver,',
    '    pathologist, postdoc). ohwow cannot replace these.',
    '  - The post is actually a supplier pitch in question form ("Hiring',
    '    a video editor? DM me") — those got mislabeled; skip.',
    '  - The author is clearly an enterprise with a formal HR pipeline.',
    '    Cold-replies to official careers accounts read as spam.',
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

/**
 * Praise system prompt. Used when the classifier labels the post
 * `adjacent_prospect` — someone in ohwow's audience (founder, builder,
 * small-team operator, creator) sharing an observation, win, or lesson
 * that resonates, but NOT actively hiring and NOT in pain. The reply's
 * job is to affirm, not to teach, advise, probe, or pitch. Leave a
 * warm mark on someone who might be a future customer without pushing
 * them.
 */
function buildPraiseSystemPrompt(platform: 'x' | 'threads'): string {
  return [
    'You draft replies to posts from founders, builders, and operators',
    'sharing an insight, observation, lesson, or win. The author is not',
    'in pain and not hiring. They are thinking out loud in ohwow\'s',
    'audience. Your reply is a warm acknowledgement — a peer noticing',
    'what made the post good.',
    '',
    'This is NOT a teaching moment, an advice slot, or a pitch. It is',
    'presence. Somebody said something thoughtful; you noticed.',
    '',
    buildVoicePrinciples(),
    '',
    'PRAISE SHAPE — pick ONE:',
    '  - Specific noticing. "[Specific line or idea] is the part',
    '    [audience] usually skip." Names the underappreciated detail.',
    '  - Sharp affirmation. "Rare take. [One-sentence reason it lands.]"',
    '  - Quiet agreement with a concrete hook. Agree once, then name',
    '    the concrete thing that makes it true. No pivot to advice.',
    '  - Recognition of the shape, not just the content. "The move',
    '    inside that lesson — [name it] — is what separates [a] from',
    '    [b]."',
    '',
    'CRITICAL — do NOT mention ohwow, do NOT name any product, do NOT',
    'link anything. This post is not a buyer; naming a product here',
    'breaks trust.',
    '',
    'AVOID:',
    '  - Generic praise ("great point!", "so true", "100%", "this is',
    '    gold", "love this"). Invisible.',
    '  - Questions. Do not make the author do more work to get your',
    '    response over the line. Silence ends the reply.',
    '  - Advice ("you should also", "have you tried", "pro tip"). They',
    '    are not asking.',
    '  - Corporate softeners ("at the end of the day", "here\'s the',
    '    thing", "table stakes"). Voice gate rejects these anyway.',
    '  - Emojis. One in ten replies at most, never as a substitute for',
    '    substance.',
    '  - First-person ("I", "we", "me") — voice gate rejects these.',
    '  - More than one sentence. A praise reply is a touch, not a',
    '    speech.',
    '',
    buildLengthDirective({ platform, useCase: 'reply' }),
    '',
    'WHEN TO SKIP (return draft: "SKIP"):',
    '  - The post is a meme, shitpost, or pure opinion without a',
    '    graspable observation.',
    '  - The post is performative ("grinding at 5am" / "just signed a',
    '    client" with no insight). Nothing specific to notice.',
    '  - You would have to generate content not in the post to reply.',
    '    Say nothing rather than manufacture praise.',
    '',
    'OUTPUT (JSON, nothing else):',
    '  {',
    '    "draft":      string  // primary reply, ready to post as-is',
    '    "alternates": string[]  // 0-2 differently-angled drafts',
    '    "rationale":  string  // one sentence on what you noticed',
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
/**
 * Reply-voice gate. Delegates to voice-core — the shared voice
 * implementation. Kept as a named export here for backward
 * compatibility with existing tests; new callers should import
 * directly from voice-core.
 */
export function voiceCheck(text: string, platform: 'x' | 'threads'): { ok: boolean; reasons: string[] } {
  return voiceCoreCheck(text, { platform, useCase: 'reply' });
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

  const mode: ReplyMode = input.mode ?? 'direct';
  const system = buildReplySystemPrompt(input.platform, mode);
  const prompt = buildUserPrompt(input.target, input.platform, input.extraGuidance);

  const llm = await runLlmCall(
    {
      modelRouter: deps.engine.modelRouter,
      db: deps.db,
      workspaceId: deps.workspaceId,
      // Gap 13: scheduler-driven reply drafting (x-reply-scheduler,
      // threads-reply-scheduler) counts against the daily autonomous
      // cap. Pulls the deps the daemon wired once via
      // `engine.setBudgetDeps`; undefined when the middleware is not
      // wired (early boot / unit tests) so the call still dispatches.
      budget: deps.engine.getAutonomousBudgetDeps?.(),
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

  // Post-hoc cosmetic scrub (voice-core.autoFixCosmetic): strip trailing
  // period, replace em/en dash with ", ". These are the two rules the
  // model routinely ignores despite being in every prompt. Other voice
  // violations (first-person, product names, corporate softeners) still
  // hard-fail the gate below.
  parsed.draft = autoFixCosmetic(parsed.draft);
  if (Array.isArray(parsed.alternates)) {
    parsed.alternates = parsed.alternates.map(autoFixCosmetic);
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
