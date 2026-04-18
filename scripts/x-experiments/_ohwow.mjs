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

/**
 * Classify an error thrown by Node's native fetch as a connection-level
 * failure worth retrying. We specifically retry when the daemon is
 * literally not answering — ECONNREFUSED (daemon dead / rebinding after
 * a restart), ECONNRESET (socket torn down mid-request by the bouncing
 * daemon), and the generic "fetch failed" TypeError Node wraps these in.
 * Native fetch exposes the real errno on `cause` (undici's UND_ERR_*
 * or the raw syscall error). We do NOT retry HTTP 5xx responses — those
 * are semantic failures, not plumbing outages — and we do NOT retry
 * AbortError/timeout unless its underlying cause is a connection refusal.
 */
function isConnectionRefused(err) {
  if (!err) return false;
  const codes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
  const walk = (e, depth = 0) => {
    if (!e || depth > 5) return false;
    if (typeof e.code === 'string' && codes.has(e.code)) return true;
    if (typeof e.errno === 'string' && codes.has(e.errno)) return true;
    // Node's native fetch wraps network errors as TypeError('fetch failed')
    // with the real syscall error on .cause. Descend.
    if (e.cause) return walk(e.cause, depth + 1);
    return false;
  };
  if (walk(err)) return true;
  // Abort/timeout paths carry a named error without a code — only retry
  // when the cause chain confirms it was really a refusal underneath.
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return false;
  // Last-ditch: the message sometimes is the only surface (older Node
  // builds). Match "ECONNREFUSED" / "ECONNRESET" substrings literally.
  const msg = String(err?.message || '');
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND/.test(msg);
}

/**
 * Retry policy for daemon HTTP calls made from standalone scripts.
 * Default: up to 5 attempts, 500ms base delay, 2x multiplicative backoff,
 * capped at 8s per sleep, ~30s total budget — wide enough to survive a
 * full `ohwow restart` (stop → pid wait → daemon boot → port rebind,
 * routinely 3-8s in local observation, up to ~15s under load). Narrower
 * would drop runs during a normal restart; much wider and the parent
 * automation's 1800s shell_script timeout starts to feel the tail.
 */
const DEFAULT_RETRY = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  multiplier: 2,
  totalBudgetMs: 30_000,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Drop-in replacement for `fetch()` that retries on connection-level
 * failures with bounded backoff. Takes the same arguments as fetch.
 *
 * - Only retries when the error is a connection refusal / reset (the
 *   daemon is bouncing). HTTP error responses (5xx) are returned as-is
 *   for the caller's normal `res.ok` handling.
 * - Logs each retry attempt to stderr so the operator sees the bounce
 *   survive live. Standalone scripts don't have access to the pino
 *   logger; stderr is the right floor.
 * - Respects the caller's AbortSignal on `init`. Aborts skip retry.
 *
 * Exported so sibling scripts that bypass `req()` (x-authors-to-crm,
 * approval-queue, dm-to-code — all of which hit /api/contacts + /api/x
 * directly) can harden their calls uniformly.
 */
export async function daemonFetch(url, init, retry = DEFAULT_RETRY) {
  const cfg = { ...DEFAULT_RETRY, ...retry };
  const startedAt = Date.now();
  let attempt = 0;
  let delay = cfg.baseDelayMs;
  let lastErr;
  while (attempt < cfg.maxAttempts) {
    attempt++;
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (init?.signal?.aborted) throw err;
      if (!isConnectionRefused(err)) throw err;
      const elapsed = Date.now() - startedAt;
      if (attempt >= cfg.maxAttempts || elapsed + delay > cfg.totalBudgetMs) {
        process.stderr.write(`[daemonFetch] giving up after attempt ${attempt} (${elapsed}ms) ${url}: ${err?.cause?.code || err?.code || err?.message}\n`);
        throw err;
      }
      process.stderr.write(`[daemonFetch] retry ${attempt}/${cfg.maxAttempts} in ${delay}ms ${url}: ${err?.cause?.code || err?.code || err?.message}\n`);
      await sleep(delay);
      delay = Math.min(delay * cfg.multiplier, cfg.maxDelayMs);
    }
  }
  throw lastErr;
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
  const res = await daemonFetch(url + route, { method, headers, body: payload });
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
  max_tokens,
}) {
  const full = system ? `${system}\n\n${prompt}` : prompt;
  // prefer_model / difficulty / max_tokens are flat fields on /api/llm's
  // runLlmCall input (see src/execution/llm-organ.ts). Pass them through so
  // callers can pin a specific tier and allow for a longer completion when the
  // purpose-level defaults aren't enough.
  const r = await req('POST', '/api/llm', {
    purpose, prompt: full, agentId, constraints, prefer_model, difficulty, max_tokens,
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
