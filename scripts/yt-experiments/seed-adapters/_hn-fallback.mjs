/**
 * Briefing fallback — Hacker News + LLM synthesis. When x-intel is empty
 * (or won't surface a story within 24h), this path polls the HN feed
 * directly, picks the highest-signal AI-relevant story, scrapes (via
 * LLM-friendly fetch + markdown strip) the linked page, and asks llm()
 * to extract a structured Briefing seed.
 *
 * No agent-runtime dependency. No Anthropic key requirement. Fast (~5-15s).
 */
import { fetchRankedNewsCandidates } from "./_news-sources.mjs";
import { llm, extractJson } from "../../x-experiments/_ohwow.mjs";

const MAX_CANDIDATES_TO_LLM = 5;
const ARTICLE_CHAR_CAP = 6000;

/**
 * Fetch a URL and return its readable text (best-effort). Strips basic
 * HTML tags; if the site returns pure HTML, we cap at ARTICLE_CHAR_CAP
 * so the LLM prompt doesn't explode.
 */
async function fetchArticleText(url) {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OHWOW-Briefing/1.0; research-only)",
        Accept: "text/html,application/xhtml+xml,text/plain",
      },
      redirect: "follow",
    });
    if (!resp.ok) return null;
    const raw = await resp.text();
    // Strip scripts/styles, then HTML tags. Crude but fine for seed synthesis.
    const stripped = raw
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return stripped.slice(0, ARTICLE_CHAR_CAP);
  } catch {
    return null;
  }
}

/**
 * Fetch the HN comment thread text. When the linked article itself is
 * JS-rendered and returns empty, the HN discussion is usually rich
 * enough to anchor a real summary (top commenters paraphrase the
 * announcement and cite specifics).
 */
async function fetchHnCommentsText(hnId, maxComments = 8) {
  try {
    const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${hnId}.json`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return "";
    const item = await r.json();
    const kids = (item.kids || []).slice(0, maxComments);
    if (!kids.length) return "";
    const comments = await Promise.all(
      kids.map(async (k) => {
        try {
          const cr = await fetch(`https://hacker-news.firebaseio.com/v0/item/${k}.json`, {
            signal: AbortSignal.timeout(5000),
          });
          if (!cr.ok) return "";
          const c = await cr.json();
          if (!c.text) return "";
          return c.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        } catch { return ""; }
      }),
    );
    return comments.filter(Boolean).slice(0, maxComments).join("\n\n---\n\n");
  } catch {
    return "";
  }
}

/**
 * Ask the configured LLM to turn a candidate (title + URL + article text)
 * into a structured {actor, artifact, summary, published_at, citations}
 * object, or {actor: null} if the article doesn't qualify.
 */
async function synthesize(candidate, articleText) {
  const sys = `You are a news-extraction tool for The Briefing (a daily AI-news YouTube Short).

Your job: take a Hacker News link + the scraped article text, and extract a structured Briefing seed as strict JSON.

OUTPUT SCHEMA (return EXACTLY this JSON, nothing else):
{
  "actor": "Company/Lab/Project name",
  "artifact": "Specific thing shipped",
  "summary": "2-3 sentences: what shipped, what's new, why it matters to builders",
  "published_at": "YYYY-MM-DD or null if unclear",
  "citations": [
    {"url": "https://...", "text": "one-line description"}
  ]
}

RULES:
- DO NOT fabricate. If the article doesn't contain an actor + artifact + consequence, return {"actor": null}.
- Cite the canonical URL (the one provided) plus up to 1-2 additional URLs if the article references them.
- NEVER output a summary that mentions OHWOW, local-first runtime, multi-workspace daemon — if the article is about OHWOW itself, return {"actor": null}.
- Keep summary to 2-3 sentences max. Concrete specifics; real numbers where the article has them.
- Prefer actor names that are companies/labs/projects, not humans — though a named researcher is fine if their lab isn't clear.
- Return {"actor": null} if the article is primarily a blog post, opinion piece, or think piece rather than a concrete announcement.`;

  const prompt = `Candidate from Hacker News:
  title: ${candidate.title}
  url: ${candidate.url}
  domain: ${candidate.domain}
  hn_score: ${candidate.hn_score}  age_hours: ${candidate.age_hours}
  trusted_domain: ${candidate.trusted ? "yes" : "no"}
  matched_keywords: ${candidate.matched_keywords.join(", ")}

Article text (truncated to ${ARTICLE_CHAR_CAP} chars):
${articleText || "[article fetch failed]"}

Extract the Briefing seed. Return strict JSON only.`;

  const out = await llm({ purpose: "reasoning", system: sys, prompt });
  return { raw: out.text, model: out.model_used };
}

/**
 * Top-level: poll HN, try the top N candidates one at a time until
 * LLM synthesis produces a valid seed. Returns a SeriesSeed or null.
 *
 * isSeen(candidate) is an optional predicate the adapter can pass so
 * HN candidates already used by this series are filtered out before
 * LLM synthesis. Dedup by hn_id is stable across ranking changes.
 */
export async function pickFromHackerNews({
  maxAgeHours = 48,
  seriesSlug = "briefing",
  isSeen = () => false,
} = {}) {
  let candidates;
  try {
    candidates = await fetchRankedNewsCandidates({ maxAgeHours });
  } catch (e) {
    console.log(`[hn-fallback] HN fetch failed: ${e.message}`);
    return null;
  }
  if (!candidates.length) {
    console.log(`[hn-fallback] no AI-relevant HN stories in last ${maxAgeHours}h`);
    return null;
  }

  // Filter out candidates already used for this series.
  const unseen = candidates.filter((c) => !isSeen(c));
  const skipped = candidates.length - unseen.length;
  if (skipped > 0) {
    console.log(`[hn-fallback] ${skipped} candidates already seen — ${unseen.length} remaining`);
  }
  if (!unseen.length) {
    console.log(`[hn-fallback] all AI candidates have been used — exhausted`);
    return null;
  }
  console.log(`[hn-fallback] ${unseen.length} fresh AI candidates; trying top ${Math.min(MAX_CANDIDATES_TO_LLM, unseen.length)}`);

  const failedIds = [];

  for (const candidate of unseen.slice(0, MAX_CANDIDATES_TO_LLM)) {
    console.log(`[hn-fallback] trying: "${candidate.title}" (${candidate.domain}, hn=${candidate.hn_score}, age=${candidate.age_hours}h, trusted=${candidate.trusted})`);
    let articleText = await fetchArticleText(candidate.url);
    let articleLen = articleText?.length || 0;

    // JS-rendered sites (qwen.ai, openai.com's SPA, etc.) return <200
    // chars from a plain fetch. Fall back to HN discussion text, which
    // usually summarizes the announcement.
    if (articleLen < 200) {
      console.log(`  article fetch returned ${articleLen} chars — trying HN comments`);
      const commentsText = await fetchHnCommentsText(candidate.hn_id);
      if (commentsText && commentsText.length > 200) {
        articleText = `[ARTICLE UNAVAILABLE — falling back to HN discussion thread]\n${commentsText}`;
        articleLen = articleText.length;
        console.log(`  got ${articleLen} chars of HN discussion`);
      } else {
        console.log(`  HN comments also thin (${commentsText.length} chars) — skipping candidate`);
        failedIds.push(candidate.hn_id);
        continue;
      }
    }

    let parsed;
    try {
      const { raw, model } = await synthesize(candidate, articleText);
      parsed = extractJson(raw);
      console.log(`  synthesized with model=${model}`);
    } catch (e) {
      console.log(`  synthesis failed: ${e.message}`);
      continue;
    }
    if (!parsed || !parsed.actor) {
      console.log(`  LLM said no qualifying story — trying next`);
      continue;
    }

    // Build the SeriesSeed.
    const citations = Array.isArray(parsed.citations)
      ? parsed.citations.slice(0, 4).map((c) => {
          if (typeof c === "string") return { url: c };
          return { url: c.url, text: c.text || c.title };
        })
      : [{ url: candidate.url, text: candidate.title }];

    return {
      kind: "external-url",
      title: `${parsed.actor}: ${parsed.artifact}`,
      body: [
        `HEADLINE: ${parsed.actor} — ${parsed.artifact}`,
        "",
        `SUMMARY: ${parsed.summary}`,
        "",
        `PRIMARY CITATION: ${candidate.url} (HN ${candidate.hn_score} pts, ${candidate.age_hours}h old)`,
        `DOMAIN: ${candidate.domain}${candidate.trusted ? " (trusted source)" : ""}`,
        parsed.published_at ? `PUBLISHED: ${parsed.published_at}` : "",
      ].filter(Boolean).join("\n"),
      citations,
      metadata: {
        source: "hn-fallback",
        series: seriesSlug,
        hn_id: candidate.hn_id,
        hn_score: candidate.hn_score,
        age_hours: candidate.age_hours,
        domain: candidate.domain,
        trusted_domain: candidate.trusted,
        fetched_at: new Date().toISOString(),
        failed_hn_ids: failedIds,
      },
    };
  }

  console.log(`[hn-fallback] no candidate produced a valid seed`);
  return null;
}
