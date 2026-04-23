/**
 * HuggingFace intelligence source.
 * Tracks model releases from major AI labs and curated daily papers.
 * No auth required.
 *
 * Returns IntelItem[] for both model releases and papers.
 */

const TIMEOUT_MS = 12_000;

// AI orgs to monitor for model releases — ordered by strategic priority to ohwow
const MODEL_ORGS = [
  { author: 'google', label: 'google_gemini', tier: 1 },
  { author: 'moonshotai', label: 'kimi', tier: 1 },
  { author: 'Qwen', label: 'qwen_alibaba', tier: 1 },
  { author: 'deepseek-ai', label: 'deepseek', tier: 1 },
  { author: 'mistralai', label: 'mistral', tier: 1 },
  { author: 'meta-llama', label: 'meta_llama', tier: 1 },
  { author: 'microsoft', label: 'microsoft_phi', tier: 2 },
  { author: '01-ai', label: 'yi_01ai', tier: 2 },
  { author: 'internlm', label: 'internlm', tier: 2 },
  { author: 'cohere', label: 'cohere', tier: 2 },
  { author: 'NovaSky-Berkeley', label: 'novasky', tier: 2 },
  { author: 'allenai', label: 'allenai', tier: 2 },
  { author: 'HuggingFaceH4', label: 'hf_h4', tier: 2 },
];

async function fetchJson(url, label) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`[huggingface] ${label} HTTP ${res.status}`);
      return null;
    }
    return res.json();
  } catch (err) {
    console.warn(`[huggingface] ${label} fetch failed: ${err.message}`);
    return null;
  }
}

function modelToItem(model, orgLabel, tier) {
  const lastMod = new Date(model.lastModified || model.updatedAt || Date.now());
  const age_h = (Date.now() - lastMod.getTime()) / 3_600_000;
  const tags = (model.tags || []).slice(0, 10);
  const pipeline = model.pipeline_tag || '';
  const downloads7d = model.downloadsAllTime || model.downloads || 0;
  const likes = model.likes || 0;

  return {
    id: `hf-model:${model.id}`,
    source_type: 'hf_model',
    source_label: `hf_models:${orgLabel}`,
    title: model.id,
    text: [
      pipeline && `pipeline: ${pipeline}`,
      tags.length && `tags: ${tags.join(', ')}`,
      `downloads: ${downloads7d.toLocaleString()} | likes: ${likes}`,
    ].filter(Boolean).join(' | '),
    url: `https://huggingface.co/${model.id}`,
    author: orgLabel,
    score: likes + Math.round(Math.log10(downloads7d + 1) * 10),
    likes,
    downloads: downloads7d,
    pipeline_tag: pipeline,
    tags,
    tier,
    last_modified: lastMod.toISOString(),
    age_h: Math.round(age_h * 10) / 10,
    // classification output
    bucket: null,
    bucket_score: null,
    bucket_tags: [],
    why: null,
  };
}

function paperToItem(entry) {
  const paper = entry.paper || entry;
  const publishedAt = new Date(paper.publishedAt || entry.publishedAt || Date.now());
  const age_h = (Date.now() - publishedAt.getTime()) / 3_600_000;
  const authors = (paper.authors || []).slice(0, 5).map(a => typeof a === 'string' ? a : a.name || a.user?.fullname || '').filter(Boolean);

  return {
    id: `hf-paper:${paper.id}`,
    source_type: 'hf_paper',
    source_label: 'hf_daily_papers',
    title: paper.title,
    text: (paper.summary || paper.abstract || '').slice(0, 600),
    url: `https://huggingface.co/papers/${paper.id}`,
    author: authors.join(', ') || 'unknown',
    score: entry.upvotes || 0,
    upvotes: entry.upvotes || 0,
    paper_id: paper.id,
    published_at: publishedAt.toISOString(),
    age_h: Math.round(age_h * 10) / 10,
    // classification output
    bucket: null,
    bucket_score: null,
    bucket_tags: [],
    why: null,
  };
}

export async function fetchHuggingFace({ maxAgeHours = 72, modelsPerOrg = 5 } = {}) {
  const items = [];

  // Daily curated papers
  const papersData = await fetchJson('https://huggingface.co/api/daily_papers?limit=30', 'daily_papers');
  if (Array.isArray(papersData)) {
    for (const entry of papersData) {
      const item = paperToItem(entry);
      if (item.age_h <= maxAgeHours) {
        items.push(item);
      }
    }
    console.log(`[huggingface] daily_papers: ${items.filter(i => i.source_type === 'hf_paper').length} papers`);
  }

  // Model releases per org
  let modelCount = 0;
  for (const { author, label, tier } of MODEL_ORGS) {
    const url = `https://huggingface.co/api/models?author=${author}&sort=lastModified&direction=-1&limit=${modelsPerOrg}`;
    const models = await fetchJson(url, `models:${label}`);
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      const item = modelToItem(model, label, tier);
      if (item.age_h <= maxAgeHours) {
        items.push(item);
        modelCount++;
      }
    }
  }
  console.log(`[huggingface] model_releases: ${modelCount} models`);

  items.sort((a, b) => b.score - a.score);
  return items;
}
