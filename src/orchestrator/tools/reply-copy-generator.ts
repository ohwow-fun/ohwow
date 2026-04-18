/**
 * reply-copy-generator.ts — draft a reply to a scanned post in the
 * ohwow voice. Voice principles + forbidden-phrase list live in
 * src/lib/voice/voice-core.ts (single source of truth); this file
 * layers the reply-specific first-principles rules on top, and runs
 * the post-hoc voiceCheck gate.
 *
 * Revised 2026-04-17: removed first-person narrative slippage
 * (voice-core.FIRST_PERSON_PATTERNS).
 * Revised 2026-04-18 (d74965b): demoted questions from default
 * to earned-only. Default ending is a statement, not "?".
 * Revised 2026-04-18 (banned-openings): banned "The "-initial openings
 * and the "The X. The Y." parallel-clause template.
 * Revised 2026-04-18 (this commit): rewrote every prompt in pure
 * first-principles prose; removed all literal BEFORE/AFTER examples,
 * bracketed fragments, and shape-menu bullets that anchored the
 * model on phrasing. Added 'skip' mode for solo_service_provider
 * and genuine_pain classes (scheduler short-circuits; no draft is
 * generated). Added a hard no-question gate across every mode —
 * any draft containing "?" fails like a voice-check violation.
 * Buyer-intent drafter now requires the literal string "ohwow.fun".
 * Viral drafter collapses to the buyer-intent shape when the viral
 * post itself scopes hiring / delegating / AI-automating work.
 *
 * Intentional non-feature: no canonical example drafts in the
 * system prompt. Examples anchor the model on phrasing which it
 * then copies wholesale or ablates into tics. First-principles
 * only.
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

export type ReplyMode = 'direct' | 'viral' | 'buyer_intent' | 'praise' | 'skip';

/**
 * Map a classifier verdict class to the right drafter mode. The scheduler
 * calls this after classification to pick the prompt that matches the
 * post's audience.
 *
 * Routing principles:
 *   - viral queries always go through the viral drafter (crowd-targeting
 *     semantics override per-post class).
 *   - buyer_intent posts go to the ohwow.fun-naming drafter.
 *   - adjacent_prospect posts go to the praise drafter.
 *   - solo_service_provider and genuine_pain posts are SKIPPED outright.
 *     Engaging a solo service provider pits ohwow against the exact
 *     person we'd otherwise serve; engaging a genuine-pain vent has no
 *     purchase decision to engage with.
 *   - everything else falls through to the observational direct drafter.
 */
export function drafterModeForClass(
  queryMode: 'direct' | 'viral',
  classifierClass: string,
): ReplyMode {
  if (queryMode === 'viral') return 'viral';
  if (classifierClass === 'buyer_intent') return 'buyer_intent';
  if (classifierClass === 'adjacent_prospect') return 'praise';
  if (classifierClass === 'solo_service_provider') return 'skip';
  if (classifierClass === 'genuine_pain') return 'skip';
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
    case 'direct': return buildSystemPrompt(platform);
    case 'skip':
      // Skip-class posts are short-circuited in generateReplyCopy before
      // any system prompt is built. Reaching this branch is a scheduler
      // bug, not a prompt-content question.
      throw new Error('buildReplySystemPrompt called with mode=skip; skip classes must short-circuit before prompt build');
    default: {
      const _exhaustive: never = mode;
      void _exhaustive;
      return buildSystemPrompt(platform);
    }
  }
}

function buildSystemPrompt(platform: 'x' | 'threads'): string {
  return [
    'You draft a single reply to a social post. These are first-principles',
    'rules. No example replies are given on purpose — examples anchor you',
    'on phrasing you then copy wholesale. Work from principles.',
    '',
    buildVoicePrinciples(),
    '',
    'SPEAKER MODEL. You are an anonymous scroller who stopped on this post.',
    'Not the author, not a peer, not a product representative, not a coach.',
    'A stranger in the feed who noticed something specific and is leaving',
    'one short human comment. No first-person autobiography, no',
    'philosophical reframing of what the post "really means", no advice.',
    '',
    'FORM. One statement. Not a question. The draft must not contain the',
    'character "?" anywhere. Questions make the author do more work to get',
    'your comment over the line; silence ends the reply instead. A second',
    'sentence is allowed only if it names one concrete detail actually',
    'present in the post — never to hedge, qualify, soften, or add a',
    'follow-up probe.',
    '',
    'CONTENT. Name something specific the post got right, got wrong, or',
    'left out. "Specific" means drawn from the actual words of the post,',
    'not a general observation about the topic. If you cannot name',
    'something specific without inventing content the post did not scope,',
    'skip.',
    '',
    'NO PRODUCT MENTION. Do not name ohwow, ohwow.fun, or any product,',
    'tool, agency, course, or service. This drafter is for posts whose',
    'author is not hiring; naming a product here breaks trust and pushes',
    'a stranger toward a sales surface they did not ask for.',
    '',
    'NO OPENING TELL. Do not start the reply with "The ". That is the',
    'default output shape of a templated generator and the clearest',
    'signature of a bot reply. Do not use the "The X. The Y." parallel-',
    'clause template — even when the content is good, the shape is the',
    'tell.',
    '',
    'Match the parent\'s register (dry, playful, technical) without copying',
    'its phrasing. Compress to one idea; do not write a two-step lecture.',
    '',
    buildLengthDirective({ platform, useCase: 'reply' }),
    '',
    'WHEN TO SKIP (return draft: "SKIP"):',
    '  - The post is a pitch, link-drop, affiliate, or promo.',
    '  - The post is combative flame-bait; engagement feeds it.',
    '  - The post contains nothing specific to grip — pure restatement',
    '    would be the only move.',
    '  - You would have to invent content the post did not scope to',
    '    reply usefully. Silence beats manufactured observation.',
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
    'You draft a single reply to a viral social-media post. The POSTER is not',
    'the target — the scrolling crowd in the comment section is. The post',
    'cleared an engagement threshold independently, so the individual',
    'author\'s intent is bypassed and we are addressing dozens to hundreds of',
    'lurkers reading the comments.',
    '',
    buildVoicePrinciples(),
    '',
    'CONDITIONAL COLLAPSE. First, judge whether the viral post itself scopes',
    'hiring, delegating, or AI-automating a specific task that ohwow can',
    'perform (virtual-assistant class, copywriter class, video-editor class,',
    'researcher class, social-media / community / support class, or similar).',
    'If yes, the reply collapses to the buyer-intent shape: one sentence, a',
    'peer dropping the answer, naming the literal string "ohwow.fun" exactly',
    'once, no hedging, no probe, no feature list. Follow the rest of the',
    'buyer-intent rules below in that case.',
    '',
    'OTHERWISE. You are an anonymous scroller leaving one short human',
    'comment that adds a genuine observation the thread can hold — a',
    'specific detail, a counter, a missing variable, a sharper restatement',
    'of the claim. Not an endorsement ("great point", "so true"), not',
    'generic advice, not cleverness without substance.',
    '',
    'FORM. One statement. Not a question. The draft must not contain the',
    'character "?" anywhere. A second sentence is allowed only if it names',
    'one concrete detail actually present in the post.',
    '',
    'NO PRODUCT MENTION in the non-hiring branch. Do not name ohwow,',
    'ohwow.fun, or any product, tool, agency, course, or service. The',
    'product name appears only when the conditional-collapse clause above',
    'fires.',
    '',
    'NO OPENING TELL. Do not start with "The ". Do not use the "The X. The',
    'Y." parallel-clause template.',
    '',
    'Density beats completeness. If the reply does not add something',
    'specific to the thread, skip it rather than publish a filler comment.',
    '',
    buildLengthDirective({ platform, useCase: 'reply' }),
    '',
    'WHEN TO SKIP (return draft: "SKIP"):',
    '  - The post is pure self-promotion with no substantive claim to',
    '    engage with.',
    '  - You would have to invent content the post did not scope to say',
    '    anything non-generic.',
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
    'You draft a single reply to a post whose author has already decided',
    'to pay for a specific piece of work ohwow can perform. Money is',
    'flowing FROM the poster outward — they hold the budget, they have',
    'scoped the task, and they are asking who should do it. They are not',
    'venting, not asking for opinions, not looking for pain-relief advice.',
    'They want a concrete answer.',
    '',
    buildVoicePrinciples(),
    '',
    'SPEAKER MODEL. A peer in the replies drops the answer the poster is',
    'actually looking for. Matter-of-fact, one breath, no pitch-deck energy.',
    'Not a founder doing PR, not a salesperson qualifying a lead.',
    '',
    'FORM. One sentence by default. A second sentence is allowed only when',
    'it names one concrete fit detail actually drawn from the post (the',
    'specific task scope, the specific deliverable, the specific constraint).',
    'Never hedge ("might want to consider", "you should look at", "worth',
    'exploring"). Never probe ("what\'s your budget", "what tools do you',
    'use now"). Never list features.',
    '',
    'The draft must not contain the character "?" anywhere.',
    '',
    'PRODUCT NAME. The draft MUST include the literal string "ohwow.fun"',
    'exactly once. Write it as ohwow.fun — lowercase, one token, with the',
    'dot and the .fun. Not "ohwow" alone, not "ohwow.com", not',
    '"@ohwow_fun", not a hyperlink, not a hashtag. The reader can paste',
    'the string into their browser; that is the entire goal of this',
    'drafter.',
    '',
    'NO OPENING TELL. Do not start with "The ". Do not use the "The X. The',
    'Y." parallel-clause template.',
    '',
    buildLengthDirective({ platform, useCase: 'reply' }),
    '',
    'WHEN TO SKIP (return draft: "SKIP"):',
    '  - The work scoped is physical, credential-gated, or on-site in a',
    '    way ohwow cannot perform. If the task requires a licensed or',
    '    regulated practitioner, a body in a physical location, or a',
    '    credential ohwow does not hold, skip.',
    '  - The post is a supplier pitch in hiring-question clothing (the',
    '    author is offering their own labor, not hiring). Those are',
    '    mislabeled; skip.',
    '  - The author is clearly a large enterprise with a formal HR',
    '    pipeline. Cold-replies to official careers accounts read as spam.',
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
    'You draft a single short human comment on a post from an ICP-shaped',
    'peer. The author is not in pain, not hiring, not pitching — they are',
    'making an observation about work, tools, or operating philosophy. No',
    'money is moving in either direction.',
    '',
    buildVoicePrinciples(),
    '',
    'SPEAKER MODEL. An anonymous scroller who stopped on this post and',
    'left one short human comment. Not a teacher, not a coach, not a peer',
    'offering advice, not a product representative.',
    '',
    'CONTENT. Name something specific the post got right — a phrase, a',
    'detail, a distinction the author drew, an observation that landed.',
    '"Specific" means drawn from the actual words of the post. Do not',
    'reframe the post philosophically. Do not restate the post in grander',
    'abstractions. Do not pivot to your own take or your own experience.',
    '',
    'FORM. One short statement. Not a question. The draft must not contain',
    'the character "?" anywhere. No advice, no "have you tried", no "you',
    'should also". Silence is the fallback, not a probe.',
    '',
    'NO PRODUCT MENTION. Do not name ohwow, ohwow.fun, or any product,',
    'tool, or service. This post is not a buyer and naming a product here',
    'breaks trust.',
    '',
    'NO FIRST-PERSON AUTOBIOGRAPHY. The speaker is anonymous. No "I",',
    '"we", "my", "me" — the voice gate rejects these anyway, but the',
    'deeper rule is that you have no life story to share here.',
    '',
    'NO OPENING TELL. Do not start with "The ". Do not use the "The X. The',
    'Y." parallel-clause template.',
    '',
    buildLengthDirective({ platform, useCase: 'reply' }),
    '',
    'WHEN TO SKIP (return draft: "SKIP"):',
    '  - The post is a meme, shitpost, or pure opinion without a',
    '    graspable observation.',
    '  - The post is performative with no specific detail to notice.',
    '  - You would have to invent content not in the post to say anything',
    '    non-generic. Manufactured praise is worse than silence.',
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

  // Skip-class short-circuit. solo_service_provider and genuine_pain
  // posts route to mode='skip' via drafterModeForClass; no LLM call is
  // needed, no draft is produced, and the scheduler already handles
  // draft === 'SKIP' by not inserting a row into x_reply_drafts.
  if (mode === 'skip') {
    return {
      ok: true,
      draft: 'SKIP',
      rationale: 'skip-class',
    };
  }

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

  // Combined gate: voice-check + no-question rule. Questions make the
  // author do more work and read as cold-email probes; the prompt bans
  // them already, but a post-hoc machine gate closes the loop. Any '?'
  // in the draft disqualifies it just like a voice violation. Runs on
  // primary first, then alternates in order; first passing one is
  // promoted to primary; if none pass, the candidate is SKIP'd.
  const gate = (text: string): { ok: boolean; reasons: string[] } => {
    const vc = voiceCheck(text, input.platform);
    const reasons = [...vc.reasons];
    if (text.includes('?')) {
      reasons.push('contains question mark (questions are banned across all reply modes)');
    }
    return { ok: reasons.length === 0, reasons };
  };

  const primaryCheck = gate(parsed.draft);
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
    '[reply-copy] primary draft tripped gate; scanning alternates',
  );

  // Try alternates in order; first passing one becomes the primary.
  for (const alt of parsed.alternates ?? []) {
    const altCheck = gate(alt);
    if (altCheck.ok) {
      logger.info(
        { chars: alt.length },
        '[reply-copy] promoted alternate draft after primary gate failure',
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
    '[reply-copy] all drafts tripped gate; skipping candidate',
  );
  return {
    ok: true,
    draft: 'SKIP',
    rationale: `gate failed: ${primaryCheck.reasons.join(', ')}`,
    modelUsed: llm.data.model_used,
  };
}
