/**
 * Tomorrow Broke — seed adapter.
 *
 * Mines x-intel history for `predictions[]` rows (falsifiable near-future
 * forecasts with actor + artifact + by_when). High-confidence + high-
 * specificity predictions are the richest material for cinematic
 * extrapolation. Falls back to emerging_patterns when predictions are thin.
 *
 * Writes new scenarios it touches to `tomorrow-broke-scenarios.jsonl` so
 * we can diff the scenario archive over time.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadHistory,
  parseHighlight,
  leaksProduct,
  loadSeen,
  markSeen,
  hash,
  randomPick,
} from "./_common.mjs";

const SERIES = "tomorrow-broke";

function scenarioArchivePath(workspace) {
  return path.join(os.homedir(), ".ohwow", "workspaces", workspace, "tomorrow-broke-scenarios.jsonl");
}

export async function pickSeed({ workspace, historyDays = 10 } = {}) {
  const rows = loadHistory(workspace, historyDays);
  if (!rows.length) return null;

  const seen = loadSeen(workspace, SERIES);

  // Primary: mine predictions.
  const predictions = [];
  for (const row of rows) {
    for (const p of row.predictions || []) {
      if (!p.what || leaksProduct(p.what)) continue;
      if ((p.confidence ?? 0) < 0.35) continue;
      const h = hash(p.id || `${row.date}:${p.what}`);
      if (seen.has(h)) continue;
      predictions.push({
        h,
        date: row.date,
        what: p.what,
        by_when: p.by_when,
        confidence: p.confidence,
        citations: (p.citations || []).slice(0, 4),
        row,
      });
    }
  }

  let pick = null;
  if (predictions.length) {
    pick = randomPick(predictions);
  } else {
    // Fallback: pick an emerging_patterns bullet from a random bucket/day.
    const patterns = [];
    for (const row of rows) {
      for (const p of row.emerging_patterns || []) {
        if (leaksProduct(p)) continue;
        const h = hash(`${row.date}:${p}`);
        if (seen.has(h)) continue;
        patterns.push({ h, date: row.date, what: p, confidence: null, by_when: null, citations: [], row });
      }
    }
    if (!patterns.length) return null;
    pick = randomPick(patterns);
  }

  const citations = (pick.citations || [])
    .map((c) => (typeof c === "string" ? parseHighlight(c) : c))
    .filter((c) => c && c.text && !leaksProduct(c.text))
    .slice(0, 4);

  // Also pull 2-3 related highlights from the same row for texture.
  const rowHighlights = (pick.row.highlights || [])
    .filter((h) => !leaksProduct(h))
    .slice(0, 3)
    .map(parseHighlight);

  const bodyLines = [
    `FORECAST: ${pick.what}`,
    pick.by_when ? `HORIZON: ${pick.by_when}` : "",
    pick.confidence != null ? `SOURCE CONFIDENCE: ${pick.confidence}` : "",
    "",
    "RELATED CONTEXT (from the same intel brief):",
    ...rowHighlights.slice(0, 3).map((h) => `- ${h.handle ? "@" + h.handle + ": " : ""}"${h.text}"`),
  ].filter(Boolean);

  // Archive the scenario so the set of things Tomorrow Broke has "touched"
  // is discoverable later (diversity audit, diffing across weeks).
  try {
    const archive = scenarioArchivePath(workspace);
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.appendFileSync(
      archive,
      JSON.stringify({
        hash: pick.h,
        ts: new Date().toISOString(),
        forecast: pick.what,
        by_when: pick.by_when,
        confidence: pick.confidence,
      }) + "\n",
    );
  } catch { /* non-fatal */ }

  const seed = {
    kind: predictions.length ? "prediction" : "x-intel",
    title: (pick.what || "").slice(0, 120),
    body: bodyLines.join("\n"),
    citations: citations.length ? citations : rowHighlights,
    metadata: {
      prediction_id: pick.h,
      confidence: pick.confidence,
      by_when: pick.by_when,
      source_date: pick.date,
    },
  };

  markSeen(workspace, SERIES, pick.h, seed.title);
  return seed;
}
