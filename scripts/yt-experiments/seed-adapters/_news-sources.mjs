/**
 * Direct news-source polling — bypasses ohwow's tool stack and hits
 * external feeds with plain Node fetch. Useful when deep_research is
 * unavailable (no Anthropic key) or when we want hermetic, fast
 * fallback that doesn't depend on agent orchestration.
 *
 * Sources polled, in order of preference:
 *   1. Hacker News top stories — high signal for builder-relevant AI news
 *   2. Product Hunt's AI topic (tomorrow — not yet wired)
 *   3. RSS feeds from known labs (tomorrow)
 *
 * Returns an array of {actor, artifact, title, url, domain, score, age_hours}
 * candidates, sorted by combined signal (HN score + age + AI-keyword match).
 * The caller picks the best and uses llm() to shape the final SeriesSeed.
 */

const HN_KEYWORDS = [
  "claude", "anthropic", "openai", "gpt", "llm", "ai model", "language model",
  "gemini", "google deepmind", "deepmind", "mistral", "meta ai", "llama",
  "xai", "grok", "cohere", "perplexity",
  "agent", "agents", "mcp", "rag", "vector db", "embeddings",
  "ai release", "ai announcement", "open weights", "model weights",
  "inference", "training run", "fine-tun",
  "eu ai act", "ai regulation", "ai safety",
  "chatgpt", "copilot", "cursor",
];

/**
 * Fetch the current top-50 story IDs from HN, then pull details for each.
 * Returns a list of stories with AI-keyword relevance scoring.
 */
export async function fetchHackerNewsTop({ maxAgeHours = 48, maxStories = 50 } = {}) {
  const topResp = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json", {
    signal: AbortSignal.timeout(10_000),
  });
  if (!topResp.ok) throw new Error(`HN topstories ${topResp.status}`);
  const ids = (await topResp.json()).slice(0, maxStories);

  const stories = await Promise.all(
    ids.map(async (id) => {
      try {
        const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) return null;
        return await r.json();
      } catch { return null; }
    }),
  );

  const nowSec = Date.now() / 1000;
  const maxAgeSec = maxAgeHours * 3600;

  return stories
    .filter((s) => s && s.type === "story" && s.title && s.url)
    .filter((s) => nowSec - s.time <= maxAgeSec)
    .map((s) => {
      const title = s.title;
      const titleLower = title.toLowerCase();
      const matchedKeywords = HN_KEYWORDS.filter((k) => titleLower.includes(k));
      const aiRelevance = matchedKeywords.length;
      const ageHours = (nowSec - s.time) / 3600;

      // Show HN / Ask HN / Tell HN are community projects, not news.
      // Not banned outright because some Show HN posts do cover real AI
      // releases — but a heavy penalty moves them below official
      // announcements.
      const isCommunityPost = /^(show|ask|tell) hn:/i.test(title);
      const communityPenalty = isCommunityPost ? 50 : 0;

      // Score: favor AI relevance, high HN score, and recency (linear decay).
      const score =
        aiRelevance * 30 +
        (s.score || 0) * 0.5 +
        Math.max(0, 48 - ageHours) -
        communityPenalty;

      return {
        title,
        url: s.url,
        domain: safeDomain(s.url),
        hn_score: s.score || 0,
        hn_descendants: s.descendants || 0,
        age_hours: Math.round(ageHours * 10) / 10,
        matched_keywords: matchedKeywords,
        ai_relevance: aiRelevance,
        is_community_post: isCommunityPost,
        score,
        hn_id: s.id,
      };
    })
    .filter((s) => s.ai_relevance > 0)
    .sort((a, b) => b.score - a.score);
}

function safeDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Known-high-signal domains. Stories on these get a quality multiplier
 * — e.g., a low-point official Anthropic blog is more important than a
 * high-point blog spam rehash.
 */
const TRUSTED_DOMAINS = new Set([
  "anthropic.com",
  "openai.com",
  "deepmind.google",
  "mistral.ai",
  "ai.meta.com",
  "xai.com",
  "research.google",
  "blog.google",
  "huggingface.co",
  "arxiv.org",
  "simonwillison.net",
  "eugeneyan.com",
  "lesswrong.com",
  "alignmentforum.org",
]);

/**
 * Attach a trust boost to stories from canonical sources. Called after
 * fetchHackerNewsTop so the caller can re-rank.
 */
export function rerankByTrust(candidates) {
  return candidates
    .map((c) => ({
      ...c,
      trusted: TRUSTED_DOMAINS.has(c.domain || ""),
      score: c.score + (TRUSTED_DOMAINS.has(c.domain || "") ? 40 : 0),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Top-level: gather a ranked list of AI-relevant candidates from the
 * plain external feeds. No ohwow dependencies.
 *
 * Sources combined:
 *   - Hacker News top 50 (filter by AI keyword + age)
 *   - Lab news pages (Anthropic, OpenAI, DeepMind, Mistral) — fresh
 *     official announcements that may not hit HN front page
 */
export async function fetchRankedNewsCandidates({ maxAgeHours = 48 } = {}) {
  const [hn, labs] = await Promise.all([
    fetchHackerNewsTop({ maxAgeHours }).catch(() => []),
    fetchLabNews({ maxAgeHours }).catch(() => []),
  ]);
  // Dedup by URL: if the same story hit HN and the lab blog, keep the
  // HN version (it carries engagement score).
  const hnUrls = new Set(hn.map((c) => c.url));
  const labOnly = labs.filter((c) => !hnUrls.has(c.url));
  const merged = rerankByTrust([...hn, ...labOnly]);
  return merged;
}

// ---------------------------------------------------------------------------
// Lab news scraping
// ---------------------------------------------------------------------------
// Each lab publishes announcements on a news / blog page. We scrape the
// index page HTML, extract headlines + href + published dates, and return
// candidates in the same shape as the HN ones so the scoring / synthesis
// pipeline doesn't care about provenance.
//
// This fills gaps HN misses: quiet launches, enterprise announcements,
// pricing / deprecation notices that don't hit the HN front page.

const LAB_SOURCES = [
  { name: "anthropic", url: "https://www.anthropic.com/news", domain: "anthropic.com" },
  { name: "openai", url: "https://openai.com/news/", domain: "openai.com" },
  { name: "deepmind", url: "https://deepmind.google/discover/blog/", domain: "deepmind.google" },
  { name: "mistral", url: "https://mistral.ai/news/", domain: "mistral.ai" },
  { name: "xai", url: "https://x.ai/news", domain: "x.com" },
];

async function fetchLabNews({ maxAgeHours = 48 } = {}) {
  const results = await Promise.all(LAB_SOURCES.map((src) => scrapeLabIndex(src, maxAgeHours).catch(() => [])));
  return results.flat();
}

/**
 * Scrape a lab's news/blog index and return recent article candidates.
 * Uses a heuristic parser — looks for article anchors with a date or
 * title-like text.
 */
async function scrapeLabIndex(src, maxAgeHours) {
  let html;
  try {
    const resp = await fetch(src.url, {
      signal: AbortSignal.timeout(8_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OHWOW-Briefing/1.0; research-only)",
        Accept: "text/html",
      },
      redirect: "follow",
    });
    if (!resp.ok) return [];
    html = await resp.text();
  } catch {
    return [];
  }

  // Extract all anchor links; filter to ones that look like article paths.
  // Each lab has slightly different URL patterns but they all follow
  // /news/<slug> or /blog/<slug> shapes.
  // Article path shape per source — anchors match this pattern OR they
  // get skipped. This single rule drops 95% of nav/footer noise without
  // needing per-lab special cases.
  const articlePaths = [
    /\/news\/[a-z0-9][a-z0-9-]{3,}/i,
    /\/blog\/[a-z0-9][a-z0-9-]{3,}/i,
    /\/posts?\/[a-z0-9][a-z0-9-]{3,}/i,
    /\/discover\/blog\/[a-z0-9][a-z0-9-]{3,}/i,
    /\/research\/[a-z0-9][a-z0-9-]{3,}/i,
    /\/index\/[a-z0-9][a-z0-9-]{3,}/i, // openai.com/index/<slug>
  ];

  // Short CTA/nav titles that slip past the path filter. Case-insensitive.
  const CTA_TITLE_STARTS = [
    /^try /i, /^build with /i, /^get started/i, /^sign up/i, /^sign in/i,
    /^log in/i, /^book a/i, /^contact /i, /^learn more$/i, /^read more$/i,
    /^see all/i, /^view all/i, /^press@/i, /^support@/i,
    /^download/i, /^watch /i, /^explore/i, /^careers/i,
  ];

  const articleRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const candidates = [];
  const seen = new Set();
  let m;
  while ((m = articleRe.exec(html)) !== null) {
    const href = m[1];
    // Skip mailto/tel/anchor-only links early.
    if (!href || /^(mailto:|tel:|#|javascript:)/i.test(href)) continue;

    const textRaw = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!textRaw || textRaw.length < 15 || textRaw.length > 200) continue;

    // Normalize href to absolute.
    let url;
    try {
      url = new URL(href, src.url).toString();
    } catch { continue; }
    // Only accept same-domain article paths with article-shaped paths.
    if (!url.includes(src.domain)) continue;
    if (!articlePaths.some((re) => re.test(url))) continue;
    // Skip obvious index pages / tags / CTAs.
    if (/\/(tag|category|about|careers|contact|privacy|legal|subscribe|press|team|authors?)(\/|$)/i.test(url)) continue;
    // CTA-style titles.
    if (CTA_TITLE_STARTS.some((re) => re.test(textRaw))) continue;

    // Dedup by URL.
    if (seen.has(url)) continue;
    seen.add(url);
    candidates.push({ url, title: textRaw, lab: src.name, domain: src.domain });
    if (candidates.length >= 15) break;
  }

  // Parse dates from title text when present (labs often prefix with
  // "Apr 17, 2026" or similar). Filter to maxAgeHours where we can.
  const now = Date.now();
  const withAge = candidates.map((c) => {
    const titleDate = extractLeadingDate(c.title);
    const ageHours = titleDate ? Math.round((now - titleDate) / 3_600_000) : null;
    // Strip the date prefix from the visible title to keep it clean.
    const cleanTitle = c.title.replace(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s*\d{0,4}\s+/i, "").trim();
    return { ...c, age_hours: ageHours, title: cleanTitle || c.title };
  });
  // Filter by age when known. If age is unknown, keep (index-page ordering
  // gives us a prior that it's recent-ish).
  const fresh = withAge.filter((c) => c.age_hours === null || c.age_hours <= maxAgeHours);

  return fresh.slice(0, 5).map((c) => ({
    title: c.title,
    url: c.url,
    domain: c.domain,
    hn_score: 0,
    hn_descendants: 0,
    age_hours: c.age_hours,
    matched_keywords: matchAiKeywords(c.title),
    ai_relevance: matchAiKeywords(c.title).length,
    is_community_post: false,
    // Lab-blog score: base 40, +20 per keyword match, +30 if dated <24h.
    score: 40 + matchAiKeywords(c.title).length * 20 + (c.age_hours !== null && c.age_hours <= 24 ? 30 : 0),
    hn_id: `lab:${c.lab}:${encodeURIComponent(c.url).slice(0, 32)}`,
    source_type: "lab-blog",
  }));
}

/**
 * Try to parse a leading date from a title like "Apr 17, 2026 Product ..."
 * Returns Unix ms or null.
 */
function extractLeadingDate(title) {
  const m = title.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s*(\d{4})?/i);
  if (!m) return null;
  const year = m[3] || String(new Date().getUTCFullYear());
  const parsed = Date.parse(`${m[1]} ${m[2]}, ${year}`);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchAiKeywords(text) {
  const t = text.toLowerCase();
  return HN_KEYWORDS.filter((k) => t.includes(k));
}
