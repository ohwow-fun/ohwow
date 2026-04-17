/**
 * Pure prompt builders for the x-intel per-post classifier. Extracted so
 * they can be unit-tested and so the engager-source signal is threaded
 * into the LLM prompt consistently across code paths.
 *
 * Engagers are replies to in-market threads (own-post repliers or
 * competitor-thread repliers). Without exposing that context to the
 * classifier, a replier to "@zapier is too expensive" reads as a
 * generic low-engagement reply and routes to `skip` or `adjacent_noise`.
 * With it, the classifier can promote these to `market_signal` even on
 * low like counts — the reply IS the signal.
 */

const TEXT_LIMIT = 220;

/**
 * Build a single post line for the batched classifier prompt body.
 * Format: `#<idx> @<author> [hint:<bucket>] [engager:<source>→@<parent>] <likes>♥ <replies>💬: <text>`.
 * Engager tag appears only when `_engagerSource` is set.
 */
export function formatClassifyLine(post, idx) {
  const hint = post._bucketHint ? ` [hint:${post._bucketHint}]` : '';
  const engager = post._engagerSource
    ? ` [engager:${post._engagerSource}${post._parentAuthor ? `→@${post._parentAuthor}` : ''}]`
    : '';
  const text = (post.text || '').slice(0, TEXT_LIMIT).replace(/\n/g, ' ');
  return `#${idx} @${post.author}${hint}${engager} ${post.likes ?? 0}♥ ${post.replies ?? 0}💬: ${text}`;
}

/**
 * Extra system-prompt guidance on how to weigh engager context. Appended
 * to the classifier's system prompt when any post in the batch carries
 * an `_engagerSource` — keeps the prompt lean for non-engager runs.
 */
export const ENGAGER_CLASSIFIER_GUIDANCE = [
  '',
  'Some rows are tagged [engager:<source>→@<parent>]. These are REPLIES scraped from either our own recent posts (engager:own-post) or a competitor/adjacent-tool thread (engager:competitor:<handle>). Treat these differently:',
  '- Engager rows are in-market by BEHAVIOR: the replier chose to engage with an operator-pain thread. Low likes/replies on the reply itself are expected and NOT a reason to skip.',
  '- If the reply echoes pain, hiring-VA angle, tired-of-glue language, or mentions a real business/team, route to `market_signal` with score >= 0.6. Even a brief reply like "same" or "feel this" on a qualifying parent thread counts.',
  '- If the reply is off-topic, a joke, a promo, or generic chatter despite the engager tag, `skip` is still correct.',
  '- Preserve the engager hint in your reasoning field when you promote so the downstream rubric can apply the engager boost.',
].join('\n');
