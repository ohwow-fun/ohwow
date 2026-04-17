/**
 * Shared utilities for per-series seed adapters. Each adapter exports
 * `pickSeed({ workspace, historyDays })` returning a SeriesSeed or null.
 *
 * The SeriesSeed shape mirrors src/integrations/youtube/series/script-prompts/types.ts:
 *   { kind, title, body, citations?: [{handle,url,text}], metadata?: {} }
 *
 * Compose-core reads seeds with NO idea what series it's running — the
 * adapter has already done the filtering + dedup + shaping.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export function historyPath(workspace) {
  return path.join(os.homedir(), ".ohwow", "workspaces", workspace, "x-intel-history.jsonl");
}

export function loadHistory(workspace, daysBack) {
  const p = historyPath(workspace);
  if (!fs.existsSync(p)) return [];
  const cutoff = Date.now() - daysBack * 86400_000;
  return fs.readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.date && new Date(r.date + "T00:00:00Z").getTime() >= cutoff);
}

/**
 * Parse a highlight string "text (perma=/handle/status/id)" into structured
 * form. x-intel emits highlights with permalinks appended; adapters want the
 * handle split out for citation purposes.
 */
export function parseHighlight(raw) {
  const m = raw.match(/\(perma=\/([^/]+)\/status\/\d+\)?$/);
  const handle = m ? m[1] : null;
  const text = raw.replace(/\s*\(perma=[^)]*\)?\s*$/, "").trim();
  const url = m ? `https://x.com/${handle}/status/${raw.match(/status\/(\d+)/)?.[1] ?? ""}` : null;
  return { handle, text, url };
}

/**
 * True when a string mentions OHWOW or its internals. Seeds that hit this
 * are filtered out before they ever reach a prompt module.
 */
export function leaksProduct(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const hits = [
    "ohwow",
    "mcp-first",
    "multi-workspace daemon",
    "our daemon",
    "local-first ai runtime",
  ];
  return hits.some((s) => t.includes(s));
}

/**
 * Per-workspace dedup store. Each series keeps its own file; we don't want
 * Briefing's dedup filtering Operator Mode's candidates.
 */
export function seenPath(workspace, series) {
  return path.join(os.homedir(), ".ohwow", "workspaces", workspace, `yt-seed-seen-${series}.jsonl`);
}

export function loadSeen(workspace, series) {
  const p = seenPath(workspace, series);
  if (!fs.existsSync(p)) return new Set();
  return new Set(
    fs.readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l).hash; } catch { return null; } })
      .filter(Boolean),
  );
}

export function markSeen(workspace, series, hash, title) {
  const p = seenPath(workspace, series);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ hash, title, ts: new Date().toISOString() }) + "\n");
}

export function hash(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}

/**
 * Reservoir-style random pick. Fair across unknown-length pools without
 * reading everything twice.
 */
export function randomPick(arr) {
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}
