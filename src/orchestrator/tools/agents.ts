/**
 * Agent orchestrator tools: list_agents, update_agent_status, run_agent, spawn_agents
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import type { SequenceDefinition, SequenceStep } from '../sequential/types.js';
import { executeSequence } from '../sequential/sequential-executor.js';
import { extractKeywords, matchesTriggers } from '../../lib/token-similarity.js';
import { logger } from '../../lib/logger.js';
import { hexToUuid, type SyncPayload } from '../../control-plane/sync-resources.js';

/**
 * Reshape a local agent_workforce_agents row for the cloud upsert.
 * The cloud table requires `system_prompt` (NOT NULL) and accepts a
 * jsonb `config`; the local row stores config as a JSON string. We
 * parse it here and fall back to an empty object so a malformed local
 * config doesn't block the sync.
 */
export function agentSyncPayload(row: Record<string, unknown>): SyncPayload {
  let config: unknown = row.config;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { config = {}; }
  }
  let stats: unknown = row.stats;
  if (typeof stats === 'string') {
    try { stats = JSON.parse(stats); } catch { stats = {}; }
  }
  return {
    id: hexToUuid(row.id as string),
    name: (row.name as string) ?? 'Agent',
    role: (row.role as string) ?? 'general',
    description: (row.description as string | null) ?? null,
    avatar_url: (row.avatar_url as string | null) ?? null,
    system_prompt: (row.system_prompt as string | null) ?? '',
    config: config ?? {},
    stats: stats ?? {},
    total_tasks: row.total_tasks ?? 0,
    completed_tasks: row.completed_tasks ?? 0,
    failed_tasks: row.failed_tasks ?? 0,
    tokens_used: row.tokens_used ?? 0,
    paused: row.paused ?? false,
  };
}

// ============================================================================
// SOP → SEQUENCE DECOMPOSITION
// ============================================================================

/**
 * Convert an SOP tool_sequence into a context-aware SequenceDefinition.
 *
 * Instead of blindly executing tool calls, the sequence:
 * 1. Activates desktop/browser
 * 2. Surveys the screen (list_windows + screenshot) to understand what's open
 * 3. Navigates intelligently (reuses existing windows, opens new tabs, avoids disrupting work)
 * 4. Executes the action tools (wait, screenshot, etc.)
 * 5. Summarizes results
 *
 * Each step is trivially simple — even a cheap model can handle one tool call.
 * The intelligence is in the decomposition and predecessor context flow.
 */
function sopToSequence(
  sopName: string,
  toolSequence: Array<string | { tool: string; args?: Record<string, unknown> }>,
  agentId: string,
  userPrompt: string,
): SequenceDefinition {
  const usesDesktop = toolSequence.some(s => {
    const name = typeof s === 'string' ? s : s.tool;
    return name.startsWith('desktop_') || name === 'request_desktop';
  });

  const activationTool = usesDesktop ? 'request_desktop' : 'request_browser';
  const avoidTool = usesDesktop ? 'Do NOT use request_browser.' : 'Do NOT use request_desktop.';

  const steps: SequenceStep[] = [];

  // Phase 1: Activate desktop/browser
  steps.push({
    id: 'step-activate',
    agentId,
    prompt: `Call ${activationTool} with reason: "${sopName}". ${avoidTool} This is your ONLY task.`,
    dependsOn: [],
  });

  // Phase 2: Survey — gather context about what's on screen
  steps.push({
    id: 'step-survey',
    agentId,
    prompt: `Survey the desktop to understand what's currently open. Call desktop_list_windows first, then call desktop_screenshot. Report all Chrome windows you see (titles, positions, displays) and what's visible on screen. This is your ONLY task — just gather info.`,
    dependsOn: ['step-activate'],
  });

  // Phase 3: Navigate — use survey context to find/open the right window
  // Extract the target URL or app from the SOP tool sequence args
  const typeStep = toolSequence.find(s => {
    const name = typeof s === 'string' ? s : s.tool;
    return name === 'desktop_type';
  });
  const targetUrl = typeof typeStep === 'object' && typeStep?.args?.text
    ? String(typeStep.args.text)
    : '';

  steps.push({
    id: 'step-navigate',
    agentId,
    prompt: `Navigate to the target page for "${sopName}". Read the survey results from the previous step to see what Chrome windows are open.

Your goal: Get to ${targetUrl || 'the target page'} in Chrome.

Decision tree:
1. If a Chrome window title already contains the target domain (e.g., "x.com"), use desktop_focus_window(app: "Google Chrome", title_contains: "${targetUrl ? new URL(targetUrl.startsWith('http') ? targetUrl : 'https://' + targetUrl).hostname.replace('www.', '') : 'target'}") to focus it
2. If Chrome is open but no window shows the target, use desktop_focus_window to focus any Chrome window, then desktop_key(key: "cmd+t") to open a new tab, desktop_type(text: "${targetUrl}"), desktop_key(key: "enter")
3. If Chrome is not open at all, use desktop_focus_app(app: "Google Chrome") to launch it, wait briefly, then navigate

Do NOT close or disrupt existing windows/tabs. Always prefer opening a new tab over replacing an existing one.`,
    dependsOn: ['step-survey'],
  });

  // Phase 4: Action — execute remaining SOP tools (wait, screenshot, etc.)
  // Filter out navigation tools (already handled in step-navigate)
  const navigationTools = new Set(['desktop_focus_app', 'desktop_focus_window', 'desktop_key', 'desktop_type', 'request_desktop', 'request_browser']);
  const actionTools = toolSequence.filter(s => {
    const name = typeof s === 'string' ? s : s.tool;
    return !navigationTools.has(name);
  });

  if (actionTools.length > 0) {
    const actionDescs = actionTools.map(t => {
      if (typeof t === 'string') return t;
      const argsStr = t.args ? `(${JSON.stringify(t.args)})` : '';
      return `${t.tool}${argsStr}`;
    }).join(', ');

    steps.push({
      id: 'step-action',
      agentId,
      prompt: `Execute these action tools in order: ${actionDescs}. Call each tool and report the results.`,
      dependsOn: ['step-navigate'],
    });
  }

  // Phase 5: Summarize
  steps.push({
    id: 'step-summarize',
    agentId,
    prompt: `Summarize the results of "${sopName}" for: ${userPrompt}

Review all previous step outputs. Provide a clear report including:
- What was found on screen (from survey)
- Navigation result (which window/tab was used)
- Action results (screenshots, data gathered)
- Classifications and recommended next actions`,
    dependsOn: [steps[steps.length - 1].id],
  });

  return {
    name: `SOP: ${sopName}`,
    description: `Context-aware execution of "${sopName}" procedure`,
    steps,
    sourcePrompt: userPrompt,
  };
}

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
  const modelTier = input.model_tier as 'fast' | 'balanced' | 'strong' | undefined;
  if (!agentId || !prompt) return { success: false, error: 'agent_id and prompt are required' };

  // Map model_tier hint to difficulty override for engine
  const TIER_TO_DIFFICULTY: Record<string, 'simple' | 'moderate' | 'complex'> = {
    fast: 'simple',
    balanced: 'moderate',
    strong: 'complex',
  };
  const difficultyOverride = modelTier ? TIER_TO_DIFFICULTY[modelTier] : undefined;

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

  // Check for matching SOP
  let enrichedPrompt = prompt;
  try {
    const { data: procedureSkills } = await ctx.db.from('agent_workforce_skills')
      .select('name, definition, triggers')
      .eq('workspace_id', ctx.workspaceId)
      .eq('is_active', 1)
      .eq('skill_type', 'procedure')
      .limit(10);

    if (procedureSkills) {
      const keywords = extractKeywords(prompt);
      for (const skill of procedureSkills as Array<Record<string, unknown>>) {
        const triggers: string[] = Array.isArray(skill.triggers) ? skill.triggers as string[] : (() => { try { return JSON.parse((skill.triggers as string) || '[]'); } catch { return []; } })();
        if (keywords.length > 0 && matchesTriggers(triggers, keywords)) {
          const def = typeof skill.definition === 'string' ? JSON.parse(skill.definition as string) : skill.definition;
          if (def?.tool_sequence) {
            const seq = def.tool_sequence as Array<string | { tool: string; args?: Record<string, unknown> }>;
            const usesDesktop = seq.some((s: string | { tool: string }) => {
              const n = typeof s === 'string' ? s : s.tool;
              return n.startsWith('desktop_') || n === 'request_desktop';
            });

            // Non-desktop SOPs → decompose into granular sequence (each tool = micro-task)
            if (!usesDesktop) {
              const sequence = sopToSequence(skill.name as string, seq, agentId, prompt);
              logger.info({ sop: skill.name, stepCount: sequence.steps.length }, '[run_agent] SOP matched — executing as sequence');
              const seqResult = await executeSequence({
                db: ctx.db, engine: ctx.engine, workspaceId: ctx.workspaceId,
                definition: sequence, enableAbstention: false, stepTimeoutMs: 60_000,
              });
              return {
                success: seqResult.success,
                data: {
                  message: `${a.name} executed "${skill.name}" (${seqResult.stepResults.length} steps).`,
                  sopName: skill.name, status: seqResult.success ? 'completed' : 'failed',
                  output: seqResult.finalOutput?.slice(0, 2000) || 'Procedure completed.',
                  steps: seqResult.stepResults.map(s => ({ stepId: s.stepId, status: s.status, durationMs: s.durationMs })),
                  totalDurationMs: seqResult.totalDurationMs,
                },
              };
            }

            // Desktop SOPs → single task with context-aware prompt (desktop lock requires one session)
            logger.info({ sop: skill.name }, '[run_agent] Desktop SOP matched — building context-aware prompt');

            // Extract target URL from the tool sequence
            const typeStep = seq.find(s => typeof s === 'object' && s.tool === 'desktop_type');
            const targetUrl = typeof typeStep === 'object' && typeStep?.args?.text ? String(typeStep.args.text) : '';
            const targetDomain = targetUrl ? (() => { try { return new URL(targetUrl.startsWith('http') ? targetUrl : 'https://' + targetUrl).hostname.replace('www.', ''); } catch { return ''; } })() : '';

            // Pull preconditions from SOP (e.g., "Chrome running with ogsus@ohwow.fun profile")
            const preconditions = (def.preconditions as string[] | undefined) || [];
            const profileHint = preconditions.find((p: string) => p.toLowerCase().includes('profile'));

            enrichedPrompt = `${prompt}

PROCEDURE: "${skill.name}" — Follow this context-aware approach:
${profileHint ? `\nPRECONDITION: ${profileHint}` : ''}

PHASE 1 — SURVEY: Call request_desktop, then desktop_list_windows to see all open windows, then desktop_screenshot to see the current screen.

CRITICAL: Distinguish between the REAL Google Chrome (with saved logins and profiles) and Playwright Chromium (automated browser with NO logins). How to tell them apart:
- Playwright Chromium shows a yellow warning bar: "You are using an unsupported command-line flag: --no-sandbox"
- Playwright Chromium has NO profile icon in the top-right corner
- Real Chrome shows your profile avatar/icon in the top-right and has a "Profiles" menu
- In desktop_list_windows, Chromium may appear as "Chromium" instead of "Google Chrome"
NEVER use a Chromium/Playwright window. Only use the real Google Chrome with the correct profile.

PHASE 2 — NAVIGATE: Based on your survey:
${profileHint ? `\nIMPORTANT: You need the Chrome profile for ${profileHint.replace(/.*profile/i, '').trim() || 'the correct account'}. Chrome has multiple profiles — each runs as a separate window. Look at the window titles from list_windows to find the right one. If you see the wrong profile (e.g., a different email), you need to switch profiles via the Chrome menu: Profiles > select the right one. Or look for a Chrome window whose title matches content from the target account.` : ''}
${targetDomain ? `- If any real Chrome window title contains "${targetDomain}", call desktop_focus_window(app: "Google Chrome", title_contains: "${targetDomain}")` : ''}
- If Chrome is open but showing the wrong profile, use the Profiles menu (click the profile avatar in the top-right corner of Chrome, or use menu Chrome > Profiles) to switch to the correct profile
- If Chrome is open with the right profile but on a different page, focus it, then desktop_key(key: "cmd+t") for a new tab, desktop_type(text: "${targetUrl}"), desktop_key(key: "enter")
- If Chrome is not open, call desktop_focus_app(app: "Google Chrome"), wait, then navigate
- After navigating, take a screenshot to verify you're on the right page AND logged in (not a login wall). If you see a login page, you have the wrong Chrome profile.
Do NOT close or disrupt existing windows/tabs. Open a new tab if needed.

PHASE 3 — ACTION: Call desktop_wait(duration: 5000), then take a screenshot. IMPORTANT: Use the display number where Chrome is located (from the list_windows survey — windows have "[Display N]" annotations). Call desktop_screenshot(display: N) with the correct display number. If you don't know which display, take desktop_screenshot() first, and if it doesn't show Chrome, try desktop_screenshot(display: 2).

PHASE 4 — REPORT: Describe what you see. Include login status, any messages/content found, classifications, and recommended next actions.

Do NOT use request_browser. This task requires desktop automation on the real Chrome with saved logins.`;
          }
          break;
        }
      }
    }
  } catch (sopErr) {
    logger.warn({ err: sopErr instanceof Error ? sopErr.message : sopErr }, '[run_agent] SOP enrichment failed');
  }

  // Standard single-agent execution (with optional SOP enrichment for desktop)
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
      ctx.engine.executeTask(agentId, taskId, difficultyOverride ? { difficultyOverride } : undefined),
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
  const agents = input.agents as Array<{ agent_id: string; prompt: string; project_id?: string; model_tier?: string }>;
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

    // Map model_tier hint for this agent
    const tierMap: Record<string, 'simple' | 'moderate' | 'complex'> = { fast: 'simple', balanced: 'moderate', strong: 'complex' };
    const spawnDiffOverride = entry.model_tier ? tierMap[entry.model_tier] : undefined;

    // Fire-and-forget: launch execution without awaiting
    ctx.engine.executeTask(agentId, taskId, spawnDiffOverride ? { difficultyOverride: spawnDiffOverride } : undefined).catch(() => {
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
