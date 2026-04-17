/**
 * The Briefing — seed adapter.
 *
 * Reads x-intel-history.jsonl, keeps only `bucket='advancements'` rows from
 * the last N days, dedupes by headline hash (per-series seen file), picks
 * the freshest unseen row with a real headline + ≥3 highlights. Builds a
 * SeriesSeed shaped for the briefing prompt module.
 *
 * Returns null if no fresh row qualifies — compose-core logs "no fresh
 * seeds" and skips. That's fine; a missed day is better than a forced post.
 */
import {
  loadHistory,
  parseHighlight,
  leaksProduct,
  loadSeen,
  markSeen,
  hash,
} from "./_common.mjs";

const SERIES = "briefing";

export async function pickSeed({ workspace, historyDays = 2 } = {}) {
  const rows = loadHistory(workspace, historyDays);
  if (!rows.length) return null;

  const seen = loadSeen(workspace, SERIES);

  const candidates = rows
    .filter((r) => r.bucket === "advancements")
    .filter((r) => r.headline && !leaksProduct(r.headline))
    .filter((r) => (r.highlights || []).length >= 3)
    .map((r) => ({
      row: r,
      h: hash(`${r.date}:${r.headline}`),
    }))
    .filter((c) => !seen.has(c.h));

  if (!candidates.length) return null;

  // Prefer today's row over older rows. x-intel writes dated rows; newest = most operator-relevant.
  candidates.sort((a, b) => (b.row.date > a.row.date ? 1 : b.row.date < a.row.date ? -1 : 0));

  const pick = candidates[0];
  const row = pick.row;

  const citations = (row.highlights || [])
    .slice(0, 6)
    .map(parseHighlight)
    .filter((c) => c.text && !leaksProduct(c.text));

  const bodyLines = [
    `HEADLINE: ${row.headline}`,
    "",
    "EMERGING PATTERNS:",
    ...(row.emerging_patterns || []).filter((p) => !leaksProduct(p)).map((p) => `- ${p}`),
    "",
    "CONTINUITY (how this connects to earlier days):",
    ...(row.continuity || []).filter((c) => !leaksProduct(c)).slice(0, 3).map((c) => `- ${c}`),
  ];

  const seed = {
    kind: "x-intel",
    title: row.headline,
    body: bodyLines.join("\n"),
    citations,
    metadata: {
      bucket: row.bucket,
      date: row.date,
      freshness_hours: Math.round((Date.now() - new Date(row.date + "T00:00:00Z").getTime()) / 3_600_000),
      posts_seen: row.posts ?? null,
    },
  };

  markSeen(workspace, SERIES, pick.h, row.headline);
  return seed;
}
