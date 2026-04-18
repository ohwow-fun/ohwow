/**
 * Bench unit: research-to-commit.
 *
 * Dispatches a tiny, deterministic coding task — add a JSDoc header to an
 * already-documented file — via POST /api/tasks and returns the daemon's
 * task_id so the CLI can poll it to terminal state. The description is
 * intentionally a near-no-op so the bench measures orchestration overhead
 * (plan → tool calls → commit) with minimal content variance run-to-run.
 */

export const id = 'research-to-commit';
export const label = 'research-to-commit';

/**
 * @typedef {Object} BenchRunCtx
 * @property {number} port
 * @property {string} benchRunId
 * @property {string|null} agentIdOverride
 * @property {{ log: (...args: unknown[]) => void, warn: (...args: unknown[]) => void }} logger
 */

/**
 * @param {BenchRunCtx} ctx
 * @returns {Promise<{ daemonTaskId: string, agentId: string, agentSource: string }>}
 */
export async function run(ctx) {
  const { port, benchRunId, agentIdOverride, logger, token } = ctx;
  const authHeaders = token ? { authorization: `Bearer ${token}` } : {};

  let agentId = agentIdOverride ?? null;
  let agentSource = agentIdOverride ? 'cli-override' : '';

  if (!agentId) {
    const res = await fetch(`http://localhost:${port}/api/agents`, { headers: authHeaders });
    if (!res.ok) {
      throw new Error(
        `research-to-commit: GET /api/agents failed (${res.status}). Pass --agent-id=<id> or seed a coding agent.`,
      );
    }
    const body = await res.json();
    const agents = Array.isArray(body?.data) ? body.data : [];
    if (agents.length === 0) {
      throw new Error(
        'research-to-commit: no agents found. Seed one via the TUI onboarding or `ohwow_create_agent` MCP tool, then rerun.',
      );
    }

    // Prefer coding-class agents. `role` is the primary signal (see agents.ts
    // create path). Fall back to a name/description/tools hint, then first row.
    const codingSignals = ['coding', 'code', 'developer', 'engineer', 'programmer'];
    const matchesCoding = (agent) => {
      const hay = [
        String(agent?.role ?? ''),
        String(agent?.name ?? ''),
        String(agent?.description ?? ''),
      ]
        .join(' ')
        .toLowerCase();
      if (codingSignals.some((s) => hay.includes(s))) return true;
      // `tools_enabled` may live inside a JSON-encoded `config` string.
      const rawConfig = agent?.config;
      let cfg = rawConfig;
      if (typeof rawConfig === 'string') {
        try {
          cfg = JSON.parse(rawConfig);
        } catch {
          cfg = null;
        }
      }
      const tools = Array.isArray(cfg?.tools_enabled) ? cfg.tools_enabled : [];
      return tools.some((t) => typeof t === 'string' && /write|edit|patch|git/i.test(t));
    };

    const coding = agents.find(matchesCoding);
    if (coding) {
      agentId = coding.id;
      agentSource = `filter:coding (role=${coding.role ?? 'n/a'})`;
    } else {
      agentId = agents[0].id;
      agentSource = 'fallback:first-row';
      logger.warn(
        `[bench] No coding-class agent detected; falling back to first agent id=${agentId}. ` +
          `Pass --agent-id=<id> to override.`,
      );
    }
  }

  if (!agentId) {
    throw new Error('research-to-commit: could not resolve an agent id.');
  }

  const body = {
    agent_id: agentId,
    title: '[bench] Add JSDoc header to scripts/bench/lib/collectors.mjs',
    description:
      'Benchmarked unit. Add a 4-line JSDoc header to scripts/bench/lib/collectors.mjs describing its purpose. Keep body unchanged.',
    metadata: {
      bench_run_id: benchRunId,
      bench_task_id: 'research-to-commit',
    },
  };

  const postRes = await fetch(`http://localhost:${port}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    // The POST /api/tasks handler currently reads `agentId` from the JSON
    // body (not `agent_id`) and does not persist `metadata`. Send both
    // keys so the runtime picks up the agent regardless of which spelling
    // it migrates to. The bench_run_id is still recorded in the BenchRun
    // JSON emitted by the CLI, so the daemon dropping `metadata` is fine.
    body: JSON.stringify({ ...body, agentId }),
  });
  if (!postRes.ok) {
    const text = await postRes.text().catch(() => '');
    throw new Error(`POST /api/tasks failed (${postRes.status}): ${text}`);
  }
  const posted = await postRes.json();
  const daemonTaskId = posted?.data?.id;
  if (!daemonTaskId) {
    throw new Error(`POST /api/tasks returned no task id: ${JSON.stringify(posted)}`);
  }

  logger.log(
    `[bench] dispatched task ${daemonTaskId} to agent ${agentId} (${agentSource}).`,
  );
  return { daemonTaskId, agentId, agentSource };
}
