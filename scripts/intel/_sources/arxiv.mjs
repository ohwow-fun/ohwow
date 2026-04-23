/**
 * ArXiv intelligence source.
 * Queries the ArXiv Atom API for recent AI/ML papers relevant to ohwow.
 * No auth required. Returns after XML parsing — no external dependencies.
 *
 * Returns IntelItem[] sorted by published date desc.
 */

const TIMEOUT_MS = 15_000;
const BASE_URL = 'https://export.arxiv.org/api/query';

// Query groups — each fetches papers matching the topic
// ohwow relevance: autonomous agents, multi-agent, efficient LLMs, reasoning
const QUERY_GROUPS = [
  {
    label: 'agents_autonomous',
    query: '(ti:agent OR ti:agentic OR ti:autonomous) AND (cat:cs.AI OR cat:cs.LG)',
    max: 15,
  },
  {
    label: 'multi_agent',
    query: 'ti:"multi-agent" AND (cat:cs.AI OR cat:cs.MA)',
    max: 10,
  },
  {
    label: 'reasoning_planning',
    query: '(ti:reasoning OR ti:planning OR ti:chain-of-thought) AND cat:cs.AI',
    max: 10,
  },
  {
    label: 'efficient_llm',
    query: '(ti:efficient OR ti:quantization OR ti:distillation OR ti:pruning) AND (cat:cs.LG OR cat:cs.AI)',
    max: 10,
  },
  {
    label: 'multimodal_vision',
    query: '(ti:multimodal OR ti:vision-language OR ti:VLM) AND (cat:cs.CV OR cat:cs.AI)',
    max: 8,
  },
];

async function fetchAtom(query, max, label) {
  const params = new URLSearchParams({
    search_query: query,
    max_results: String(max),
    sortBy: 'submittedDate',
    sortOrder: 'descending',
  });
  const url = `${BASE_URL}?${params}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`[arxiv] ${label} HTTP ${res.status}`);
      return '';
    }
    return res.text();
  } catch (err) {
    console.warn(`[arxiv] ${label} fetch failed: ${err.message}`);
    return '';
  }
}

// Minimal Atom XML parser using regex — avoids external deps
function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
}

function extractAllTags(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1].replace(/<[^>]+>/g, '').trim());
  }
  return results;
}

function extractAttr(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, 'i'));
  return m ? m[1] : '';
}

function extractCategories(entryXml) {
  const re = /<category\s+term="([^"]+)"/g;
  const cats = [];
  let m;
  while ((m = re.exec(entryXml)) !== null) cats.push(m[1]);
  return cats;
}

function parseEntries(xml) {
  const entries = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const body = m[1];
    const id = extractTag(body, 'id').replace('http://arxiv.org/abs/', '').replace('https://arxiv.org/abs/', '');
    const title = extractTag(body, 'title').replace(/\s+/g, ' ');
    const summary = extractTag(body, 'summary').replace(/\s+/g, ' ').slice(0, 600);
    const published = extractTag(body, 'published');
    const authors = extractAllTags(body, 'name').slice(0, 5);
    const categories = extractCategories(body);
    // Primary link (alternate type)
    const linkMatch = body.match(/<link\s+[^>]*href="([^"]+)"[^>]*rel="alternate"/);
    const link = linkMatch ? linkMatch[1] : `https://arxiv.org/abs/${id}`;

    if (!id || !title) continue;
    entries.push({ id, title, summary, published, authors, categories, link });
  }
  return entries;
}

export async function fetchArxiv({ maxAgeHours = 72 } = {}) {
  const items = [];
  const seen = new Set();

  for (const { label, query, max } of QUERY_GROUPS) {
    const xml = await fetchAtom(query, max, label);
    if (!xml) continue;

    const entries = parseEntries(xml);
    let added = 0;
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      const published = new Date(entry.published);
      const age_h = (Date.now() - published.getTime()) / 3_600_000;
      if (age_h > maxAgeHours) continue;
      seen.add(entry.id);
      items.push({
        id: `arxiv:${entry.id}`,
        source_type: 'arxiv',
        source_label: `arxiv:${label}`,
        title: entry.title,
        text: entry.summary,
        url: entry.link,
        author: entry.authors.join(', ') || 'unknown',
        score: 0,
        paper_id: entry.id,
        categories: entry.categories,
        published_at: published.toISOString(),
        age_h: Math.round(age_h * 10) / 10,
        query_label: label,
        // classification output
        bucket: null,
        bucket_score: null,
        bucket_tags: [],
        why: null,
      });
      added++;
    }
    console.log(`[arxiv] ${label}: ${added} papers`);
  }

  // Sort by published date desc
  items.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
  return items;
}
