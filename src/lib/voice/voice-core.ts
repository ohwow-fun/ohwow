/**
 * voice-core — single source of truth for the brand voice principles
 * + the post-hoc gate that catches drafts that violate them.
 *
 * Why split this out: we have multiple copy-generation pipelines
 * (reply-copy-generator for autonomous replies; x-post-draft-generator
 * for top-level posts; future DM / email / bio copy). Each one used to
 * maintain its own prompt + forbidden list, which drifted
 * independently. The reply-generator got a hardened first-principles
 * spec in April; the draft-distiller still allowed "first-person
 * plural is fine". Any future voice rule we add has to land in N
 * places.
 *
 * After extraction: each use-case imports { voicePrinciples,
 * structuralForbiddens, voiceCheck } and only writes the delta that's
 * specific to its shape (reply: reciprocate target energy; post:
 * shape menu). A change here propagates everywhere.
 *
 * This file exports two kinds of artifacts:
 *   1. Prose strings (buildVoicePrinciples) that get dropped into
 *      system prompts so the model sees the same rules every
 *      use-case operates under.
 *   2. Machine-checkable predicates (voiceCheck, FIRST_PERSON_PATTERNS
 *      etc.) that run after the LLM returns, to reject drafts that
 *      slipped past the prompt. The gate is what actually protects
 *      the output — prompts are suggestions, gates are enforcement.
 */

// ---------------------------------------------------------------------------
// Machine-checkable patterns — used by voiceCheck + exported for reuse.
// ---------------------------------------------------------------------------

/**
 * First-person markers. The voice is observational, not narrative:
 * opinions + mechanisms, never personal experience claims. These
 * patterns catch when the model slips into "builder voice" and
 * invents fake lived-through moments.
 *
 * Word-boundary '\bI\b' matches the pronoun but not words containing
 * 'i' like 'interesting'. Case-sensitive on the bare I on purpose —
 * lowercase 'i' isn't the pronoun in English-legitimate writing.
 */
export const FIRST_PERSON_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bI\b/, 'firstPerson:I'],
  [/\bI'(?:ve|m|d|ll|s|re)\b/i, 'firstPerson:I-contraction'],
  [/\bme\b/i, 'firstPerson:me'],
  [/\bmy\b/i, 'firstPerson:my'],
  [/\bmine\b/i, 'firstPerson:mine'],
  [/\bwe\b/i, 'firstPerson:we'],
  // Case-sensitive on "us": lowercase is the pronoun, uppercase "US" is
  // the country code ("US customers") and must not false-positive.
  [/\bus\b/, 'firstPerson:us'],
  [/\bour\b/i, 'firstPerson:our'],
];

/**
 * Fake-experience phrasing. Catches common second-person narrative
 * that reads as recycled "you know when you..." experience-mining.
 */
export const FAKE_EXPERIENCE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\byou end up\b/i, 'fakeExperience:you-end-up'],
  [/\byou (?:find|found)\b/i, 'fakeExperience:you-found'],
  [/\bin (?:my|our) experience\b/i, 'fakeExperience:my-experience'],
  [/\bwhen (?:you|i) tr(?:y|ied)\b/i, 'fakeExperience:when-you-try'],
];

/**
 * Corporate softeners that make copy read like a LinkedIn comment
 * wearing a lab coat. All checked case-insensitively as substrings.
 */
export const CORPORATE_SOFTENERS: ReadonlyArray<string> = [
  'great take',
  'this is interesting',
  'happy to',
  'at the end of the day',
  'table stakes',
  'the real question is',
  "here's the thing",
  'the key is',
];

/** Sign-off patterns — treated as "you're not writing an email." */
export const SIGN_OFFS: ReadonlyArray<string> = [
  'thanks!',
  'cheers',
  'best,',
  'hope this helps',
];

/**
 * Cringe-viral tics. Catches the "performing Twitter" register that
 * makes copy look like a reply guy who watched too many "this tweet
 * is so real" threads.
 */
export const CRINGE_TICS: ReadonlyArray<[RegExp, string]> = [
  [/\bera\b(?!\s*of\s)/i, 'cringe:era-noun'],
  [/is this mid\b/i, 'cringe:is-this-mid'],
  [/\bnot me (?:\w+ing)\b/i, 'cringe:not-me-ing'],
  [/\bvibes?\s+check\b/i, 'cringe:vibes-check'],
  [/💀|😭(?!\w)/, 'cringe:reaction-emoji'],
];

/**
 * Platform length caps.
 * X counts in UTF-16 code units for Twitter-style; a 280 cap is safe
 * for ASCII-mostly text. Reply flows target 240 for breathing room.
 */
export const LENGTH_CAPS = {
  x: { reply: 240, post: 280 },
  threads: { reply: 280, post: 500 },
} as const;

// ---------------------------------------------------------------------------
// Cosmetic auto-fix (pre-gate).
// ---------------------------------------------------------------------------

/**
 * Strip cosmetic violations the LLM repeatedly commits (trailing period,
 * em-dash, en-dash) before the voice gate runs. These are the two rules
 * models ignore most often despite being in every prompt, and they're
 * trivially fixable without changing meaning.
 *
 * What this does NOT fix: first-person pronouns, product names, corporate
 * softeners, sign-offs — those are intent-level violations and still hard
 * fail the gate.
 *
 * Em-dash replacement uses ", " which reads naturally in most clause-joining
 * contexts; safer than "; " which looks stiff on X/Threads.
 */
export function autoFixCosmetic(text: string): string {
  if (!text) return text;
  let t = text;
  // Em-dash / en-dash → ", ". Strip adjoining whitespace so " — " doesn't
  // leave doubled spaces on either side.
  t = t.replace(/\s*[—–]\s*/g, ', ');
  // Strip a single trailing period (and any trailing whitespace).
  t = t.replace(/\.\s*$/, '');
  // Clean up artifacts the replacement can create.
  t = t.replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim();
  return t;
}

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

export interface VoiceCheckContext {
  platform: 'x' | 'threads';
  /** Whether this is a reply or a standalone post. Drives length cap. */
  useCase: 'reply' | 'post';
}

/**
 * Run the full voice gate on a draft. Returns {ok, reasons} — an
 * empty reasons list means the draft is publishable. Callers should
 * SKIP (not publish) any draft with `ok === false`.
 *
 * The gate is enforcement, not suggestion. A prompt may describe
 * rules; voiceCheck is what keeps the rules from leaking in
 * production when the model drifts. If a rule belongs on the brand,
 * it belongs here.
 */
export function voiceCheck(text: string, ctx: VoiceCheckContext): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const cap = LENGTH_CAPS[ctx.platform][ctx.useCase];
  if (text.length > cap) reasons.push(`length(${text.length}>cap${cap})`);

  // Structural rejects (em dashes, please, hashtags, etc.)
  if (/—|–/.test(text)) reasons.push('emDash');
  if (/\bplease\b/i.test(text)) reasons.push('please');
  if (/#\w/.test(text)) reasons.push('hashtag');
  if (/\bhttps?:\/\//.test(text)) reasons.push('link');
  if (/\.\s*$/.test(text)) reasons.push('trailingPeriod');

  for (const [re, label] of FIRST_PERSON_PATTERNS) {
    if (re.test(text)) reasons.push(label);
  }
  for (const [re, label] of FAKE_EXPERIENCE_PATTERNS) {
    if (re.test(text)) reasons.push(label);
  }
  for (const [re, label] of CRINGE_TICS) {
    if (re.test(text)) reasons.push(label);
  }
  const lower = text.toLowerCase();
  for (const s of CORPORATE_SOFTENERS) {
    if (lower.includes(s)) reasons.push(`softener:${s}`);
  }
  for (const s of SIGN_OFFS) {
    if (lower.includes(s)) reasons.push(`signoff:${s}`);
  }

  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Prompt-side principles — prose to drop into system prompts.
// ---------------------------------------------------------------------------

/**
 * The core voice principles, as multi-line prose. Designed to slot
 * into an LLM system prompt. Kept first-principles (no canonical
 * example drafts) per operator preference — examples anchor the
 * model on phrasing it then copies wholesale or ablates into tics.
 *
 * Use-case-specific sections (reply: "reciprocate target energy";
 * post: "pick one shape from the menu") get layered on top by the
 * caller.
 */
export function buildVoicePrinciples(): string {
  return [
    'STANCE:',
    '  - Observational, not narrative. Notice and opine; do not claim to',
    '    have personally experienced specific events.',
    '  - Observing + present, not interviewing. Notice the specific thing',
    '    the scroll missed; sit with it. Statements are the default;',
    '    questions are rare and earned. Never restate the author\'s point',
    '    back to them.',
    '  - Humor is welcome — dry undercut, light irony, obvious truths',
    '    said plainly. Not performative cleverness; just the tone of',
    '    someone who finds the situation a little funny.',
    '  - Peer-to-peer. Same level as the reader — not an expert teaching,',
    '    not a fan praising.',
    '',
    'CRAFT:',
    '  - Specific beats abstract. Name the actual cause, not its category.',
    '    Name actual products / people / events rather than generic',
    '    "AI tools" / "builders" / "the industry".',
    '  - Asymmetric rhythm is welcome. A 12-word thought then a 4-word',
    '    stab reads. A string of medium sentences reads like an essay.',
    '  - Pattern-break endings beat summary endings. Pivot at the last',
    '    line; do not restate what came before.',
    '  - Add a dimension the source did not already cover. Agreement alone',
    '    is dead air; mild dissent or a reframe is why anyone reads.',
    '',
    'FORBIDDEN:',
    '  - FIRST-PERSON pronouns: I, me, my, mine, we, us, our, I\'ve, I\'m,',
    '    I\'d, I\'ll, I was. The voice does not have private experience.',
    '  - FAKE-EXPERIENCE phrasing: "I\'ve seen", "my experience",',
    '    "when I tried", "in practice I", "we found", "you end up".',
    '  - Pitches. No products, tools, companies named unless the source',
    '    named them first.',
    '  - Corporate softeners: "happy to discuss", "great take/point",',
    '    "this is interesting", "love this", "100%".',
    '  - Lecture openers: "at the end of the day", "table stakes",',
    '    "the real question is", "here\'s the thing", "the key is",',
    '    "honestly", "tbh".',
    '  - Em dashes (— or –). Use periods, commas, semicolons, line breaks.',
    '  - "Please". Hashtags. Links. Sign-offs. Trailing period.',
    '  - Cringe-viral tics: "era" as a noun, reaction emoji (💀😭),',
    '    "not me ___ing", "vibes check", "is this mid".',
    '  - Drift vocabulary recently overused: "scope ownership",',
    '    "context rot". Use only when they are the single most precise',
    '    term, never as a default reach.',
  ].join('\n');
}

/**
 * A length directive suitable for appending to the system prompt.
 * Shared here so use-cases don't silently disagree on what the cap
 * is — the gate uses LENGTH_CAPS, the prompt should too.
 */
export function buildLengthDirective(ctx: VoiceCheckContext): string {
  const cap = LENGTH_CAPS[ctx.platform][ctx.useCase];
  return `LENGTH: hard cap ${cap} chars. Aim 40-200. Shorter usually better — leave room rather than max it out.`;
}
