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
import { researchViaOrchestrator } from "./_researcher-fallback.mjs";
import { pickFromHackerNews } from "./_hn-fallback.mjs";

const SERIES = "briefing";

const RESEARCH_PROMPT = `Find the single most important EXTERNAL AI announcement from the last 48 hours that a time-poor founder or operator needs to know about.

CRITICAL CONTEXT: You (the researcher) are part of OHWOW.FUN. The workspace's local knowledge base contains OHWOW's own documents (show bibles, product marketing, etc.). Those are NOT news. Ignore any local-knowledge result that mentions OHWOW, local-first runtime, multi-workspace daemon, or any variant of our own product. We want news ABOUT THE AI INDUSTRY, not about ourselves. The answer must be about an external company, lab, or project — NEVER OHWOW.


HARD RULES:
1. Your ONLY deliverable is a single JSON object. No prose, no questions, no offers to "continue checking". Return the JSON and stop.
2. Every field must be grounded in a source you actually fetched. If scrape_search / scrape_url returns nothing usable, your JSON is {"actor": null} — nothing else.
3. Do NOT fabricate pricing, dates, model versions, or URLs. If the search tools didn't return real data, return {"actor": null}.
4. A source URL is REQUIRED. If you can't produce a URL you verified via scrape_url, return {"actor": null}.

CRITERIA for a qualifying story:
- Named actor: a specific company, lab, open-source project, or research group (not "the AI industry")
- Specific artifact: a named model version, product, paper, dataset, or regulation (not a vague trend)
- Real consequence: something that changes a builder's or operator's calculations this week
- Verifiably happened within the last 48 hours

SOURCE PRIORITY: official blog posts (Anthropic, OpenAI, Google DeepMind, Mistral, Meta AI, xAI), GitHub release pages for major OSS AI projects, arXiv for landmark papers, Hacker News front page (verify via the linked source, not the HN comments), regulatory dockets. Prefer 2+ independent citations.

AVOID: rumors, speculation, stories older than 48 hours, generic think-pieces, vendor marketing dressed as news, anything reducing to "AI is moving fast."

OUTPUT SCHEMA (return exactly this shape):
{
  "actor": "Company/Lab/Project name" | null,
  "artifact": "Specific thing (e.g., 'Claude 4.7 Opus', 'gpt-4.5-preview', 'EU AI Act Article 6')",
  "summary": "2-3 sentences: what shipped, what's new, why it matters to builders",
  "published_at": "ISO-8601 date of the announcement (YYYY-MM-DD)",
  "citations": [
    {"url": "https://...", "text": "one-line description of what this source proves"}
  ]
}

If no qualifying story exists, return {"actor": null} and stop.`;

export async function pickSeed({ workspace, historyDays = 2, skipFallback = false } = {}) {
  const rows = loadHistory(workspace, historyDays);
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

  // Primary source (x-intel) empty → two-tier fallback:
  //   Tier 1: Hacker News direct poll + LLM synthesis. Fast (~10s), no
  //     agent-runtime dependency, no Anthropic key required. Covers 80%
  //     of "what's the big AI news right now" because HN's front page is
  //     highly correlated with what matters to builders.
  //   Tier 2: orchestrator deep_research. Only useful when an Anthropic
  //     key is configured (deep_research's web search is gated on it);
  //     otherwise it falls through to local knowledge which isn't news.
  //     Kept as a last resort for when HN misses.
  if (!candidates.length) {
    if (skipFallback) return null;

    console.log(`[briefing-seed] x-intel empty — trying Hacker News fallback`);
    let seed = await pickFromHackerNews({ maxAgeHours: 48, seriesSlug: SERIES });

    if (!seed) {
      console.log(`[briefing-seed] HN produced no seed — trying orchestrator deep_research`);
      seed = await researchViaOrchestrator({
        researchPrompt: RESEARCH_PROMPT,
        seriesSlug: SERIES,
      });
    }

    if (!seed) return null;
    // Mark the fallback seed as seen so we don't re-pick the same story
    // on the next compose run today.
    markSeen(workspace, SERIES, hash(seed.title), seed.title);
    return seed;
  }

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
