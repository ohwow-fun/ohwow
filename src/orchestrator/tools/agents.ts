/**
 * Agent orchestrator tools: list_agents, update_agent_status, run_agent, spawn_agents
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';

export async function listAgents(ctx: LocalToolContext): Promise<ToolResult> {
  const { data: agents, error } = await ctx.db
    .from('agent_workforce_agents')
    .select('id, name, role, paused, status')
    .eq('workspace_id', ctx.workspaceId)
    .order('name');

  if (error) return { success: false, error: error.message };

  // Get schedules
  const agentIds = ((agents || []) as Array<{ id: string }>).map((a) => a.id);
  const scheduleMap: Record<string, { cron: string; lastRunAt: string | null }[]> = {};
  if (agentIds.length > 0) {
    const { data: schedules } = await ctx.db
      .from('agent_workforce_schedules')
      .select('agent_id, cron, last_run_at, enabled')
      .in('agent_id', agentIds)
      .eq('enabled', 1);
    if (schedules) {
      for (const s of schedules as Array<{ agent_id: string; cron: string; last_run_at: string | null }>) {
        if (s.agent_id) {
          if (!scheduleMap[s.agent_id]) scheduleMap[s.agent_id] = [];
          scheduleMap[s.agent_id].push({ cron: s.cron, lastRunAt: s.last_run_at });
        }
      }
    }
  }

  const result = ((agents || []) as Array<{ id: string; name: string; role: string; paused: number | boolean; status: string }>).map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    paused: !!a.paused,
    status: a.paused ? 'paused' : a.status,
    schedules: scheduleMap[a.id] || [],
  }));

  return { success: true, data: result };
}

export async function updateAgentStatus(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const agentId = input.agent_id as string;
  const action = input.action as string | undefined;
  // Support both new { action: 'pause'|'resume' } and legacy { status: 'paused'|'idle' }
  const legacyStatus = input.status as string | undefined;
  const shouldPause = action === 'pause' || legacyStatus === 'paused';
  const shouldResume = action === 'resume' || legacyStatus === 'idle';

  if (!agentId) return { success: false, error: 'agent_id is required' };
  if (!shouldPause && !shouldResume) {
    return { success: false, error: 'action must be "pause" or "resume"' };
  }

  const { data: agent } = await ctx.db
    .from('agent_workforce_agents')
    .select('id, name, paused, status, workspace_id')
    .eq('id', agentId)
    .single();

  if (!agent) return { success: false, error: 'Agent not found' };
  const a = agent as { id: string; name: string; paused: number | boolean; status: string; workspace_id: string };
  if (a.workspace_id !== ctx.workspaceId) return { success: false, error: 'Agent not in your workspace' };
  if (shouldPause && a.status === 'working') {
    return { success: false, error: `Agent "${a.name}" is currently working. Wait for it to finish.` };
  }

  await ctx.db.from('agent_workforce_agents').update({ paused: shouldPause ? 1 : 0 }).eq('id', agentId);

  const actionLabel = shouldPause ? 'paused' : 'resumed';
  return { success: true, data: { message: `Agent "${a.name}" has been ${actionLabel}.` } };
}

export async function runAgent(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const agentId = input.agent_id as string;
  const prompt = input.prompt as string;
  const projectId = input.project_id as string | undefined;
  if (!agentId || !prompt) return { success: false, error: 'agent_id and prompt are required' };

  // Verify agent exists
  const { data: agent } = await ctx.db
    .from('agent_workforce_agents')
    .select('id, name, workspace_id, config')
    .eq('id', agentId)
    .single();

  if (!agent) return { success: false, error: 'Agent not found' };
  const a = agent as { id: string; name: string; workspace_id: string; config: string | Record<string, unknown> };
  if (a.workspace_id !== ctx.workspaceId) return { success: false, error: 'Agent not in your workspace' };

  // Check if agent already has an active task (prevent duplicate runs across turns)
  const { data: existingTask } = await ctx.db
    .from('agent_workforce_tasks')
    .select('id, status, title, created_at')
    .eq('workspace_id', ctx.workspaceId)
    .eq('agent_id', agentId)
    .in('status', ['pending', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingTask) {
    const t = existingTask as { id: string; status: string; title: string; created_at: string };
    return {
      success: true,
      data: {
        message: `${a.name} already has a ${t.status} task: "${t.title}" (ID: ${t.id}). Use get_task_detail to check its progress instead of running a new one.`,
        taskId: t.id,
        alreadyRunning: true,
      },
    };
  }

  const agentConfig = typeof a.config === 'string' ? JSON.parse(a.config) : a.config;

  // Enrich prompt with matched SOP if available
  let enrichedPrompt = prompt;
  try {
    const { extractKeywords, matchesTriggers } = await import('../../lib/token-similarity.js');
    const { data: procedureSkills } = await ctx.db.from('agent_workforce_skills')
      .select('name, definition, triggers')
      .eq('workspace_id', ctx.workspaceId)
      .eq('is_active', 1)
      .eq('skill_type', 'procedure')
      .limit(10);

    if (procedureSkills) {
      const keywords = extractKeywords(prompt);
      for (const skill of procedureSkills as Array<Record<string, unknown>>) {
        const triggers: string[] = (() => { try { return JSON.parse((skill.triggers as string) || '[]'); } catch { return []; } })();
        if (keywords.length > 0 && matchesTriggers(triggers, keywords)) {
          const def = typeof skill.definition === 'string' ? JSON.parse(skill.definition as string) : skill.definition;
          if (def?.tool_sequence) {
            const steps = (def.tool_sequence as Array<string | { tool: string }>).map((s: string | { tool: string }, i: number) =>
              `${i + 1}. ${typeof s === 'string' ? s : s.tool}`).join(', ');
            enrichedPrompt += `\n\nPROCEDURE: "${skill.name}" — Steps: ${steps}`;
          }
          break;
        }
      }
    }
  } catch { /* non-critical: SOP enrichment failed */ }

  // Create task
  const insertPayload: Record<string, unknown> = {
    workspace_id: ctx.workspaceId,
    agent_id: agentId,
    title: enrichedPrompt.slice(0, 100),
    input: enrichedPrompt,
    status: 'pending',
    requires_approval: agentConfig.approval_required ? 1 : 0,
  };
  if (projectId) insertPayload.project_id = projectId;

  const { data: task } = await ctx.db
    .from('agent_workforce_tasks')
    .insert(insertPayload)
    .select('id')
    .single();

  if (!task) return { success: false, error: "Couldn't create task" };
  const taskId = (task as { id: string }).id;

  // Execute and wait for result (with timeout)
  const TASK_TIMEOUT_MS = 120_000; // 2 minutes
  let result: Awaited<ReturnType<typeof ctx.engine.executeTask>>;
  try {
    result = await Promise.race([
      ctx.engine.executeTask(agentId, taskId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), TASK_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === 'timeout';
    return {
      success: true,
      data: {
        message: isTimeout
          ? `${a.name} is still working on the task (ID: ${taskId}). Use get_task_detail to check progress.`
          : `${a.name} encountered an error: ${err instanceof Error ? err.message : 'unknown'}`,
        taskId,
        ...(isTimeout ? { pending: true } : {}),
      },
    };
  }

  // Return real result
  const output = typeof result.output === 'string'
    ? result.output.slice(0, 2000)
    : 'Task completed with no output.';
  return {
    success: true,
    data: {
      message: `${a.name} completed the task.`,
      taskId,
      status: result.status,
      output,
    },
  };
}

/**
 * Wait for spawned agent tasks to complete and aggregate their results.
 * Bridges the gap between fire-and-forget (spawn_agents) and blocking (run_agent).
 */
export async function awaitAgentResults(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const taskIds = input.task_ids as string[];
  const timeoutSeconds = (input.timeout_seconds as number) || 120;

  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return { success: false, error: 'task_ids array is required with at least one entry' };
  }

  if (taskIds.length > 10) {
    return { success: false, error: 'Maximum 10 task IDs can be awaited at once' };
  }

  const deadline = Date.now() + timeoutSeconds * 1000;
  const POLL_INTERVAL_MS = 2000;
  const completedResults: Array<{
    taskId: string;
    agentName: string;
    status: string;
    output: string;
  }> = [];
  const stillRunning: string[] = [];

  // Poll until all tasks complete or timeout
  const remaining = new Set(taskIds);
  while (remaining.size > 0 && Date.now() < deadline) {
    const ids = Array.from(remaining);
    const { data: tasks } = await ctx.db
      .from('agent_workforce_tasks')
      .select('id, status, output, error, agent_id, title')
      .in('id', ids)
      .eq('workspace_id', ctx.workspaceId);

    if (tasks) {
      for (const row of tasks as Array<{
        id: string;
        status: string;
        output: string | null;
        error: string | null;
        agent_id: string;
        title: string;
      }>) {
        if (['completed', 'failed', 'cancelled', 'needs_approval'].includes(row.status)) {
          // Fetch agent name
          let agentName = row.agent_id;
          const { data: agent } = await ctx.db
            .from('agent_workforce_agents')
            .select('name')
            .eq('id', row.agent_id)
            .single();
          if (agent) {
            agentName = (agent as { name: string }).name;
          }

          const output = row.status === 'failed'
            ? (row.error || 'Task failed with no error details')
            : (row.output ? String(row.output).slice(0, 1500) : 'Completed with no output');

          completedResults.push({
            taskId: row.id,
            agentName,
            status: row.status,
            output,
          });
          remaining.delete(row.id);
        }
      }
    }

    if (remaining.size > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  // Anything still remaining is timed out
  for (const id of remaining) {
    stillRunning.push(id);
  }

  const timedOut = stillRunning.length > 0;
  const summary = completedResults
    .map(r => `**${r.agentName}** (${r.status}): ${r.output}`)
    .join('\n\n---\n\n');

  return {
    success: true,
    data: {
      completed: completedResults.length,
      timedOut: stillRunning.length,
      results: completedResults,
      ...(timedOut ? { stillRunning, hint: 'Some tasks are still running. Use get_task_detail to check their progress.' } : {}),
      summary: summary || 'No tasks completed within the timeout.',
    },
  };
}

/**
 * Spawn multiple agents in parallel (fire-and-forget).
 * Returns immediately with task IDs; agents execute in background.
 */
export async function spawnAgents(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const agents = input.agents as Array<{ agent_id: string; prompt: string; project_id?: string }>;
  if (!Array.isArray(agents) || agents.length === 0) {
    return { success: false, error: 'agents array is required with at least one entry' };
  }

  if (agents.length > 5) {
    return { success: false, error: 'Maximum 5 agents can be spawned at once' };
  }

  const spawned: Array<{ agentId: string; agentName: string; taskId: string; status: string }> = [];
  const errors: string[] = [];

  for (const entry of agents) {
    const { agent_id: agentId, prompt, project_id: projectId } = entry;
    if (!agentId || !prompt) {
      errors.push(`Missing agent_id or prompt for entry`);
      continue;
    }

    // Verify agent exists
    const { data: agent } = await ctx.db
      .from('agent_workforce_agents')
      .select('id, name, workspace_id, config')
      .eq('id', agentId)
      .single();

    if (!agent) {
      errors.push(`Agent ${agentId} not found`);
      continue;
    }
    const a = agent as { id: string; name: string; workspace_id: string; config: string | Record<string, unknown> };
    if (a.workspace_id !== ctx.workspaceId) {
      errors.push(`Agent ${a.name} not in your workspace`);
      continue;
    }

    const agentConfig = typeof a.config === 'string' ? JSON.parse(a.config) : a.config;

    // Create task
    const insertPayload: Record<string, unknown> = {
      workspace_id: ctx.workspaceId,
      agent_id: agentId,
      title: prompt.slice(0, 100),
      input: prompt,
      status: 'pending',
      requires_approval: agentConfig.approval_required ? 1 : 0,
    };
    if (projectId) insertPayload.project_id = projectId;

    const { data: task } = await ctx.db
      .from('agent_workforce_tasks')
      .insert(insertPayload)
      .select('id')
      .single();

    if (!task) {
      errors.push(`Couldn't create task for ${a.name}`);
      continue;
    }
    const taskId = (task as { id: string }).id;

    // Fire-and-forget: launch execution without awaiting
    ctx.engine.executeTask(agentId, taskId).catch(() => {
      // Errors are recorded on the task row by the engine
    });

    spawned.push({ agentId, agentName: a.name, taskId, status: 'spawned' });
  }

  if (spawned.length === 0) {
    return { success: false, error: `Couldn't spawn any agents: ${errors.join('; ')}` };
  }

  return {
    success: true,
    data: {
      message: `Spawned ${spawned.length} agent${spawned.length !== 1 ? 's' : ''} in background.${errors.length > 0 ? ` Warnings: ${errors.join('; ')}` : ''}`,
      spawned,
      hint: 'Use list_tasks with status "running" or get_task_detail with each taskId to check progress.',
    },
  };
}
