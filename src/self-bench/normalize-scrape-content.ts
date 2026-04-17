/**
 * normalize-scrape-content — strip volatile chrome from scraped page
 * text so the content hash only flips when the substantive content
 * changes.
 *
 * Motivation: competitor pages, release feeds, and HN search results
 * all carry noise that rewrites every request even when nothing
 * meaningful changed — timestamps, relative-time phrases ("3 minutes
 * ago"), volatile counters ("1,234 views"). Hashing the raw text would
 * fire spurious warnings on every probe. Normalize first, then hash.
 *
 * What we keep: prices ($9.99, $10/mo, €15/month), plan names (Pro,
 * Team, Enterprise, Free), feature lists, headlines, repo names,
 * paper titles. What we strip: timestamps, relative-time phrases,
 * counters with units like "views", "likes", "stars", "comments",
 * "downloads", and excess whitespace.
 */

const ISO_DATETIME =
  /\b\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const US_DATE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const HTTP_DATE =
  /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?\b/gi;
const LONG_DATE =
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/gi;

const RELATIVE_TIME =
  /\b(?:just\s+now|a\s+moment\s+ago|updated\s+(?:on\s+)?|posted\s+|published\s+|ago\b|\d+\s*(?:sec|second|min|minute|hr|hour|day|wk|week|mo|month|yr|year)s?\s+ago\b|yesterday\b|today\b|tomorrow\b|last\s+(?:week|month|year)\b)/gi;

const VOLATILE_COUNTER =
  /\b\d[\d,.]*\s*(?:views?|likes?|hearts?|comments?|replies?|retweets?|reposts?|shares?|stars?|forks?|watchers?|downloads?|installs?|subscribers?|followers?|members?|upvotes?|points?|karma|impressions?|engagements?|reactions?)\b/gi;

const K_M_B_COUNTER =
  /\b\d+(?:\.\d+)?[kKmMbB]\s*(?:views?|likes?|hearts?|comments?|replies?|retweets?|reposts?|shares?|stars?|forks?|watchers?|downloads?|installs?|subscribers?|followers?|members?|upvotes?|points?|karma|impressions?|engagements?|reactions?)\b/gi;

/**
 * Normalize a scraped text blob.
 *
 * Safe to run on anything — idempotent, deterministic, no network,
 * no state. Output is suitable for content hashing and for line-based
 * diffing.
 */
export function normalizeScrapeContent(raw: string): string {
  if (!raw) return '';

  let out = raw;

  // Order matters: strip longer date forms first so partial matches
  // inside them don't escape.
  out = out.replace(ISO_DATETIME, '');
  out = out.replace(HTTP_DATE, '');
  out = out.replace(LONG_DATE, '');
  out = out.replace(US_DATE, '');
  out = out.replace(ISO_DATE, '');

  out = out.replace(RELATIVE_TIME, '');

  // K/M/B counters before decimal counters so "1.2K views" doesn't
  // degrade into "1.2  " (with the K dropped but the digits kept).
  out = out.replace(K_M_B_COUNTER, '');
  out = out.replace(VOLATILE_COUNTER, '');

  // Collapse whitespace: many spaces → one, many blank lines → one,
  // trim each line. Do line-level first so per-line trimming is
  // predictable.
  out = out
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  out = out.trim();

  return out;
}
