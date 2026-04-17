#!/usr/bin/env node
/**
 * yt-series-bootstrap — create the ohwow-side entities for a series.
 * Idempotent: re-running it detects existing rows by name and updates
 * them rather than creating duplicates.
 *
 * Creates, per series:
 *   1. One agent_workforce_projects row named "<Series Display Name>".
 *   2. Three agents: <slug>-researcher, <slug>-writer, <slug>-editor.
 *      Each with a tailored system_prompt (pulled from the TS prompt
 *      module), tools allowlist, and memory_document.
 *   3. Goals (one per goalKpiIds entry).
 *   4. Show-bible knowledge document: reads docs/youtube/<slug>-showbible.md
 *      and uploads via /api/knowledge.
 *
 * Usage:
 *   node --import tsx scripts/yt-experiments/yt-series-bootstrap.mjs briefing
 *   node --import tsx scripts/yt-experiments/yt-series-bootstrap.mjs --all
 *
 * TODO(phase-1): richer agent system prompts, memory_document seeding,
 * file_access_paths grants (see ohwow_grant_agent_path).
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveOhwow } from '../x-experiments/_ohwow.mjs';
import { getSeries, listSeries } from '../../src/integrations/youtube/series/registry.js';
import { getPromptModule } from '../../src/integrations/youtube/series/script-prompts/index.js';

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const slugArg = args.find((a) => !a.startsWith('--'));

async function daemonRequest(method, route, body) {
  const { url, token } = resolveOhwow();
  const headers = { authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url + route, { method, headers, body: payload });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`${method} ${route} ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

function asArray(resp) {
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp?.data)) return resp.data;
  if (Array.isArray(resp?.projects)) return resp.projects;
  if (Array.isArray(resp?.agents)) return resp.agents;
  if (Array.isArray(resp?.goals)) return resp.goals;
  return [];
}

async function ensureProject(series) {
  const list = await daemonRequest('GET', '/api/projects');
  const existing = asArray(list).find((p) => p.name === series.displayName);
  if (existing) {
    console.log(`  project "${series.displayName}" exists (id=${existing.id})`);
    return existing;
  }
  const created = await daemonRequest('POST', '/api/projects', {
    name: series.displayName,
    description: `OHWOW.FUN YouTube series — ${series.tagline}`,
  });
  const id = created.data?.id || created.id || created.project?.id;
  console.log(`  project "${series.displayName}" created (id=${id})`);
  return created.data || created;
}

async function ensureAgent(series, role, baseSystemPrompt) {
  const name = `${series.slug}-${role}`;
  const list = await daemonRequest('GET', '/api/agents').catch(() => ({ data: [] }));
  const existing = asArray(list).find((a) => a.name === name);
  if (existing) {
    console.log(`  agent "${name}" exists (id=${existing.id})`);
    return existing;
  }
  const descriptions = {
    researcher: `Scouts sources + picks the best daily seed for ${series.displayName}.`,
    writer: `Drafts ${series.displayName} episode scripts following the format contract.`,
    editor: `Checks tone, banned phrases, format, and loop landing for ${series.displayName}.`,
  };
  const systemPrompt = `You are the ${role} for ${series.displayName}. ${descriptions[role]}\n\n${baseSystemPrompt}`;
  // Tool names must match the orchestrator's toolRegistry (see
  // src/orchestrator/tools/*.ts). Web browsing lives under scrape_*;
  // knowledge RAG lives under search_knowledge / get_knowledge_document.
  const toolsAllowlist =
    role === 'researcher'
      ? ['scrape_search', 'scrape_url', 'search_knowledge', 'get_knowledge_document']
      : role === 'writer'
      ? ['search_knowledge', 'get_knowledge_document']
      : ['search_knowledge', 'get_knowledge_document', 'scrape_url'];
  const body = {
    name,
    role,
    system_prompt: systemPrompt,
    display_name: `${series.displayName} ${role.replace(/\b\w/g, (c) => c.toUpperCase())}`,
    description: descriptions[role],
    enabled: true,
    config: {
      tools_mode: 'allowlist',
      tools_enabled: toolsAllowlist,
      web_search_enabled: role === 'researcher',
    },
  };
  const created = await daemonRequest('POST', '/api/agents', body);
  const id = created.data?.id || created.id || created.agent?.id;
  console.log(`  agent "${name}" created (id=${id})`);
  return created.data || created;
}

async function ensureGoal(series, kpiId) {
  const unitByMetric = {
    avg_watch_time: 'seconds',
    subscribers_gained: 'count',
    daily_streak: 'days',
    shares: 'count',
    comments: 'count',
    completion_rate: 'percent',
    saves: 'count',
    comment_depth: 'chars',
    inbound_leads: 'count',
    clicks_to_site: 'count',
    qualified_viewers: 'count',
    rewatches: 'count',
    followers_gained: 'count',
  };
  const metricPart = kpiId.replace(/^yt_[^_]+_(7d_)?/, '').replace(/_$/, '');
  const unit = Object.entries(unitByMetric).find(([k]) => metricPart.endsWith(k))?.[1] || 'count';
  const title = kpiId.replace(/^yt_/, '').replace(/_/g, ' ');
  const list = await daemonRequest('GET', '/api/goals').catch(() => ({ data: [] }));
  const existing = asArray(list).find((g) => g.target_metric === kpiId);
  if (existing) {
    console.log(`  goal "${title}" exists (id=${existing.id})`);
    return existing;
  }
  try {
    const created = await daemonRequest('POST', '/api/goals', {
      name: title,
      description: `Tracked automatically by yt-metrics-poller.`,
      target_metric: kpiId,
      target_value: 0,
      current_value: 0,
      unit,
      status: 'active',
      priority: 'normal',
    });
    const id = created.data?.id || created.id || created.goal?.id;
    console.log(`  goal "${title}" created (id=${id})`);
    return created.data || created;
  } catch (e) {
    console.log(`  goal "${title}" could not be created: ${e.message}`);
    return null;
  }
}

async function uploadShowBible(series) {
  const biblePath = path.resolve(`docs/youtube/${series.slug}-showbible.md`);
  if (!fs.existsSync(biblePath)) {
    console.log(`  show bible missing at ${biblePath} — skipping knowledge upload`);
    return null;
  }
  // POST /api/knowledge supports a files[] multipart. To keep the
  // bootstrap script simple, rely on the ingestKnowledgeFile helper
  // re-exported by _ohwow.mjs. (That helper handles the FormData shape.)
  const { ingestKnowledgeFile } = await import('../x-experiments/_ohwow.mjs');
  try {
    const body = fs.readFileSync(biblePath, 'utf8');
    const result = await ingestKnowledgeFile({
      title: `${series.displayName} — Show Bible`,
      filename: `${series.slug}-showbible.md`,
      body,
      replace: true,
    });
    const id = result?.data?.id || result?.id || '?';
    console.log(`  show bible uploaded as knowledge (id=${id})`);
    return result;
  } catch (e) {
    console.log(`  show bible upload failed: ${e.message}`);
    return null;
  }
}

async function bootstrap(slug) {
  const series = getSeries(slug);
  if (!series.enabled) {
    console.log(`[bootstrap] series '${slug}' is disabled — skipping`);
    return;
  }
  console.log(`\n[bootstrap] ${series.displayName} (${slug})`);
  const promptModule = getPromptModule(slug);
  const baseSys = promptModule.systemPrompt.slice(0, 1200);
  await ensureProject(series);
  await ensureAgent(series, 'researcher', baseSys);
  await ensureAgent(series, 'writer', baseSys);
  await ensureAgent(series, 'editor', baseSys);
  for (const kpi of series.goalKpiIds) await ensureGoal(series, kpi);
  await uploadShowBible(series);
}

async function main() {
  if (!ALL && !slugArg) {
    console.error('usage: yt-series-bootstrap.mjs <slug> | --all');
    process.exit(2);
  }
  const targets = ALL ? listSeries({ onlyEnabled: true }).map((s) => s.slug) : [slugArg];
  for (const s of targets) {
    try {
      await bootstrap(s);
    } catch (e) {
      console.error(`[bootstrap] ${s} failed: ${e.message}`);
    }
  }
  console.log('\n[bootstrap] done');
}

main().catch((e) => { console.error(e); process.exit(1); });
