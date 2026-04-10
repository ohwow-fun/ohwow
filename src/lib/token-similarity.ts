/**
 * Token Similarity
 * Lightweight text matching for SOP trigger detection.
 * Used to match user messages against discovered process triggers
 * and skill trigger keywords.
 */

/** Normalize a message for comparison: lowercase, strip punctuation, collapse whitespace */
export function normalizeMessage(msg: string): string {
  return msg.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

/** Jaccard similarity between two messages based on word tokens */
export function tokenSimilarity(a: string, b: string): number {
  const tokensA = new Set(normalizeMessage(a).split(' ').filter(Boolean));
  const tokensB = new Set(normalizeMessage(b).split(' ').filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let shared = 0;
  for (const t of tokensA) { if (tokensB.has(t)) shared++; }
  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 ? shared / union : 0;
}

/** Extract meaningful keywords from a message (words > 3 chars, up to limit) */
export function extractKeywords(msg: string, limit = 10): string[] {
  return normalizeMessage(msg)
    .split(' ')
    .filter(w => w.length > 3)
    .slice(0, limit);
}

/** Check if any keyword from the message matches any trigger in the list */
export function matchesTriggers(triggers: string[], messageKeywords: string[]): boolean {
  if (triggers.length === 0 || messageKeywords.length === 0) return false;
  const triggerSet = new Set(triggers.map(t => t.toLowerCase()));
  return messageKeywords.some(k => triggerSet.has(k));
}
