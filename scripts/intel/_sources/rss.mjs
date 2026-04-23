/**
 * RSS/Atom blog feed source.
 * Tracks AI lab blogs and key industry feeds.
 * Pure fetch + regex XML parsing (no external deps).
 *
 * Returns IntelItem[] sorted by published date desc.
 */

const TIMEOUT_MS = 10_000;

const FEEDS = [
  { url: 'https://huggingface.co/blog/feed.xml', label: 'hf_blog', org: 'HuggingFace' },
  { url: 'https://openai.com/blog/rss.xml', label: 'openai_blog', org: 'OpenAI' },
  { url: 'https://deepmind.google/blog/rss.xml', label: 'deepmind_blog', org: 'Google DeepMind' },
  { url: 'https://blog.google/innovation-and-ai/technology/ai/rss/', label: 'google_ai_blog', org: 'Google AI' },
  { url: 'https://simonwillison.net/atom/everything/', label: 'simon_willison', org: 'Simon Willison' },
  { url: 'https://lilianweng.github.io/index.xml', label: 'lilian_weng', org: 'Lilian Weng' },
  { url: 'https://blog.langchain.dev/rss/', label: 'langchain_blog', org: 'LangChain' },
  { url: 'https://www.interconnects.ai/feed', label: 'interconnects', org: 'Interconnects (Nathan Lambert)' },
  {
    url: 'https://www.producthunt.com/feed',
    label: 'producthunt_launches',
    org: 'Product Hunt',
    filter: (item) => {
      const keywords = ['ai', 'automation', 'agent', 'workflow', 'llm', 'gpt', 'claude', 'chatbot', 'bot', 'ml', 'machine learning', 'autonomous', 'assistant'];
      const searchText = `${item.title} ${item.summary}`.toLowerCase();
      return keywords.some(kw => searchText.includes(kw));
    },
  },
];

async function fetchFeed(url, label) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ohwow-market-intel/1.0' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[rss] ${label} HTTP ${res.status}`);
      return '';
    }
    return res.text();
  } catch (err) {
    console.warn(`[rss] ${label} failed: ${err.message}`);
    return '';
  }
}

function stripCdata(s) {
  return (s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseDate(s) {
  if (!s) return null;
  try { return new Date(s.trim()); } catch { return null; }
}

// Parse both RSS 2.0 <item> and Atom <entry> formats
function parseFeedItems(xml) {
  const items = [];

  // Try Atom entries first
  const atomRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = atomRe.exec(xml)) !== null) {
    const body = m[1];
    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = stripCdata(stripHtml(titleMatch?.[1] || ''));
    const summaryMatch = body.match(/<(?:summary|content)[^>]*>([\s\S]*?)<\/(?:summary|content)>/i);
    const summary = stripHtml(stripCdata(summaryMatch?.[1] || '')).slice(0, 500);
    const linkMatch = body.match(/<link[^>]+href="([^"]+)"/i) || body.match(/<link[^>]*>(https?:\/\/[^<]+)<\/link>/i);
    const link = linkMatch?.[1] || '';
    const dateMatch = body.match(/<(?:published|updated)[^>]*>([\s\S]*?)<\/(?:published|updated)>/i);
    const date = parseDate(dateMatch?.[1]);
    const idMatch = body.match(/<id[^>]*>([\s\S]*?)<\/id>/i);
    const id = (idMatch?.[1] || link || '').trim();
    if (!title || !id) continue;
    items.push({ id, title, summary, link, date });
  }

  // RSS 2.0 <item> format
  const rssRe = /<item>([\s\S]*?)<\/item>/g;
  while ((m = rssRe.exec(xml)) !== null) {
    const body = m[1];
    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = stripCdata(stripHtml(titleMatch?.[1] || ''));
    const descMatch = body.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
    const summary = stripHtml(stripCdata(descMatch?.[1] || '')).slice(0, 500);
    const linkMatch = body.match(/<link>(https?:\/\/[^<]+)<\/link>/i) ||
                      body.match(/<link[^>]+href="([^"]+)"/i);
    const link = (linkMatch?.[1] || '').trim();
    const guidMatch = body.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
    const id = stripCdata(guidMatch?.[1] || link || '').trim();
    const pubDateMatch = body.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    const date = parseDate(pubDateMatch?.[1]);
    if (!title || !id) continue;
    items.push({ id, title, summary, link, date });
  }

  return items;
}

export async function fetchRss({ maxAgeHours = 96 } = {}) {
  const items = [];
  const seen = new Set();

  for (const feed of FEEDS) {
    const { url, label, org } = feed;
    const xml = await fetchFeed(url, label);
    if (!xml) continue;

    const feedItems = parseFeedItems(xml);
    const filteredItems = feed.filter
      ? feedItems.filter(fi => feed.filter({ title: fi.title, summary: fi.summary }))
      : feedItems;
    let added = 0;
    for (const fi of filteredItems) {
      const id = `rss:${fi.id || fi.link}`;
      if (seen.has(id)) continue;
      const age_h = fi.date ? (Date.now() - fi.date.getTime()) / 3_600_000 : 999;
      if (age_h > maxAgeHours) continue;
      seen.add(id);
      items.push({
        id,
        source_type: 'rss',
        source_label: label,
        title: fi.title,
        text: fi.summary,
        url: fi.link,
        author: org,
        score: 0,
        org,
        published_at: fi.date?.toISOString() || null,
        age_h: Math.round(age_h * 10) / 10,
        // classification output
        bucket: null,
        bucket_score: null,
        bucket_tags: [],
        why: null,
      });
      added++;
    }
    console.log(`[rss] ${label}: ${added} items${feed.filter ? ` (filtered from ${feedItems.length})` : ''}`);
  }

  items.sort((a, b) => {
    const da = a.published_at ? new Date(a.published_at) : new Date(0);
    const db = b.published_at ? new Date(b.published_at) : new Date(0);
    return db - da;
  });
  return items;
}
