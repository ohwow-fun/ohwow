/**
 * Researcher-agent fallback — when a series' primary seed source (x-intel,
 * knowledge, archive) returns null, per-series adapters can call this to
 * dispatch a research task to the series' researcher agent.
 *
 * The researcher agent has real tools (scrape_search, scrape_url,
 * search_knowledge) — unlike a bare llm() call — so it can actually go
 * find today's story on the web when x-intel is dry.
 *
 * Flow:
 *   1. Resolve agent id by name via GET /api/agents.
 *   2. POST /api/tasks {agentId, title, description} — daemon starts
 *      execution asynchronously.
 *   3. Poll GET /api/tasks/:id every 2s up to timeoutMs.
 *   4. On completed, pull the output and extractJson to get the
 *      structured payload.
 *   5. Shape into a SeriesSeed and return.
 *
 * Returns null on: agent not found, task timeout, task failure, output
 * not parseable as JSON, output missing required fields. Callers should
 * treat null as "no fresh seed today, skip the episode" — same semantics
 * as an empty primary source.
 */
import { resolveOhwow } from "../../x-experiments/_ohwow.mjs";
import { extractJson } from "../../x-experiments/_ohwow.mjs";

import crypto from "node:crypto";

const POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes — researcher with scrape_* is slow

async function request(method, route, body) {
  const { url, token } = resolveOhwow();
  const headers = { authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(url + route, { method, headers, body: payload });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${method} ${route} ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

async function findAgentId(agentName) {
  const list = await request("GET", "/api/agents");
  const agents = list.data || list || [];
  const match = agents.find((a) => a.name === agentName);
  return match ? match.id : null;
}

async function dispatchTask(agentId, title, description) {
  const resp = await request("POST", "/api/tasks", { agentId, title, description });
  const data = resp.data || resp;
  return data.id;
}

async function getTask(taskId) {
  const resp = await request("GET", `/api/tasks/${taskId}`);
  return resp.data || resp;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shape a researcher JSON payload into a SeriesSeed. Required fields:
 * actor, artifact, summary. Citations array is optional but preferred.
 *
 * Returns null if the JSON is missing the required fields — we'd rather
 * skip than produce a vague Briefing.
 */
function shapeSeed(payload, { seriesSlug, taskId }) {
  if (!payload || typeof payload !== "object") return null;
  const { actor, artifact, summary, citations } = payload;
  if (!actor || !artifact || !summary) return null;

  const citationArr = Array.isArray(citations) ? citations.slice(0, 5) : [];

  return {
    kind: "external-url",
    title: `${actor}: ${artifact}`,
    body: [
      `HEADLINE: ${actor} — ${artifact}`,
      "",
      `SUMMARY: ${summary}`,
      citationArr.length ? "\nCITATIONS:" : "",
      ...citationArr.map((c) => {
        const u = typeof c === "string" ? c : c.url || "";
        const t = typeof c === "string" ? "" : (c.text || c.title || "");
        return `- ${u}${t ? `: ${t}` : ""}`;
      }),
    ].filter(Boolean).join("\n"),
    citations: citationArr.map((c) => {
      if (typeof c === "string") return { url: c };
      return { url: c.url, text: c.text || c.title };
    }),
    metadata: {
      source: "researcher-agent-fallback",
      series: seriesSlug,
      research_task_id: taskId,
      fetched_at: new Date().toISOString(),
    },
  };
}

/**
 * Dispatch a research task to the named agent and poll until it
 * completes (or times out). Returns a SeriesSeed on success, null otherwise.
 *
 * @param {{agentName: string, researchPrompt: string, seriesSlug: string,
 *          timeoutMs?: number, pollIntervalMs?: number}} opts
 */
export async function researchViaAgent({
  agentName,
  researchPrompt,
  seriesSlug,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
}) {
  const agentId = await findAgentId(agentName);
  if (!agentId) {
    console.log(`[researcher-fallback] agent '${agentName}' not found — skipping`);
    return null;
  }

  const description =
    "Return a single JSON object and stop. No prose, no questions, no 'would you like me to...'. " +
    "Use scrape_search + scrape_url to verify every fact. If you can't find a qualifying story, " +
    'return exactly {"actor": null} — nothing else. Never fabricate URLs, pricing, or dates.';

  let taskId;
  try {
    taskId = await dispatchTask(agentId, researchPrompt, description);
  } catch (e) {
    console.log(`[researcher-fallback] dispatch failed: ${e.message}`);
    return null;
  }

  console.log(`[researcher-fallback] dispatched task ${taskId.slice(0, 8)} to ${agentName}`);

  const deadline = Date.now() + timeoutMs;
  let lastStatus = "pending";

  // needs_approval is reached when the agent's final response was
  // conversational or flagged as a non-informational action. We don't have
  // a human to approve, so treat needs_approval as a terminal state —
  // parse the output if it's present, otherwise skip the episode.
  const TERMINAL_STATES = new Set(["completed", "failed", "needs_approval", "cancelled"]);

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    let task;
    try {
      task = await getTask(taskId);
    } catch (e) {
      console.log(`[researcher-fallback] poll error: ${e.message}`);
      continue; // transient — keep polling until deadline
    }
    if (task.status !== lastStatus) {
      console.log(`[researcher-fallback] task ${taskId.slice(0, 8)} → ${task.status}`);
      lastStatus = task.status;
    }
    if (!TERMINAL_STATES.has(task.status)) continue;

    if (task.status === "failed") {
      console.log(`[researcher-fallback] task failed: ${task.error_message || "unknown"}`);
      return null;
    }
    if (task.status === "cancelled") {
      console.log(`[researcher-fallback] task cancelled`);
      return null;
    }

    // completed OR needs_approval — try to parse whatever output we have.
    const raw = task.output || "";
    if (!raw) {
      console.log(`[researcher-fallback] ${task.status} with empty output — skipping`);
      return null;
    }
    let parsed;
    try {
      // Agents sometimes emit multiple JSON blocks when they self-correct.
      // Prefer the last parseable one — that's the researcher's final answer.
      parsed = extractLastJson(raw);
    } catch (e) {
      console.log(`[researcher-fallback] output not JSON: ${e.message}`);
      return null;
    }
    if (!parsed || parsed.actor === null || parsed.actor === undefined) {
      console.log(`[researcher-fallback] researcher reported no qualifying story`);
      return null;
    }
    const seed = shapeSeed(parsed, { seriesSlug, taskId });
    if (!seed) {
      console.log(`[researcher-fallback] payload missing required fields (actor/artifact/summary)`);
    }
    return seed;
  }

  console.log(`[researcher-fallback] task ${taskId.slice(0, 8)} timed out after ${timeoutMs}ms`);
  return null;
}

/**
 * Extract the LAST JSON object from a string. Agents sometimes write a
 * first-pass JSON, spot a mistake, then emit a corrected JSON — so the
 * last one is the one to trust.
 *
 * We look for fenced ```json blocks first (most common), then fall back
 * to naive brace matching for inline JSON.
 */
function extractLastJson(raw) {
  // Try fenced ```json ... ``` blocks.
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1].trim());
  if (fenced.length) {
    // Parse each, keep the last valid one.
    for (let i = fenced.length - 1; i >= 0; i--) {
      try { return JSON.parse(fenced[i]); } catch { /* try next */ }
    }
  }
  // Try extractJson on just the last 1000 chars (usually the final answer).
  try { return extractJson(raw.slice(-1500)); } catch {}
  // Fall back to the first successful parse of the whole text.
  return extractJson(raw);
}

/**
 * researchViaOrchestrator — preferred fallback path. Bypasses the per-
 * series agent task system and calls the orchestrator chat directly
 * with an explicit instruction to use the `deep_research` tool (which
 * is enabled on the orchestrator by default and does multi-query web
 * search + scrape + synthesis in one call).
 *
 * Why prefer this over researchViaAgent: when we exercised the agent
 * path, the model (Qwen 3.5 35B-A3B on the agent runtime) chose to
 * short-circuit and return {actor: null} without ever invoking a tool.
 * The orchestrator is driven by the workspace's default chat model
 * (DeepSeek V3.2) with direct tool access and a different loop that
 * enforces tool use when the prompt demands research.
 *
 * Flow:
 *   1. POST /api/chat?async=1 → 202 with conversationId.
 *   2. Poll GET /api/chat/:conversationId every 3s until status != 'running'.
 *   3. Read the last assistant message; extract the last JSON block.
 *   4. Shape into a SeriesSeed.
 */
export async function researchViaOrchestrator({
  researchPrompt,
  seriesSlug,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = 3_000,
}) {
  // Rigid two-step instruction. Without the turn-budget guard the
  // orchestrator (observed live) runs deep_research 3x + scrape_url 44x
  // and never emits a final text response.
  const message = [
    `You are executing a RIGID two-turn protocol. Tool-call budget: exactly ONE deep_research call, then STOP calling tools.`,
    ``,
    `Turn 1: Call the deep_research tool EXACTLY ONCE with depth="thorough" and the research question below. Do NOT call any other tool. Do NOT call deep_research again. Do NOT call scrape_search or scrape_url after deep_research returns.`,
    ``,
    `Turn 2: After the deep_research tool returns its report, emit a single JSON object as your final response — nothing else. No prose. No "let me verify". No additional tool calls. If the report does not contain a qualifying story (named actor, specific artifact, 48h freshness, citable URLs), your JSON is {"actor": null}.`,
    ``,
    `Violations of this protocol (more than one tool call, calling scrape_search or scrape_url, emitting prose instead of JSON, emitting multiple JSON blocks) result in a failed task.`,
    ``,
    `RESEARCH QUESTION FOR deep_research:`,
    researchPrompt,
  ].join("\n");

  const conversationId = crypto.randomUUID();
  let dispatch;
  try {
    dispatch = await request("POST", "/api/chat?async=1", { message, sessionId: conversationId });
  } catch (e) {
    console.log(`[researcher-fallback] async dispatch failed: ${e.message}`);
    return null;
  }
  const convId = dispatch.conversationId || conversationId;
  console.log(`[researcher-fallback] orchestrator conv ${convId.slice(0, 8)} dispatched`);

  const deadline = Date.now() + timeoutMs;
  let lastStatus = "running";
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    let conv;
    try {
      conv = await request("GET", `/api/chat/${convId}`);
    } catch (e) {
      console.log(`[researcher-fallback] poll error: ${e.message}`);
      continue;
    }
    if (conv.status !== lastStatus) {
      console.log(`[researcher-fallback] conv ${convId.slice(0, 8)} → ${conv.status}`);
      lastStatus = conv.status;
    }
    if (conv.status === "running") continue;
    if (conv.status === "failed" || conv.status === "error") {
      console.log(`[researcher-fallback] orchestrator failed: ${conv.last_error || "unknown"}`);
      return null;
    }
    // Pull the last assistant message. orchestrator_messages stores
    // condensed chat turns; orchestrator_chat_sessions stores the full
    // tool-use trace. Prefer the first; fall back to the second when
    // the orchestrator hit its turn budget and never emitted text.
    const messages = conv.messages || [];
    const assistant = [...messages].reverse().find((m) => m.role === "assistant");
    let raw = "";
    if (assistant && assistant.content) {
      raw = normalizeMessageContent(assistant.content);
    }
    if (!raw) {
      console.log(`[researcher-fallback] no condensed assistant msg — pulling last text from full trace`);
      raw = (await pullLastTextFromFullTrace(convId)) || "";
    }
    if (!raw) {
      console.log(`[researcher-fallback] orchestrator finished but emitted no text (likely ran out of turns mid-tool)`);
      return null;
    }

    // Reject research that leaned entirely on the local knowledge base —
    // we want external news, not a summary of our own product docs.
    const researchStats = await pullDeepResearchStats(convId);
    if (researchStats && researchStats.sourceCount === 0 && researchStats.localSourceCount > 0) {
      console.log(`[researcher-fallback] research returned 0 web sources, ${researchStats.localSourceCount} local — rejecting (not fresh news)`);
      return null;
    }
    if (researchStats) {
      console.log(`[researcher-fallback] research: web=${researchStats.sourceCount} local=${researchStats.localSourceCount} queries=${researchStats.queryCount}`);
    }
    let parsed;
    try {
      parsed = extractLastJson(raw);
    } catch (e) {
      console.log(`[researcher-fallback] orchestrator output not JSON: ${e.message}`);
      console.log(`  output (first 500): ${raw.slice(0, 500)}`);
      return null;
    }
    if (!parsed || parsed.actor === null || parsed.actor === undefined) {
      console.log(`[researcher-fallback] no qualifying story`);
      return null;
    }
    const seed = shapeSeed(parsed, { seriesSlug, taskId: convId });
    if (!seed) {
      console.log(`[researcher-fallback] payload missing required fields`);
    }
    return seed;
  }

  console.log(`[researcher-fallback] orchestrator conv ${convId.slice(0, 8)} timed out`);
  return null;
}

/**
 * Normalize the `content` field on an orchestrator message. It can be:
 *   - a plain string (condensed response)
 *   - an array of {type, text|tool_use|tool_result} items (anthropic-style)
 *   - a JSON-stringified array (SSE-fallback shape)
 * Returns the concatenated text content, or an empty string.
 */
function normalizeMessageContent(content) {
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        return normalizeMessageContent(parsed);
      } catch { /* fall through — treat as plain string */ }
    }
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && (c.type === "text" || c.type === undefined) && (c.text || typeof c === "string"))
      .map((c) => (typeof c === "string" ? c : c.text || ""))
      .join("\n");
  }
  if (content && typeof content === "object" && content.text) return content.text;
  return "";
}

/**
 * Recover the last text content from orchestrator_chat_sessions.messages
 * (the full tool-use trace). Used when orchestrator_messages has no
 * condensed assistant response — usually because the orchestrator hit
 * its turn budget before producing a final text answer.
 *
 * This reads the workspace sqlite DB directly because there's no public
 * API that exposes the full trace.
 */
async function pullLastTextFromFullTrace(conversationId) {
  try {
    // Dynamic import so the main code path doesn't pay the cost when not used.
    const { default: Database } = await import("better-sqlite3");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { workspace } = resolveOhwow();
    const dbPath = path.join(os.homedir(), ".ohwow", "workspaces", workspace, "runtime.db");
    if (!fs.existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(
      "SELECT messages FROM orchestrator_chat_sessions WHERE id = ?",
    ).get(conversationId);
    db.close();
    if (!row?.messages) return null;
    const msgs = JSON.parse(row.messages);
    // Walk backwards, return the last text content from an assistant turn.
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "assistant") continue;
      if (typeof m.content === "string" && m.content.trim()) return m.content;
      if (Array.isArray(m.content)) {
        for (let j = m.content.length - 1; j >= 0; j--) {
          const item = m.content[j];
          if (item?.type === "text" && item.text) return item.text;
        }
      }
    }
    return null;
  } catch (e) {
    console.log(`[researcher-fallback] trace recovery failed: ${e.message}`);
    return null;
  }
}

/**
 * Pull the deep_research tool_result's stats (sourceCount,
 * localSourceCount, queryCount) from the conversation's full trace.
 * Returns null if no deep_research tool was called.
 */
async function pullDeepResearchStats(conversationId) {
  try {
    const { default: Database } = await import("better-sqlite3");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { workspace } = resolveOhwow();
    const dbPath = path.join(os.homedir(), ".ohwow", "workspaces", workspace, "runtime.db");
    if (!fs.existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(
      "SELECT messages FROM orchestrator_chat_sessions WHERE id = ?",
    ).get(conversationId);
    db.close();
    if (!row?.messages) return null;
    const msgs = JSON.parse(row.messages);
    // Walk backwards for the last deep_research tool_result.
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "user") continue;
      if (!Array.isArray(m.content)) continue;
      for (const item of m.content) {
        if (item?.type !== "tool_result") continue;
        let content = item.content;
        if (Array.isArray(content)) {
          content = content.map((x) => (typeof x === "string" ? x : x?.text || "")).join("");
        }
        if (typeof content !== "string") continue;
        try {
          const parsed = JSON.parse(content);
          if (parsed && typeof parsed.queryCount === "number") {
            return {
              sourceCount: parsed.sourceCount ?? 0,
              localSourceCount: parsed.localSourceCount ?? 0,
              queryCount: parsed.queryCount ?? 0,
            };
          }
        } catch { /* not a deep_research result — skip */ }
      }
    }
    return null;
  } catch (e) {
    console.log(`[researcher-fallback] stats recovery failed: ${e.message}`);
    return null;
  }
}

// Exported only for unit testing the shape mapping without running a real task.
export const __testing = { shapeSeed };
