/**
 * Thin client for the local ohwow daemon HTTP API.
 * Resolves the active workspace via ~/.ohwow/current-workspace, reads
 * daemon.token for auth, and exposes the ops these experiments need:
 *
 *   - llm({ purpose, prompt, system, ... })  → /api/llm
 *   - chat({ message, sessionId })           → /api/chat (orchestrator turn)
 *   - ingestKnowledgeFile(filename, body, title)  → /api/knowledge/upload
 *
 * Env overrides:
 *   OHWOW_WORKSPACE  — use this workspace (default: current-workspace pointer)
 *   OHWOW_URL        — full URL override (skips workspace+port resolution)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function activeWorkspace() {
  if (process.env.OHWOW_WORKSPACE) return process.env.OHWOW_WORKSPACE;
  try { return fs.readFileSync(path.join(os.homedir(), '.ohwow', 'current-workspace'), 'utf8').trim() || 'default'; }
  catch { return 'default'; }
}

function workspaceDir(ws) { return path.join(os.homedir(), '.ohwow', 'workspaces', ws); }

function readToken(ws) {
  return fs.readFileSync(path.join(workspaceDir(ws), 'daemon.token'), 'utf8').trim();
}

function readPort(ws) {
  // config layering: workspace workspace.json > global config.json > 7700
  try {
    const wsCfg = JSON.parse(fs.readFileSync(path.join(workspaceDir(ws), 'workspace.json'), 'utf8'));
    if (wsCfg.port) return wsCfg.port;
  } catch {}
  try {
    const g = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ohwow', 'config.json'), 'utf8'));
    if (ws === 'default' && g.port) return g.port;
  } catch {}
  return 7700;
}

export function resolveOhwow() {
  if (process.env.OHWOW_URL && process.env.OHWOW_TOKEN) {
    return { url: process.env.OHWOW_URL, token: process.env.OHWOW_TOKEN, workspace: process.env.OHWOW_WORKSPACE || 'custom' };
  }
  const ws = activeWorkspace();
  const port = readPort(ws);
  return { url: `http://localhost:${port}`, token: readToken(ws), workspace: ws };
}

async function req(method, route, body, asForm) {
  const { url, token } = resolveOhwow();
  const headers = { authorization: `Bearer ${token}` };
  let payload;
  if (asForm) {
    payload = body; // FormData
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url + route, { method, headers, body: payload });
  if (!res.ok) throw new Error(`${method} ${route} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/**
 * Ask ohwow for an LLM completion using the workspace's model policy.
 * valid purposes: orchestrator_chat, agent_task, planning, browser_automation,
 *   memory_extraction, ocr, workflow_step, simple_classification, desktop_control,
 *   reasoning, generation, summarization, extraction, critique, translation, embedding
 */
export async function llm({
  purpose = 'generation',
  prompt,
  system,
  agentId,
  constraints,
  prefer_model,
  difficulty,
}) {
  const full = system ? `${system}\n\n${prompt}` : prompt;
  // prefer_model + difficulty are flat fields on /api/llm's runLlmCall input
  // (see src/execution/llm-organ.ts). Pass them through so callers can pin a
  // specific tier when a purpose-level route is too weak.
  const r = await req('POST', '/api/llm', {
    purpose, prompt: full, agentId, constraints, prefer_model, difficulty,
  });
  return r.data;
}

export async function chat({ message, sessionId, personaAgentId, model }) {
  return (await req('POST', '/api/chat', { message, sessionId, personaAgentId, model })).data;
}

/**
 * Upload an in-memory buffer as a knowledge document. ext should start
 * with a dot (.md, .txt, .pdf). Uses multipart/form-data via Node's
 * built-in FormData/Blob (Node 20+).
 *
 * If `replace` is true, first soft-delete any existing doc in the
 * workspace with the same `title`. Makes re-runs idempotent (one doc
 * per filename per workspace per day).
 */
export async function ingestKnowledgeFile({ title, filename, body, replace = false }) {
  if (replace) {
    try {
      const list = (await req('GET', '/api/knowledge')).data || [];
      const existing = list.filter(d => d.title === title);
      for (const d of existing) {
        try { await req('DELETE', `/api/knowledge/${d.id}`); } catch {}
      }
    } catch { /* non-fatal */ }
  }
  const form = new FormData();
  const buf = typeof body === 'string' ? body : body;
  form.append('title', title);
  form.append('file', new Blob([buf], { type: 'text/markdown' }), filename);
  return (await req('POST', '/api/knowledge/upload', form, true)).data;
}

export function extractJson(text) {
  const raw = String(text || '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in: ${raw.slice(0, 200)}`);
  try { return JSON.parse(m[0]); } catch (e) {
    // LLMs routinely emit raw newlines / tabs inside JSON string values.
    // Walk the candidate, track whether we're inside a "..." string, and
    // escape any raw control chars we encounter there. Leaves valid JSON
    // alone; salvages the common failure mode without needing a full parser.
    const s = m[0];
    let out = '';
    let inStr = false, esc = false;
    for (const ch of s) {
      if (inStr) {
        if (esc) { out += ch; esc = false; continue; }
        if (ch === '\\') { out += ch; esc = true; continue; }
        if (ch === '"') { out += ch; inStr = false; continue; }
        if (ch === '\n') { out += '\\n'; continue; }
        if (ch === '\r') { out += '\\r'; continue; }
        if (ch === '\t') { out += '\\t'; continue; }
        if (ch.charCodeAt(0) < 0x20) { out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'); continue; }
        out += ch;
      } else {
        if (ch === '"') inStr = true;
        out += ch;
      }
    }
    return JSON.parse(out);
  }
}
