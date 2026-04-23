/**
 * Reddit intelligence source.
 * Uses Reddit's public JSON API (no auth required).
 * Targets subreddits and search queries relevant to ohwow's ICP.
 *
 * Returns IntelItem[] sorted by score desc.
 */

const UA = 'ohwow-market-intel/1.0 (autonomous business intelligence)';
const TIMEOUT_MS = 10_000;

// Subreddits + queries for buyer_intent signals (people hiring/buying)
const BUYER_INTENT_SEARCHES = [
  { subreddit: 'forhire', query: 'video editor', label: 'hire:video_editor' },
  { subreddit: 'forhire', query: 'content creator', label: 'hire:content_creator' },
  { subreddit: 'forhire', query: 'AI automation', label: 'hire:ai_automation' },
  { subreddit: 'forhire', query: 'social media manager', label: 'hire:social_media' },
  { subreddit: 'entrepreneur', query: 'looking for editor OR need editor', label: 'hire:entrepreneur_editor' },
  { subreddit: 'NewTubers', query: 'editor', label: 'hire:newtubers_editor' },
];

// Subreddits for AI model release and market signals
const MARKET_FEEDS = [
  { subreddit: 'LocalLLaMA', label: 'market:local_llm', limit: 25 },
  { subreddit: 'MachineLearning', label: 'market:ml_research', limit: 15 },
  { subreddit: 'artificial', label: 'market:ai_general', limit: 10 },
  { subreddit: 'singularity', label: 'market:ai_future', limit: 10 },
  { subreddit: 'ChatGPT', label: 'market:openai_sentiment', limit: 10 },
];

async function fetchJson(url, label) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[reddit] ${label} HTTP ${res.status}`);
      return null;
    }
    return res.json();
  } catch (err) {
    console.warn(`[reddit] ${label} fetch failed: ${err.message}`);
    return null;
  }
}

function redditItemId(post) {
  return `reddit:${post.permalink}`;
}

function postToItem(post, label) {
  const age_h = (Date.now() / 1000 - post.created_utc) / 3600;
  return {
    id: redditItemId(post),
    source_type: 'reddit',
    source_label: label,
    title: post.title,
    text: (post.selftext || '').slice(0, 800),
    url: `https://www.reddit.com${post.permalink}`,
    author: post.author,
    score: post.score,
    comments: post.num_comments,
    subreddit: post.subreddit,
    age_h: Math.round(age_h * 10) / 10,
    created_utc: post.created_utc,
    // classification will fill these
    bucket: null,
    bucket_score: null,
    tags: [],
    why: null,
  };
}

export async function fetchReddit({ maxAgeHours = 72 } = {}) {
  const items = [];
  const seen = new Set();

  // Buyer-intent searches
  for (const { subreddit, query, label } of BUYER_INTENT_SEARCHES) {
    const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&sort=new&restrict_sr=1&limit=25&t=week`;
    const data = await fetchJson(url, label);
    if (!data?.data?.children) continue;
    for (const child of data.data.children) {
      const post = child.data;
      if (!post || post.stickied) continue;
      const age_h = (Date.now() / 1000 - post.created_utc) / 3600;
      if (age_h > maxAgeHours) continue;
      const id = redditItemId(post);
      if (seen.has(id)) continue;
      seen.add(id);
      items.push(postToItem(post, label));
    }
  }

  // Market feeds (hot posts, no query filter)
  for (const { subreddit, label, limit } of MARKET_FEEDS) {
    const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}`;
    const data = await fetchJson(url, label);
    if (!data?.data?.children) continue;
    for (const child of data.data.children) {
      const post = child.data;
      if (!post || post.stickied || post.score < 20) continue;
      const age_h = (Date.now() / 1000 - post.created_utc) / 3600;
      if (age_h > maxAgeHours) continue;
      const id = redditItemId(post);
      if (seen.has(id)) continue;
      seen.add(id);
      items.push(postToItem(post, label));
    }
  }

  items.sort((a, b) => b.score - a.score);
  console.log(`[reddit] fetched ${items.length} items`);
  return items;
}
