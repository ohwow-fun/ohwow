/**
 * Trigger-phrase detection for inbound X DMs.
 *
 * Kept deliberately minimal — a flat lowercase substring list, not a
 * regex or NLP pass. Three reasons:
 *
 *   1. Predictability. An operator reading x_dm_signals should be able
 *      to explain why a row was emitted in one sentence: "the message
 *      contains 'pricing'". Richer matchers silently drift.
 *
 *   2. False positives are cheap here — the signal tells the operator
 *      a conversation is worth looking at, it does NOT auto-reply or
 *      auto-create anything. A spurious 'demo' hit costs one click.
 *      False negatives (missed real demand) cost a lead.
 *
 *   3. Easy to override. Exporting the list as a mutable-shape module
 *      means a future runtime_settings knob
 *      (e.g. x_dm_trigger_phrases) can layer on without reshaping the
 *      detector.
 *
 * Keep phrases lowercase, short, and specific enough that an incidental
 * mention matters. Avoid generic words like 'help' or 'question' —
 * they'd trigger on every long thread.
 */

export const X_DM_TRIGGER_PHRASES: readonly string[] = [
  'pricing',
  'demo',
  'onboarding',
  'npx ohwow',
  'ohwow',
  'integration',
  'api access',
  'partner',
] as const;

/**
 * Return the first matching trigger phrase, or null when no phrase
 * matches. Null-safe on text; null input → null match.
 *
 * First-match-wins ordering means the list above IS the ranking —
 * put the highest-signal phrases first. 'pricing' beats 'ohwow' when
 * both appear in one message.
 */
export function detectTriggerPhrase(
  text: string | null | undefined,
  phrases: readonly string[] = X_DM_TRIGGER_PHRASES,
): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const phrase of phrases) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}
