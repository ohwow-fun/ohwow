/**
 * Bench collectors — HTTP probes against a running ohwow daemon.
 *
 * Helpers for snapshotting /api/pulse, /api/approvals, /api/tasks before/after
 * a benchmarked unit, diffing the pulse windows, and polling a task to its
 * terminal state. Intentionally side-effect free: the CLI owns orchestration.
 */

/**
 * @typedef {Object} PulseSnapshot
 * @property {string} timestamp ISO string captured at fetch time.
 * @property {{ calls: number, tokens: number, cost_cents: number }} llm_h24
 *   24h rolling window from pulse.llm.h24.
 * @property {Array<{ model: string, calls: number, tokens: number, cost_cents: number }>} topModels
 *   1h top-models slice (pulse groups by model over a 1h window).
 */

/**
 * @typedef {Object} ApprovalsSnapshot
 * @property {Array<Record<string, unknown>>} rows
 * @property {string} timestamp
 */

/**
 * @typedef {Object} PulseDiff
 * @property {{ prompt: number, completion: number, total: number }} tokens
 *   Pulse only exposes the sum (input+output) per bucket, so prompt/completion
 *   stay 0 and total holds the tokens delta. Field shape is stable for QA to
 *   wire up later once the runtime starts emitting split tokens in pulse.
 * @property {number} cost_cents
 * @property {number} llm_calls
 * @property {string[]} model_used Distinct models observed across before/after
 *   topModels arrays (union). Approximation: pulse.topModels is the 1h top-6
 *   by cost; any model that ran during the bench will show up in `after` if it
 *   falls inside that window. Models outside the top-6 are silently dropped.
 */

/**
 * Fetch /api/pulse and return the bench-relevant subset.
 *
 * @param {number} port
 * @returns {Promise<PulseSnapshot>}
 */
export async function snapshotPulse(port, token) {
  const res = await fetch(`http://localhost:${port}/api/pulse`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    throw new Error(`pulse: HTTP ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  const data = body?.data ?? {};
  const llm = data.llm ?? {};
  const h24 = llm.h24 ?? { calls: 0, tokens: 0, cost_cents: 0 };
  const topModels = Array.isArray(llm.topModels) ? llm.topModels : [];
  return {
    timestamp: new Date().toISOString(),
    llm_h24: {
      calls: Number(h24.calls) || 0,
      tokens: Number(h24.tokens) || 0,
      cost_cents: Number(h24.cost_cents) || 0,
    },
    topModels: topModels.map((m) => ({
      model: String(m.model ?? ''),
      calls: Number(m.calls) || 0,
      tokens: Number(m.tokens) || 0,
      cost_cents: Number(m.cost_cents) || 0,
    })),
  };
}

/**
 * Fetch /api/approvals and return row count + raw rows.
 *
 * @param {number} port
 * @returns {Promise<ApprovalsSnapshot>}
 */
export async function snapshotApprovals(port, token) {
  const res = await fetch(`http://localhost:${port}/api/approvals`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    throw new Error(`approvals: HTTP ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  const rows = Array.isArray(body?.data) ? body.data : [];
  return { rows, timestamp: new Date().toISOString() };
}

/**
 * Fetch /api/tasks filtered by status. Status is required so the caller can
 * pick a bounded slice (`pending`, `in_progress`, `needs_approval`, etc).
 *
 * @param {number} port
 * @param {string} status
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function snapshotTasks(port, status, token) {
  const url = new URL(`http://localhost:${port}/api/tasks`);
  if (status) url.searchParams.set('status', status);
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    throw new Error(`tasks: HTTP ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  return Array.isArray(body?.data) ? body.data : [];
}

/**
 * Diff two pulse snapshots. Numbers clamp at 0 — negative deltas are treated
 * as "no movement we can attribute to the bench" (the 24h window slid past
 * older calls). Models observed is the union of both snapshots' topModels.
 *
 * @param {PulseSnapshot} before
 * @param {PulseSnapshot} after
 * @returns {PulseDiff}
 */
export function diffPulse(before, after) {
  const b = before?.llm_h24 ?? { calls: 0, tokens: 0, cost_cents: 0 };
  const a = after?.llm_h24 ?? { calls: 0, tokens: 0, cost_cents: 0 };
  const calls = Math.max(0, (a.calls ?? 0) - (b.calls ?? 0));
  const tokens = Math.max(0, (a.tokens ?? 0) - (b.tokens ?? 0));
  const cost_cents = Math.max(0, (a.cost_cents ?? 0) - (b.cost_cents ?? 0));
  const modelSet = new Set();
  for (const m of before?.topModels ?? []) if (m?.model) modelSet.add(m.model);
  for (const m of after?.topModels ?? []) if (m?.model) modelSet.add(m.model);
  return {
    tokens: { prompt: 0, completion: 0, total: tokens },
    cost_cents,
    llm_calls: calls,
    model_used: Array.from(modelSet).sort(),
  };
}

/**
 * Poll /api/tasks/:id every `intervalMs` until the task reaches a terminal
 * status (`completed`, `failed`, `needs_approval`, `cancelled`) or the budget
 * runs out. Throws with a descriptive message on timeout so the CLI can
 * surface it without swallowing other errors.
 *
 * @param {number} port
 * @param {string} daemonTaskId
 * @param {{ timeoutMs: number, intervalMs?: number }} opts
 * @returns {Promise<{ status: string, task: Record<string, unknown> }>}
 */
export async function pollTaskUntilTerminal(port, daemonTaskId, opts) {
  const { timeoutMs, intervalMs = 2000, token } = opts;
  const terminal = new Set(['completed', 'failed', 'needs_approval', 'cancelled']);
  const started = Date.now();
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`http://localhost:${port}/api/tasks/${daemonTaskId}`, { headers });
    if (res.ok) {
      const body = await res.json();
      const task = body?.data;
      const status = task?.status;
      if (status && terminal.has(status)) {
        return { status, task };
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `pollTaskUntilTerminal: task ${daemonTaskId} did not reach terminal state within ${timeoutMs}ms`,
  );
}
