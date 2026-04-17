/**
 * Operator Mode — seed adapter.
 *
 * Primary source: x-intel `bucket='hacks'` rows (tactical ops content —
 * workflows, tool combos, time-saving tricks). Secondary: an SMB use-case
 * bank at `~/.ohwow/workspaces/<ws>/operator-mode-use-cases.jsonl` that the
 * team populates over time.
 *
 * Returns null when both sources are thin. A missed Operator Mode day is
 * preferable to a vague "use AI to save time" post.
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

const SERIES = "operator-mode";

function useCasesPath(workspace) {
  return path.join(os.homedir(), ".ohwow", "workspaces", workspace, "operator-mode-use-cases.jsonl");
}

function loadUseCases(workspace) {
  const p = useCasesPath(workspace);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export async function pickSeed({ workspace, historyDays = 5 } = {}) {
  const seen = loadSeen(workspace, SERIES);

  // 1. Curated use-case bank first — quality > quantity.
  const useCases = loadUseCases(workspace)
    .filter((uc) => uc.pain && uc.workflow && !leaksProduct(uc.pain))
    .map((uc) => ({ ...uc, _hash: hash(uc.id || uc.pain) }))
    .filter((uc) => !seen.has(uc._hash));

  if (useCases.length) {
    const pick = randomPick(useCases);
    const seed = {
      kind: "internal-archive",
      title: pick.pain.slice(0, 120),
      body: [
        `PAIN: ${pick.pain}`,
        pick.vertical ? `VERTICAL: ${pick.vertical}` : "",
        pick.team_size ? `TEAM SIZE: ${pick.team_size}` : "",
        "",
        `WORKFLOW:\n${pick.workflow}`,
        pick.outcome_metric ? `\nOUTCOME METRIC: ${pick.outcome_metric}` : "",
        pick.tools ? `\nTOOLS: ${Array.isArray(pick.tools) ? pick.tools.join(", ") : pick.tools}` : "",
      ].filter(Boolean).join("\n"),
      citations: [],
      metadata: {
        use_case_id: pick.id || pick._hash,
        vertical: pick.vertical || null,
        team_size: pick.team_size || null,
        source: "use-case-bank",
      },
    };
    markSeen(workspace, SERIES, pick._hash, seed.title);
    return seed;
  }

  // 2. Fallback: x-intel 'hacks' bucket.
  const rows = loadHistory(workspace, historyDays);
  if (!rows.length) return null;

  const candidates = [];
  for (const row of rows) {
    if (row.bucket !== "hacks") continue;
    for (const p of row.emerging_patterns || []) {
      if (leaksProduct(p)) continue;
      const h = hash(`${row.date}:${p}`);
      if (seen.has(h)) continue;
      candidates.push({ h, pattern: p, row });
    }
  }
  if (!candidates.length) return null;

  const pick = randomPick(candidates);
  const highlights = (pick.row.highlights || [])
    .filter((h) => !leaksProduct(h))
    .slice(0, 4)
    .map(parseHighlight);

  const seed = {
    kind: "x-intel",
    title: pick.pattern.slice(0, 120),
    body: [
      `OBSERVED WORKFLOW PATTERN: ${pick.pattern}`,
      "",
      "RELATED POSTS (for specificity — tool names, real numbers):",
      ...highlights.map((h) => `- ${h.handle ? "@" + h.handle + ": " : ""}"${h.text}"`),
    ].join("\n"),
    citations: highlights,
    metadata: {
      bucket: "hacks",
      date: pick.row.date,
      source: "x-intel-hacks",
    },
  };

  markSeen(workspace, SERIES, pick.h, seed.title);
  return seed;
}
