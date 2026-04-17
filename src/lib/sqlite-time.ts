/**
 * sqlite-time — safe timestamp parsing for SQLite-sourced strings.
 *
 * SQLite's datetime('now') writes `YYYY-MM-DD HH:MM:SS` with no
 * timezone suffix, always in UTC. JavaScript's Date.parse() on a
 * string without a TZ treats it as **local** time, which shifts the
 * parsed instant by the operator's timezone offset:
 *
 *   '2026-04-17 14:18:02'
 *     SQLite intent: 14:18:02 UTC = 1779545882000 ms
 *     Date.parse:    14:18:02 local (UTC-5 → 19:18:02 UTC) = wrong
 *
 * This broke the reply-scheduler cooldown (sinceLastReply went
 * negative because "now" appeared to be before the last reply),
 * locking the scheduler out until the clock naturally caught up.
 *
 * Use parseSqliteTimestamp(s) whenever you read a timestamp column
 * from the DB and need an ms-since-epoch number. It is idempotent:
 * timestamps that already carry a Z or +HH:MM suffix are parsed as-is.
 *
 * Returns NaN for unparseable or empty inputs — matches Date.parse
 * semantics so call sites can keep their `isNaN()` checks.
 */

/** Normalize a SQLite-style timestamp string to a parseable UTC form. */
export function normalizeSqliteTimestamp(raw: string): string {
  const s = raw?.trim?.() ?? '';
  if (!s) return '';
  // Already has an explicit TZ suffix — Date.parse handles it correctly.
  if (/Z$|[+-]\d\d:?\d\d$/.test(s)) return s;
  // Replace the SQLite space separator with T so the date string is a
  // valid ISO-8601 datetime, then append Z to mark it UTC.
  return s.replace(' ', 'T') + 'Z';
}

/** Parse a SQLite timestamp string (treating no-TZ as UTC) to ms-since-epoch. */
export function parseSqliteTimestamp(raw: string | null | undefined): number {
  if (!raw) return NaN;
  return Date.parse(normalizeSqliteTimestamp(raw));
}
