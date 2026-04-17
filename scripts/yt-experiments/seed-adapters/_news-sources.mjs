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
      const titleLower = s.title.toLowerCase();
      const matchedKeywords = HN_KEYWORDS.filter((k) => titleLower.includes(k));
      const aiRelevance = matchedKeywords.length;
      const ageHours = (nowSec - s.time) / 3600;
      // Score: favor AI relevance, high HN score, and recency (linear decay).
      const score =
        aiRelevance * 30 +
        (s.score || 0) * 0.5 +
        Math.max(0, 48 - ageHours);
      return {
        title: s.title,
        url: s.url,
        domain: safeDomain(s.url),
        hn_score: s.score || 0,
        hn_descendants: s.descendants || 0,
        age_hours: Math.round(ageHours * 10) / 10,
        matched_keywords: matchedKeywords,
        ai_relevance: aiRelevance,
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
 */
export async function fetchRankedNewsCandidates({ maxAgeHours = 48 } = {}) {
  const hn = await fetchHackerNewsTop({ maxAgeHours });
  return rerankByTrust(hn);
}
