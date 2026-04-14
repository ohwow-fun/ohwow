/**
 * RuntimeEngine — Local Agent Task Execution
 *
 * Self-contained execution engine for the local runtime.
 * Uses DatabaseAdapter directly for all queries (no imports from main app).
 * Simplified vs cloud agent-runner: no browser tools, no integrations,
 * no email notifications — core agent execution with memory.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  TextBlock,
  Tool,
  ToolResultBlockParam,
  ToolUseBlock,
  WebSearchTool20250305,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { loadWorkspaceDefaultPaths } from '../db/workspace-paths.js';
import {
  parseResponseMeta,
  shouldAutoCreateDeliverable,
} from './response-classifier.js';
import { buildAgentSystemPrompt, assembleSystemPrompt } from './system-prompt.js';
import { resolveTaskCapabilities } from './task-capabilities.js';
import { buildTaskToolList } from './tool-list.js';
import { finalizeTaskSuccess } from './task-completion.js';
import { handleTaskFailure } from './task-failure.js';
import { selectAgentModelForIteration } from './agent-model-tiers.js';
import type { ClaudeModel } from './ai-types.js';
import { calculateCostCents } from './ai-types.js';
import {
  parseBudget,
  checkPreFlight,
  checkMidLoop,
  isExternalProvider,
  upsertDailyResourceUsage,
} from './budget-guard.js';
import { strengthenSynapse } from '../symbiosis/synapse-dynamics.js';
import type { EngineConfig, RuntimeEffects, ExecuteAgentResult, BusinessContext } from './types.js';
import type { ModelRouter, ModelProvider, ModelResponseWithTools } from './model-router.js';
import { convertToolsToOpenAI } from './tool-format.js';
import {
  isMemorySyncable,
  type ConfidentialityLevel,
  type MemorySyncPolicy,
} from '../lib/memory-utils.js';
// MemorySyncPayload moved to ./memory-sync.js
import { logger } from '../lib/logger.js';
// NOTE: extractKeywords/matchesTriggers removed — see compileSkills
// below. Skill discovery is no longer keyword-based; the LLM picks
// tools from its tool list surfaced via runtimeToolRegistry.
import {
  executeWithClaudeCodeCli,
  isClaudeCodeCliAvailable,
  buildSkillsDir,
  createSessionStore,
  type ClaudeCodeSessionStore,
} from './adapters/index.js';
import {
  LocalBrowserService,
  BROWSER_TOOL_DEFINITIONS,
  REQUEST_BROWSER_TOOL,
} from './browser/index.js';
import {
  LocalDesktopService,
  DESKTOP_TOOL_DEFINITIONS,
  REQUEST_DESKTOP_TOOL,
} from './desktop/index.js';
import type { DesktopServiceOptions } from './desktop/index.js';
import { DRAFT_TOOL_DEFINITIONS } from './draft-tools.js';
import {
  ScraplingService,
  SCRAPLING_TOOL_DEFINITIONS,
} from './scrapling/index.js';
import { parseToolArguments } from './tool-parse.js';
import { Semaphore } from './semaphore.js';
import {
  FileAccessGuard,
  FILESYSTEM_TOOL_DEFINITIONS,
} from './filesystem/index.js';
import { BASH_TOOL_DEFINITIONS } from './bash/index.js';
import {
  DocMountManager,
  DOC_MOUNT_TOOL_DEFINITIONS,
} from './doc-mounts/index.js';
import { McpClientManager } from '../mcp/index.js';
import type { McpServerConfig } from '../mcp/types.js';
import { retrieveRelevantMemories, retrieveKnowledgeChunks } from '../lib/rag/retrieval.js';
import { scanForInjection, wrapUserData } from '../lib/prompt-injection.js';
import { hashToolCall, REFLECTION_PROMPT } from '../lib/stagnation.js';
import { CircuitBreaker } from '../orchestrator/error-recovery.js';
import { Brain } from '../brain/brain.js';
import crypto from 'crypto';
import { classifyError, isRetryableFailure } from '../lib/error-classification.js';
import { classifyRootCause } from '../lib/failure-root-cause.js';
import { getToolReversibility } from '../lib/tool-reversibility.js';
import { LocalActionJournalService } from '../lib/action-journal.js';
import { validateOutputSafety } from '../lib/output-validator.js';
import { scoreDifficulty, type DifficultyLevel } from './difficulty-scorer.js';
import { verifyAgentOutputLocal } from '../lib/verifier.js';
import { withSpan } from '../lib/telemetry.js';
import { runAgentMemoryMaintenance } from '../lib/memory-maintenance.js';
import { extractMemories as extractMemoriesFromTask } from './memory-sync.js';
import {
  CONTEXT_SUMMARIZE_THRESHOLD_PCT,
  CONTEXT_WARNING_THRESHOLD_PCT,
  SUMMARIZE_COOLDOWN_ITERATIONS,
  getContextLimit,
  summarizeMessages,
} from './message-summarization.js';
import { detectAndPersistAnomalies } from './anomaly-monitoring.js';
import { createDefaultToolRegistry } from './tool-dispatch/index.js';
import type { ToolExecutionContext, ToolCallResult } from './tool-dispatch/index.js';
import {
  resolveAgentToolPolicy,
  filterToolsByPolicy,
  allowlistPermits,
} from './agent-tool-policy.js';
import { STATE_TOOL_DEFINITIONS, loadStateContext, loadPreviousTaskContext } from './state/index.js';
import { LocalLLMCache } from './llm-cache.js';
import { serializeCheckpoint, type TaskCheckpoint } from './checkpoint-types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_TOOL_LOOP_ITERATIONS = 25;
const REACT_SUMMARY_MAX_LENGTH = 500;

// Context summarization constants and MODEL_ID_TO_CLAUDE imported from ./message-summarization.js

interface LocalReActStep {
  iteration: number;
  thought: string;
  actions: Array<{ tool: string; inputSummary: string }>;
  observations: Array<{ tool: string; resultSummary: string; success: boolean }>;
  durationMs: number;
  timestamp: string;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

const MODEL_MAP: Record<ClaudeModel, string> = {
  'claude-sonnet-4-5': 'claude-sonnet-4-5-20250929',
  'claude-haiku-4': 'claude-haiku-4-5-20251001',
};

const WEB_SEARCH_TOOL: WebSearchTool20250305 = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 5,
};

// MEMORY_EXTRACTION_PROMPT moved to ./memory-sync.js

// ============================================================================
// DATABASE ROW TYPES (local to engine)
// ============================================================================

interface AgentRow {
  id: string;
  workspace_id: string;
  name: string;
  role: string;
  system_prompt: string;
  config: string | Record<string, unknown>;
  status: string;
  stats: string | Record<string, unknown>;
  autonomy_budget?: string | null;
}

interface TaskRow {
  id: string;
  agent_id: string;
  title: string;
  description: string | null;
  input: string | unknown;
  output: string | unknown;
  status: string;
  contact_ids: string | string[];
  goal_id: string | null;
  parent_task_id: string | null;
  metadata: string | Record<string, unknown> | null;
}

interface TaskMessageRow {
  id: string;
  role: string;
  content: string;
  metadata: string | Record<string, unknown>;
}

// ============================================================================
// RUNTIME ENGINE
// ============================================================================

export class RuntimeEngine {
  anthropic: Anthropic | null;
  emitter: TypedEventBus<RuntimeEvents> | null;
  modelRouter: ModelRouter | null;
  scraplingService: ScraplingService;
  semaphore: Semaphore;
  pendingElicitations = new Map<string, (result: Record<string, unknown> | null) => void>();
  circuitBreaker = new CircuitBreaker();
  toolRegistry = createDefaultToolRegistry();
  docMountManager: DocMountManager;
  /** Brain: unified cognitive coordinator for agent task execution. */
  brain = new Brain({ modelRouter: null });
  taskDistributor: import('../peers/task-distributor.js').TaskDistributor | null = null;
  ccSessionStore: ClaudeCodeSessionStore | null = null;
  deviceFetcher: import('../data-locality/fetch-client.js').DeviceDataFetcher | null = null;

  /** Set the device data fetcher for device-pinned memory retrieval */
  setDeviceFetcher(fetcher: import('../data-locality/fetch-client.js').DeviceDataFetcher): void {
    this.deviceFetcher = fetcher;
  }

  db: DatabaseAdapter;
  config: EngineConfig;
  effects: RuntimeEffects;
  businessContext: BusinessContext;

  constructor(
    db: DatabaseAdapter,
    config: EngineConfig,
    effects: RuntimeEffects,
    businessContext: BusinessContext,
    emitter?: TypedEventBus<RuntimeEvents>,
    modelRouter?: ModelRouter,
    scraplingService?: ScraplingService,
  ) {
    this.db = db;
    this.config = config;
    this.effects = effects;
    this.businessContext = businessContext;
    this.anthropic = config.anthropicApiKey
      ? new Anthropic({ apiKey: config.anthropicApiKey })
      : null;
    this.emitter = emitter ?? null;
    this.modelRouter = modelRouter ?? null;
    this.scraplingService = scraplingService ?? new ScraplingService();
    this.docMountManager = new DocMountManager(db, this.scraplingService, config.dataDir);
    // Ollama processes one inference at a time; Anthropic can handle concurrent requests
    this.semaphore = new Semaphore(config.anthropicApiKey ? 3 : 1);
    // Claude Code session store for --resume support
    this.ccSessionStore = createSessionStore(db);
  }

  /** Get the Brain instance for body integration. */
  getBrain(): Brain {
    return this.brain;
  }

  /** Set the task distributor for peer delegation. */
  setTaskDistributor(distributor: import('../peers/task-distributor.js').TaskDistributor): void {
    this.taskDistributor = distributor;
  }

  /** Emit a lifecycle event if an emitter is attached */
  emit(event: string, data: unknown): void {
    this.emitter?.emit(event, data);
  }

  /** Build a ToolExecutionContext for the current task */
  buildToolContext(opts: {
    taskId: string;
    agentId: string;
    workspaceId: string;
    goalId?: string;
    browserService: LocalBrowserService | null;
    browserActivated: boolean;
    desktopService: LocalDesktopService | null;
    desktopActivated: boolean;
    desktopOptions?: Partial<DesktopServiceOptions>;
    fileAccessGuard: FileAccessGuard | null;
    mcpClients: McpClientManager | null;
    gitEnabled?: boolean;
  }): ToolExecutionContext {
    return {
      taskId: opts.taskId,
      agentId: opts.agentId,
      workspaceId: opts.workspaceId,
      goalId: opts.goalId,
      dataDir: this.config.dataDir,
      browserHeadless: this.config.browserHeadless,
      scraplingService: this.scraplingService,
      fileAccessGuard: opts.fileAccessGuard,
      mcpClients: opts.mcpClients,
      circuitBreaker: this.circuitBreaker,
      db: this.db,
      browserService: opts.browserService,
      browserActivated: opts.browserActivated,
      desktopService: opts.desktopService,
      desktopActivated: opts.desktopActivated,
      desktopOptions: opts.desktopOptions,
      docMountManager: this.docMountManager,
      gitEnabled: opts.gitEnabled,
      modelRouter: this.modelRouter,
    };
  }

  /** Dispatch a tool call via the registry */
  async dispatchTool(
    toolName: string,
    input: Record<string, unknown>,
    toolCtx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    return this.toolRegistry.execute(toolName, input, toolCtx);
  }

  /** Resolve a pending MCP elicitation request. Called by the API route. */
  resolveElicitation(requestId: string, result: Record<string, unknown> | null): void {
    const resolve = this.pendingElicitations.get(requestId);
    if (resolve) {
      this.pendingElicitations.delete(requestId);
      resolve(result);
    }
  }

  // ==========================================================================
  // CLAUDE CODE CLI EXECUTION PATH
  // ==========================================================================

  /**
   * Determine whether this agent/task should use Claude Code CLI for full delegation.
   * Priority: per-agent override > global config > autodetect.
   */
  async shouldUseClaudeCodeCli(agentConfig: Record<string, unknown>): Promise<boolean> {
    // Per-agent explicit override
    if (agentConfig.execution_backend === 'claude-code-cli') return isClaudeCodeCliAvailable();
    if (agentConfig.execution_backend === 'native') return false;

    // Global config explicit mode
    if (this.config.modelSource === 'claude-code-cli') return isClaudeCodeCliAvailable();

    // Autodetect: only for agents with code/file capabilities
    const autodetect = this.config.claudeCodeCliAutodetect !== false;
    if (autodetect && isClaudeCodeCliAvailable()) {
      const hasCodeCapabilities = agentConfig.bash_enabled === true
        || agentConfig.local_files_enabled === true;
      return hasCodeCapabilities;
    }

    return false;
  }

  /**
   * Execute a task by delegating entirely to Claude Code CLI.
   * Spawns `claude` as a child process with agent context injected via --add-dir.
   * Claude Code handles the full tool loop (file editing, bash, search, etc.).
   */
  async executeWithClaudeCodeCliPath(opts: {
    agentId: string;
    taskId: string;
    workspaceId: string;
    agent: AgentRow;
    agentConfig: Record<string, unknown>;
    task: TaskRow;
    startTime: number;
    traceId: string;
  }): Promise<ExecuteAgentResult> {
    const { agentId, taskId, workspaceId, agent, agentConfig, task, startTime, traceId } = opts;

    logger.info({ agentId, taskId }, '[RuntimeEngine] Executing via Claude Code CLI');

    // Budget guard: pre-flight check (Claude Code CLI is always an external provider)
    const ccBudget = parseBudget(agent.autonomy_budget as string | null);
    if (ccBudget) {
      const preflight = await checkPreFlight(this.db, agentId, workspaceId, ccBudget);
      if (!preflight.allowed) {
        logger.warn({ agentId, taskId, reason: preflight.reason }, '[RuntimeEngine] Budget exceeded, rejecting Claude Code CLI task');
        await this.db.from('agent_workforce_tasks').update({
          status: 'failed',
          output: preflight.reason,
          updated_at: new Date().toISOString(),
        }).eq('id', taskId);
        await this.db.rpc('create_agent_activity', {
          p_workspace_id: workspaceId,
          p_activity_type: 'budget_exceeded',
          p_title: `Budget limit reached for ${agent.name}`,
          p_description: preflight.reason,
          p_agent_id: agentId,
          p_task_id: taskId,
          p_metadata: { runtime: true, path: 'claude-code-cli' },
        });
        this.emit('budget:exceeded', { agentId, taskId, reason: preflight.reason });
        return {
          success: false,
          taskId,
          status: 'failed',
          output: { text: preflight.reason || 'Budget exceeded' },
          tokensUsed: 0,
          costCents: 0,
        };
      }
      if (preflight.warningPct) {
        this.emit('budget:warning', { agentId, taskId, pct: preflight.warningPct });
      }
    }

    // 1. Compile memory + knowledge
    const [memoryDoc, knowledgeDoc] = await Promise.all([
      this.compileMemory(agentId, workspaceId, task.title),
      this.compileKnowledge(agentId, workspaceId, task.title, task.description),
    ]);

    // 2. Resolve working directory from agent file access paths
    let workingDir: string | undefined;
    try {
      const { data: pathData } = await this.db
        .from('agent_file_access_paths')
        .select('path')
        .eq('agent_id', agentId)
        .limit(1);
      if (pathData && (pathData as Array<{ path: string }>).length > 0) {
        workingDir = (pathData as Array<{ path: string }>)[0].path;
      }
    } catch { /* non-fatal, use undefined (claude's cwd) */ }

    // 3. Load goal context if linked
    let goalContext: string | undefined;
    if (task.goal_id) {
      try {
        const { data: goalData } = await this.db
          .from('agent_workforce_goals')
          .select('title, description, target_metric, target_value, current_value, unit')
          .eq('id', task.goal_id)
          .single();
        if (goalData) {
          const g = goalData as { title: string; description?: string; target_metric?: string; target_value?: number; current_value?: number; unit?: string };
          goalContext = `Goal: ${g.title}${g.description ? `\n${g.description}` : ''}${g.target_metric ? `\nMetric: ${g.target_metric} (${g.current_value ?? 0}/${g.target_value ?? '?'} ${g.unit || ''})` : ''}`;
        }
      } catch { /* non-fatal */ }
    }

    // 4. Build skills directory with agent context
    const taskInput = typeof task.input === 'string' ? task.input : JSON.stringify(task.input ?? '');
    const skillsDir = await buildSkillsDir({
      agentId,
      agentName: agent.name,
      agentRole: agent.role,
      systemPrompt: agent.system_prompt || '',
      memoryDocument: memoryDoc || undefined,
      knowledgeDocument: knowledgeDoc || undefined,
      taskId,
      taskTitle: task.title,
      taskDescription: task.description || undefined,
      taskInput,
      goalContext,
      workspaceId,
      daemonPort: this.config.daemonPort || 7700,
      daemonToken: this.config.daemonToken || '',
    });

    try {
      // 5. Look up existing session for resume
      const sessionId = await this.ccSessionStore?.getActiveSession(agentId, workingDir) ?? undefined;

      // 6. Execute via Claude Code CLI
      const result = await executeWithClaudeCodeCli(
        taskInput,
        {
          binaryPath: this.config.claudeCodeCliPath || undefined,
          model: (this.config.claudeCodeCliModel || agentConfig.claude_code_model as string) || undefined,
          maxTurns: this.config.claudeCodeCliMaxTurns || 25,
          permissionMode: this.config.claudeCodeCliPermissionMode || 'skip',
          workingDirectory: workingDir,
          sessionId,
          timeout: 300_000, // 5 min
          envVars: {
            OHWOW_AGENT_ID: agentId,
            OHWOW_TASK_ID: taskId,
            OHWOW_WORKSPACE_ID: workspaceId,
          },
          skillsDirs: [skillsDir.dir],
        },
        (progress) => {
          this.emit('task:progress', { taskId, tokensUsed: progress.tokensUsed });
        },
      );

      // 7. Persist session for next run
      if (result.sessionId) {
        await this.ccSessionStore?.saveSession(agentId, workspaceId, result.sessionId, workingDir);
      } else if (sessionId) {
        // Session resume failed or no session returned — mark stale
        await this.ccSessionStore?.markStale(agentId);
      }

      // 8. Post-execution: save results and run all post-processing
      const content = result.content || '';
      const totalTokens = result.inputTokens + result.outputTokens;
      const costCents = result.costCents;
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);

      // Parse response classification
      const { type: responseType, cleanContent } = parseResponseMeta(content);

      // Autonomy-level status routing
      const autonomyLevel = (agentConfig.autonomy_level as number | undefined) ?? 2;
      let finalStatus: 'completed' | 'needs_approval' = 'completed';
      if (autonomyLevel === 1 && responseType !== 'informational') {
        finalStatus = 'needs_approval';
      }

      // Save output to DB
      await this.db.from('agent_workforce_tasks').update({
        status: finalStatus,
        output: cleanContent,
        response_type: responseType || null,
        model_used: result.model || 'claude-code-cli',
        tokens_used: totalTokens,
        cost_cents: costCents,
        completed_at: new Date().toISOString(),
        duration_seconds: durationSeconds,
        updated_at: new Date().toISOString(),
      }).eq('id', taskId);

      // Save assistant message
      await this.db.from('agent_workforce_task_messages').insert({
        task_id: taskId,
        role: 'assistant',
        content: cleanContent,
        metadata: JSON.stringify({
          model: result.model,
          tokensUsed: totalTokens,
          costCents,
          executionBackend: 'claude-code-cli',
          toolsUsed: result.toolsUsed,
          numTurns: result.numTurns,
        }),
      });

      // Update agent stats
      const currentStats = typeof agent.stats === 'string' ? JSON.parse(agent.stats as string) : (agent.stats || {});
      const newTotal = (currentStats.total_tasks || 0) + 1;
      const prevAvgDuration = currentStats.avg_duration_seconds || 0;
      const prevAvgTokens = currentStats.avg_tokens || 0;
      await this.db.from('agent_workforce_agents').update({
        status: 'idle',
        stats: JSON.stringify({
          total_tasks: newTotal,
          completed_tasks: (currentStats.completed_tasks || 0) + (finalStatus === 'completed' ? 1 : 0),
          failed_tasks: currentStats.failed_tasks || 0,
          tokens_used: (currentStats.tokens_used || 0) + totalTokens,
          cost_cents: (currentStats.cost_cents || 0) + costCents,
          avg_duration_seconds: Math.round(prevAvgDuration + (durationSeconds - prevAvgDuration) / newTotal),
          avg_tokens: Math.round(prevAvgTokens + (totalTokens - prevAvgTokens) / newTotal),
          last_task_at: new Date().toISOString(),
        }),
        updated_at: new Date().toISOString(),
      }).eq('id', agentId);

      // Track daily resource usage (for budget guard queries)
      void upsertDailyResourceUsage(this.db, workspaceId, totalTokens, costCents);

      // Auto-strengthen delegation synapses when a subtask completes for a different agent
      if (task.parent_task_id) {
        try {
          const { data: parentTask } = await this.db
            .from('agent_workforce_tasks')
            .select('agent_id')
            .eq('id', task.parent_task_id)
            .maybeSingle();
          const parentAgentId = (parentTask as { agent_id: string } | null)?.agent_id;
          if (parentAgentId && parentAgentId !== agentId) {
            void strengthenSynapse(this.db, workspaceId, parentAgentId, agentId, 'delegation', {
              type: 'task_delegation',
              detail: `Task "${task.title}" delegated from parent task ${task.parent_task_id}`,
              timestamp: new Date().toISOString(),
            });
          }
        } catch { /* non-fatal synapse tracking */ }
      }

      // Log activity
      await this.db.rpc('create_agent_activity', {
        p_workspace_id: workspaceId,
        p_activity_type: 'task_completed',
        p_title: `${task.title} — ${finalStatus}`,
        p_description: `${totalTokens} tokens, ${durationSeconds}s (Claude Code CLI)`,
        p_agent_id: agentId,
        p_task_id: taskId,
        p_metadata: { runtime: true, model: result.model, executionBackend: 'claude-code-cli' },
      });

      // Emit completion events
      if (finalStatus === 'needs_approval') {
        this.emit('task:needs_approval', {
          taskId, agentId, agentName: agent.name, taskTitle: task.title, workspaceId,
        });
      }
      this.emit('task:completed', { taskId, agentId, status: finalStatus, tokensUsed: totalTokens, costCents });

      // Goal progress (auto-increment on completion)
      if (task.goal_id && finalStatus === 'completed') {
        try {
          const { data: goalData } = await this.db
            .from('agent_workforce_goals')
            .select('current_value, target_value, status')
            .eq('id', task.goal_id)
            .single();
          if (goalData) {
            const goal = goalData as { current_value: number | null; target_value: number | null; status: string };
            const newValue = (goal.current_value ?? 0) + 1;
            const updateData: Record<string, unknown> = { current_value: newValue, updated_at: new Date().toISOString() };
            if (goal.target_value && newValue >= goal.target_value && goal.status === 'active') {
              updateData.status = 'completed';
              updateData.completed_at = new Date().toISOString();
            }
            await this.db.from('agent_workforce_goals').update(updateData).eq('id', task.goal_id);
          }
        } catch { /* non-fatal */ }
      }

      // Trigger child tasks
      if (finalStatus === 'completed') {
        (async () => {
          try {
            const { data: childTasks } = await this.db
              .from('agent_workforce_tasks')
              .select('id, agent_id')
              .eq('parent_task_id', taskId)
              .eq('status', 'pending');
            if (childTasks && (childTasks as unknown[]).length > 0) {
              for (const child of childTasks as Array<{ id: string; agent_id: string }>) {
                this.executeTask(child.agent_id, child.id).catch(() => {});
              }
            }
          } catch { /* non-fatal */ }
        })();
      }

      // Memory extraction (async, fire-and-forget)
      extractMemoriesFromTask(
        { agentId, taskId, workspaceId, taskTitle: task.title, taskInput, taskOutput: cleanContent, toolsUsed: result.toolsUsed },
        { db: this.db, anthropic: this.anthropic, modelRouter: this.modelRouter, onMemoryExtracted: (aid, count) => this.emit('memory:extracted', { agentId: aid, count }) },
      ).catch((err) => {
        logger.error({ err }, '[RuntimeEngine] Memory extraction failed (Claude Code CLI path)');
      });

      // Cloud report (async)
      const cloudReport: import('./types.js').TaskReport = {
        runtimeTaskId: taskId,
        agentId,
        taskTitle: task.title,
        status: finalStatus,
        tokensUsed: totalTokens,
        costCents,
        durationSeconds,
        modelUsed: result.model,
        startedAt: new Date(startTime).toISOString(),
        completedAt: new Date().toISOString(),
        taskOutput: cleanContent || undefined,
      };
      this.effects.reportToCloud(cloudReport).catch(() => {});

      return {
        success: result.success,
        taskId,
        status: finalStatus,
        output: cleanContent,
        tokensUsed: totalTokens,
        costCents,
        responseType: responseType || undefined,
        traceId,
      };
    } finally {
      // Always clean up the skills directory
      await skillsDir.cleanup();
    }
  }

  /**
   * Execute a task for a given agent. Full lifecycle:
   * 1. Load agent + task from local SQLite
   * 2. Update statuses → working / in_progress
   * 3. Compile memory document
   * 4. Build system prompt + messages
   * 5. Call Anthropic SDK (customer's API key)
   * 6. Save output to local SQLite
   * 7. Extract memories (Haiku)
   * 8. Report operational data to cloud (no prompts or outputs)
   */
  async executeTask(agentId: string, taskId: string, options?: { difficultyOverride?: DifficultyLevel }): Promise<ExecuteAgentResult> {
    return withSpan('agent.execute', { 'agent.id': agentId, 'task.id': taskId }, async () => {
    // Pre-flight: ensure we have at least one model provider
    if (!this.config.anthropicApiKey) {
      const anyAvailable = this.modelRouter
        ? await this.modelRouter.isAnyProviderAvailable()
        : false;
      if (!anyAvailable) {
        const errorMsg = 'No AI model available. Configure an API key (Anthropic or OpenRouter) or set up a local model via Settings.';
        await this.db.from('agent_workforce_tasks').update({
          status: 'failed',
          error_message: errorMsg,
          updated_at: new Date().toISOString(),
        }).eq('id', taskId);
        return {
          success: false,
          taskId,
          status: 'failed',
          error: errorMsg,
          tokensUsed: 0,
          costCents: 0,
        };
      }
    }

    // Try to delegate to a peer if local queue is full
    if (this.taskDistributor && this.semaphore.active >= this.semaphore.concurrency) {
      try {
        // Load minimal agent/task data for delegation decision
        const { data: agentRow } = await this.db
          .from('agent_workforce_agents')
          .select('config')
          .eq('id', agentId)
          .single();
        const { data: taskRow } = await this.db
          .from('agent_workforce_tasks')
          .select('title, description, input')
          .eq('id', taskId)
          .single();

        if (agentRow && taskRow) {
          const aRow = agentRow as Record<string, unknown>;
          const tRow = taskRow as Record<string, unknown>;
          const agentCfg = typeof aRow.config === 'string' ? JSON.parse(aRow.config as string) : aRow.config;
          const taskInput = typeof tRow.input === 'string' ? tRow.input as string : JSON.stringify(tRow.input);

          const delegation = await this.taskDistributor.tryDelegate(
            agentCfg as Record<string, unknown>,
            agentId,
            (tRow.description as string) || (tRow.title as string),
            taskInput,
            this.semaphore.active,
            this.semaphore.concurrency,
          );

          if (delegation) {
            await this.db.from('agent_workforce_tasks').update({
              status: 'in_progress',
              delegated_to_peer_id: delegation.peerId,
              delegated_task_id: delegation.remoteTaskId,
              updated_at: new Date().toISOString(),
            }).eq('id', taskId);

            this.emit('task:delegated', {
              taskId,
              agentId,
              peerId: delegation.peerId,
              peerName: delegation.peerName,
            });

            const pollResult = await this.taskDistributor.pollDelegatedTask(
              delegation.peerId,
              delegation.remoteTaskId,
              taskId,
            );

            return {
              success: pollResult.status === 'completed',
              taskId,
              status: pollResult.status as 'completed' | 'failed',
              output: pollResult.output || undefined,
              error: pollResult.status === 'failed' ? 'Delegated task failed on peer' : undefined,
              tokensUsed: 0,
              costCents: 0,
            };
          }
        }
      } catch (err) {
        logger.warn(`[RuntimeEngine] Delegation attempt failed, executing locally: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Queue if all slots are occupied
    if (this.semaphore.active >= this.semaphore.concurrency) {
      this.emit('task:queued', { taskId, agentId, position: this.semaphore.waiting + 1 });
    }
    await this.semaphore.acquire(300_000); // 5-min timeout to prevent indefinite queue stall

    const startTime = Date.now();
    let workspaceId = '';
    let taskTitle = '';

    try {
      // 1. Load agent and task
      const { data: agentData } = await this.db
        .from<AgentRow>('agent_workforce_agents')
        .select('*')
        .eq('id', agentId)
        .single();

      if (!agentData) throw new Error(`Agent not found: ${agentId}`);
      const agent = agentData;
      const agentConfig = typeof agent.config === 'string' ? JSON.parse(agent.config) : agent.config;

      const { data: taskData } = await this.db
        .from<TaskRow>('agent_workforce_tasks')
        .select('*')
        .eq('id', taskId)
        .single();

      if (!taskData) throw new Error(`Task not found: ${taskId}`);
      const task = taskData;

      workspaceId = agent.workspace_id;
      taskTitle = task.title;

      // Generate trace ID for this execution
      const traceId = crypto.randomUUID();

      // Store trace ID in task metadata
      const existingMetadata = typeof task.metadata === 'string'
        ? (() => { try { return JSON.parse(task.metadata); } catch { return {}; } })()
        : (task.metadata || {});
      await this.db.from('agent_workforce_tasks').update({
        metadata: JSON.stringify({ ...existingMetadata, trace_id: traceId }),
      }).eq('id', taskId);

      // 2. Update statuses
      await this.db.from('agent_workforce_agents').update({ status: 'working', updated_at: new Date().toISOString() }).eq('id', agentId);
      await this.db.from('agent_workforce_tasks').update({ status: 'in_progress', started_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', taskId);

      this.emit('task:started', { taskId, agentId, title: task.title });

      // 2.5 Check for Claude Code CLI execution (full delegation)
      const useClaudeCodeCli = await this.shouldUseClaudeCodeCli(agentConfig);
      if (useClaudeCodeCli) {
        try {
          const ccResult = await this.executeWithClaudeCodeCliPath({
            agentId, taskId, workspaceId, agent, agentConfig, task, startTime, traceId,
          });
          this.semaphore.release();
          return ccResult;
        } catch (ccError) {
          // Fall through to native execution on failure
          logger.warn({ err: ccError }, '[RuntimeEngine] Claude Code CLI failed, falling through to native path');
        }
      }

      // 3. Compile memory + knowledge + skills documents
      // Skip SOP injection for sequence sub-steps (they already have a focused micro-prompt)
      const isSequenceStep = (task.title as string)?.startsWith('[Sequence]');
      const [memoryDoc, knowledgeDoc, skillsDoc] = await Promise.all([
        this.compileMemory(agentId, workspaceId, task.title),
        this.compileKnowledge(agentId, workspaceId, task.title, task.description),
        isSequenceStep ? Promise.resolve('') : this.compileSkills(agentId, workspaceId, task.title),
      ]);

      // 4. Build system prompt
      // Resolve capabilities: tool policy, feature flags, file access
      // guard (with doc auto-mount expansion), and goal context.
      const caps = await resolveTaskCapabilities.call(this, {
        agentConfig,
        agentId,
        workspaceId,
        task: { input: task.input, goal_id: task.goal_id },
      });
      const {
        toolPolicy,
        webSearchEnabled,
        browserEnabled,
        scraplingEnabled,
        localFilesEnabled,
        bashEnabled,
        mcpEnabled,
        devopsEnabled,
        desktopEnabled,
        approvalRequired,
        autonomyLevel,
        agentMcpServers,
        desktopOptions,
        goalContext,
      } = caps;
      let fileAccessGuard = caps.fileAccessGuard;

      // 4. Build system prompt + inject state/prev-task/parent/session context
      const { systemPrompt: initialSystemPrompt, activeSessionId } = await assembleSystemPrompt.call(this, {
        agent,
        task,
        taskId,
        agentId,
        workspaceId,
        memoryDoc,
        knowledgeDoc,
        skillsDoc,
        caps,
      });
      const systemPrompt = initialSystemPrompt;

      // 5. Build messages
      const { data: msgData } = await this.db
        .from<TaskMessageRow>('agent_workforce_task_messages')
        .select('*')
        .eq('task_id', taskId)
        .order('created_at', { ascending: true });

      const messages: MessageParam[] = [];
      if (msgData) {
        for (const row of msgData ?? []) {
          if (row.role === 'user' || row.role === 'assistant') {
            messages.push({ role: row.role, content: row.content });
          }
        }
      }

      // Add task input as user message (wrapped for prompt isolation)
      let userMessage = 'Please complete the task as described above.';
      const taskInput = typeof task.input === 'string' ? task.input : (task.input ? JSON.stringify(task.input) : null);
      if (taskInput) userMessage = wrapUserData(taskInput);

      messages.push({ role: 'user', content: userMessage });

      // Save user message
      await this.db.from('agent_workforce_task_messages').insert({
        task_id: taskId,
        role: 'user',
        content: userMessage,
        metadata: '{}',
      });

      // 6. Call Claude
      // Agents never pin a model — the router (or the Anthropic SDK default)
      // picks per task + iteration. `modelId` is only the starting model for
      // the direct Anthropic SDK path; the router path picks dynamically
      // inside `selectAgentModelForIteration`.
      const modelId = MODEL_MAP['claude-sonnet-4-5'];

      // Connect MCP clients + assemble + policy-filter the base tool surface.
      const { tools: initialTools, mcpClients } = await buildTaskToolList.call(this, {
        caps,
        taskInput: task.input,
        agentId,
        taskId,
      });
      const tools: Array<WebSearchTool20250305 | Tool> = initialTools;

      // Browser service is created lazily when request_browser is called
      let browserService: LocalBrowserService | null = null;
      let browserActivated = false;

      // Desktop service is created lazily when request_desktop is called
      let desktopService: LocalDesktopService | null = null;
      let desktopActivated = false;

      let fullContent = '';
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let reactTrace: LocalReActStep[] = [];
      let providerReportedCostCents: number | undefined;

      // Initialize LLM response cache
      const llmCache = new LocalLLMCache(this.db, workspaceId);
      const systemPromptHash = crypto.createHash('sha256').update(systemPrompt).digest('hex');

      // Decide execution path: model router (OpenRouter/Ollama/etc) vs direct Anthropic SDK.
      // Use the router whenever no Anthropic key is configured and a router
      // is available — the router handles OpenRouter, Ollama, and local
      // models transparently and picks per iteration via difficulty +
      // purpose. No per-agent pin is consulted.
      const useModelRouter = !this.config.anthropicApiKey && !!this.modelRouter;
      if (!useModelRouter && !this.anthropic) {
        throw new Error(`Agent "${agent.name}" has no model provider configured. Add an Anthropic or OpenRouter API key in Settings, or enable Ollama for local inference.`);
      }

      // Budget guard: pre-flight check for external providers
      const agentBudget = isExternalProvider(!!useModelRouter)
        ? parseBudget(agent.autonomy_budget as string | null)
        : null;

      if (agentBudget) {
        const preflight = await checkPreFlight(this.db, agentId, workspaceId, agentBudget);
        if (!preflight.allowed) {
          logger.warn({ agentId, taskId, reason: preflight.reason }, '[RuntimeEngine] Budget exceeded, rejecting task');
          await this.db.from('agent_workforce_tasks').update({
            status: 'failed',
            output: preflight.reason,
            updated_at: new Date().toISOString(),
          }).eq('id', taskId);
          await this.db.rpc('create_agent_activity', {
            p_workspace_id: workspaceId,
            p_activity_type: 'budget_exceeded',
            p_title: `Budget limit reached for ${agent.name}`,
            p_description: preflight.reason,
            p_agent_id: agentId,
            p_task_id: taskId,
            p_metadata: { runtime: true },
          });
          this.emit('budget:exceeded', { agentId, taskId, reason: preflight.reason });
          return {
            success: false,
            taskId,
            status: 'failed',
            output: { text: preflight.reason || 'Budget exceeded' },
            tokensUsed: 0,
            costCents: 0,
          };
        }
        if (preflight.warningPct) {
          logger.info({ agentId, pct: preflight.warningPct }, '[RuntimeEngine] Budget warning');
          this.emit('budget:warning', { agentId, taskId, pct: preflight.warningPct });
        }
      }

      // Score task difficulty for model routing (orchestrator can override via model_tier hint)
      const difficulty = options?.difficultyOverride ?? scoreDifficulty({
        taskDescription: task.description || task.title,
        toolCount: tools.filter(t => 'name' in t).length,
        hasIntegrations: !!mcpClients && mcpClients.getToolDefinitions().length > 0,
        hasBrowserTools: browserEnabled,
      });

      try {
        if (useModelRouter) {
          // ── Model router execution path (OpenRouter, Ollama, etc.) ──
          const routerResult = await this.executeWithModelRouter({
            systemPrompt,
            messages,
            tools,
            maxTokens: agentConfig.max_tokens || 4096,
            temperature: agentConfig.temperature ?? 0.7,
            taskId,
            agentId,
            workspaceId,
            goalId: task.goal_id || undefined,
            fileAccessGuard,
            approvalRequired,
            browserEnabled,
            mcpClients,
            desktopOptions,
            difficulty,
            gitEnabled: bashEnabled,
            skillsDocument: skillsDoc || undefined,
          });
          fullContent = routerResult.fullContent;
          totalInputTokens = routerResult.totalInputTokens;
          totalOutputTokens = routerResult.totalOutputTokens;
          reactTrace = routerResult.reactTrace;
          providerReportedCostCents = routerResult.providerCostCents;
          // Track actual model used (resolved from catalog, not raw agent config)
          if (routerResult.actualModelUsed) {
            (agentConfig as Record<string, unknown>)._resolvedModel = routerResult.actualModelUsed;
          }
        } else if (tools.length > 0) {
          // ── Anthropic tool loop ──
          let currentMessages = [...messages];
          let iterations = 0;
          const toolCallHashes: string[] = [];
          const anthropicToolsUsed: string[] = [];
          const contextLimit = getContextLimit(modelId);
          let iterationsSinceSummarize = SUMMARIZE_COOLDOWN_ITERATIONS; // allow summarization from start

          while (iterations < MAX_TOOL_LOOP_ITERATIONS) {
            iterations++;
            const iterationStart = Date.now();

            // Check LLM cache for first iteration (no tool results in messages)
            const isToolContinuation = iterations > 1;
            let response: Anthropic.Messages.Message;

            if (!isToolContinuation) {
              const cached = await llmCache.lookup(systemPromptHash, currentMessages, modelId);
              if (cached) {
                logger.debug({ modelId, similarity: cached.similarity }, 'Local LLM cache hit');
                response = {
                  id: `msg_cached_${Date.now()}`,
                  type: 'message',
                  container: null,
                  role: 'assistant',
                  content: [{ type: 'text' as const, text: cached.responseContent, citations: null }],
                  model: modelId as Anthropic.Messages.Model,
                  stop_reason: 'end_turn',
                  stop_sequence: null,
                  stop_details: null,
                  usage: {
                    input_tokens: cached.responseTokens.input_tokens,
                    output_tokens: cached.responseTokens.output_tokens,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    cache_creation: null,
                    inference_geo: null,
                    server_tool_use: null,
                    service_tier: null,
                  },
                };
              } else {
                response = await this.anthropic!.messages.create({
                  model: modelId,
                  max_tokens: agentConfig.max_tokens || 4096,
                  temperature: agentConfig.temperature ?? 0.7,
                  system: systemPrompt,
                  messages: currentMessages,
                  tools,
                });
              }
            } else {
              response = await this.anthropic!.messages.create({
                model: modelId,
                max_tokens: agentConfig.max_tokens || 4096,
                temperature: agentConfig.temperature ?? 0.7,
                system: systemPrompt,
                messages: currentMessages,
                tools,
              });
            }

            totalInputTokens += response.usage.input_tokens;
            totalOutputTokens += response.usage.output_tokens;
            this.emit('task:progress', { taskId, tokensUsed: totalInputTokens + totalOutputTokens });

            const textBlocks = response.content.filter((b): b is TextBlock => b.type === 'text');
            const textContent = textBlocks.map(b => b.text).join('\n');

            // Budget guard: mid-loop per-task cost check
            if (agentBudget) {
              const runningCost = calculateCostCents(
                modelId as ClaudeModel,
                totalInputTokens,
                totalOutputTokens,
              );
              const midCheck = checkMidLoop(runningCost, agentBudget);
              if (!midCheck.allowed) {
                logger.warn({ agentId, taskId, runningCost, reason: midCheck.reason }, '[RuntimeEngine] Mid-loop budget hard stop');
                await this.db.rpc('create_agent_activity', {
                  p_workspace_id: workspaceId,
                  p_activity_type: 'budget_hard_stop',
                  p_title: `Per-task budget hit for ${agent.name}`,
                  p_description: midCheck.reason,
                  p_agent_id: agentId,
                  p_task_id: taskId,
                  p_metadata: { runtime: true, runningCost },
                });
                this.emit('budget:exceeded', { agentId, taskId, reason: midCheck.reason });
                fullContent = textContent || fullContent;
                break;
              }
            }

            if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
              // Cache end_turn responses for future reuse
              if (!isToolContinuation && response.stop_reason === 'end_turn' && textContent) {
                void llmCache.store(systemPromptHash, currentMessages, modelId, textContent, {
                  input_tokens: response.usage.input_tokens,
                  output_tokens: response.usage.output_tokens,
                });
              }
              fullContent = textContent;
              break;
            }

            // Handle server tool uses (web search) — SDK handles these automatically
            const hasServerTool = response.content.some(b => b.type === 'server_tool_use');

            // Handle client tool uses — unified dispatch for all tool types
            const toolUseBlocks = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');

            if (toolUseBlocks.length === 0 && hasServerTool) {
              // Web search only — let the SDK continue
              currentMessages = [...currentMessages, { role: 'assistant' as const, content: response.content }];
              continue;
            }

            if (toolUseBlocks.length === 0) {
              fullContent = textContent;
              break;
            }

            // Activate browser on-demand if request_browser is called
            const hasRequestBrowser = toolUseBlocks.some(b => b.name === 'request_browser');
            if (hasRequestBrowser && !browserActivated) {
              // Connect to real Chrome via CDP when browserTarget is 'chrome'
              if (this.config.browserTarget === 'chrome') {
                try {
                  const cdpUrl = await LocalBrowserService.connectToChrome(this.config.chromeCdpPort || 9222);
                  browserService = new LocalBrowserService({ headless: false, cdpUrl: cdpUrl || undefined });
                } catch {
                  browserService = new LocalBrowserService({ headless: this.config.browserHeadless });
                }
              } else {
                browserService = new LocalBrowserService({ headless: this.config.browserHeadless });
              }
              browserActivated = true;

              // Remove request_browser from tools and add full browser toolkit
              const requestBrowserIdx = tools.findIndex(t => 'name' in t && t.name === 'request_browser');
              if (requestBrowserIdx !== -1) tools.splice(requestBrowserIdx, 1);
              tools.push(...BROWSER_TOOL_DEFINITIONS);
            }

            // Activate desktop on-demand if request_desktop is called
            const hasRequestDesktop = toolUseBlocks.some(b => b.name === 'request_desktop');
            if (hasRequestDesktop && !desktopActivated) {
              desktopService = new LocalDesktopService({ dataDir: this.config.dataDir, ...desktopOptions });
              desktopActivated = true;

              const requestDesktopIdx = tools.findIndex(t => 'name' in t && t.name === 'request_desktop');
              if (requestDesktopIdx !== -1) tools.splice(requestDesktopIdx, 1);
              tools.push(...DESKTOP_TOOL_DEFINITIONS);
            }

            // Unified tool result collection via registry
            const toolResults: ToolResultBlockParam[] = [];
            const toolCtx = this.buildToolContext({
              taskId,
              agentId,
              workspaceId,
              goalId: task.goal_id || undefined,
              browserService,
              browserActivated,
              desktopService,
              desktopActivated,
              desktopOptions,
              fileAccessGuard,
              mcpClients,
              gitEnabled: bashEnabled,
            });

            for (const block of toolUseBlocks) {
              const result = await this.dispatchTool(
                block.name,
                block.input as Record<string, unknown>,
                toolCtx,
              );

              // Sync browser state back from context (request_browser mutates it)
              if (result.browserActivated && !browserActivated) {
                browserService = toolCtx.browserService;
                browserActivated = true;
                const requestBrowserIdx = tools.findIndex(t => 'name' in t && t.name === 'request_browser');
                if (requestBrowserIdx !== -1) tools.splice(requestBrowserIdx, 1);
                tools.push(...BROWSER_TOOL_DEFINITIONS);
              }

              // Sync desktop state back from context (request_desktop mutates it)
              if (result.desktopActivated && !desktopActivated) {
                desktopService = toolCtx.desktopService;
                desktopActivated = true;
                const requestDesktopIdx = tools.findIndex(t => 'name' in t && t.name === 'request_desktop');
                if (requestDesktopIdx !== -1) tools.splice(requestDesktopIdx, 1);
                tools.push(...DESKTOP_TOOL_DEFINITIONS);
              }

              // Expand FileAccessGuard when doc mounts add new paths
              if (result.mountedDocPaths?.length) {
                const currentPaths = fileAccessGuard?.getAllowedPaths() ?? [];
                const expanded = [...currentPaths, ...result.mountedDocPaths];
                fileAccessGuard = new FileAccessGuard(expanded);
                // Ensure filesystem tools are available if not already
                if (!tools.some(t => 'name' in t && t.name === 'local_list_directory')) {
                  tools.push(...FILESYSTEM_TOOL_DEFINITIONS);
                }
              }

              // Cast content to the SDK-expected type (our ToolCallResult is wider)
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: result.content as string,
                is_error: result.is_error,
              });
            }

            if (toolResults.length > 0) {
              // Track tool names for reversibility check
              for (const block of toolUseBlocks) {
                anthropicToolsUsed.push(block.name);
              }

              // Brain: record tool executions (perceive → predict → record)
              for (const block of toolUseBlocks) {
                const matchedResult = toolResults.find(r => r.tool_use_id === block.id);
                if (matchedResult) {
                  this.brain.recordToolExecution(block.name, block.input, !matchedResult.is_error);
                }
                toolCallHashes.push(hashToolCall(block.name, block.input));
              }

              // Brain: enriched stagnation warning
              if (this.brain.isStagnating() && toolResults.length > 0) {
                const lastResult = toolResults[toolResults.length - 1];
                const existingContent = typeof lastResult.content === 'string' ? lastResult.content : '';
                const warning = this.brain.buildStagnationWarning();
                toolResults[toolResults.length - 1] = {
                  ...lastResult,
                  content: `${existingContent}\n\n${warning}`,
                };
              }

              // Inject reflection prompt every 5 iterations
              if (iterations % 5 === 0 && toolResults.length > 0) {
                const lastResult = toolResults[toolResults.length - 1];
                const existingContent = typeof lastResult.content === 'string' ? lastResult.content : '';
                const reflectionText = REFLECTION_PROMPT
                  .replace('{{N}}', String(iterations))
                  .replace('{{MAX}}', String(MAX_TOOL_LOOP_ITERATIONS));
                toolResults[toolResults.length - 1] = {
                  ...lastResult,
                  content: `${existingContent}\n\n${reflectionText}`,
                };
              }

              // Log side-effecting tool calls to action journal
              for (const block of toolUseBlocks) {
                const toolRev = getToolReversibility(block.name);
                if (toolRev !== 'read_only') {
                  const matchingResult = toolResults.find(r => r.tool_use_id === block.id);
                  const journal = new LocalActionJournalService(this.db, workspaceId);
                  journal.logAction({
                    taskId,
                    agentId,
                    toolName: block.name,
                    toolInput: block.input as Record<string, unknown>,
                    toolOutput: matchingResult ? (typeof matchingResult.content === 'string' ? matchingResult.content : JSON.stringify(matchingResult.content)) : null,
                    reversibility: toolRev,
                  }).catch(() => { /* non-fatal */ });
                }
              }

              // Collect ReAct step
              const reactStep: LocalReActStep = {
                iteration: iterations,
                thought: textContent.trim() ? truncate(textContent, REACT_SUMMARY_MAX_LENGTH) : '',
                actions: toolUseBlocks.map(b => ({
                  tool: b.name,
                  inputSummary: truncate(JSON.stringify(b.input), REACT_SUMMARY_MAX_LENGTH),
                })),
                observations: toolResults.map(r => ({
                  tool: toolUseBlocks.find(b => b.id === r.tool_use_id)?.name || 'unknown',
                  resultSummary: truncate(
                    typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
                    REACT_SUMMARY_MAX_LENGTH,
                  ),
                  success: !r.is_error,
                })),
                durationMs: Date.now() - iterationStart,
                timestamp: new Date().toISOString(),
              };
              reactTrace.push(reactStep);
              this.emit('task:react_step', { taskId, step: reactStep });

              currentMessages = [
                ...currentMessages,
                { role: 'assistant' as const, content: response.content },
                { role: 'user' as const, content: toolResults },
              ];

              // Mid-loop context summarization: check if we're approaching limits
              iterationsSinceSummarize++;
              const utilizationPct = totalInputTokens / contextLimit;
              if (utilizationPct >= CONTEXT_WARNING_THRESHOLD_PCT) {
                logger.warn(`[RuntimeEngine] Context utilization at ${Math.round(utilizationPct * 100)}% for task ${taskId}`);
              }
              if (
                utilizationPct >= CONTEXT_SUMMARIZE_THRESHOLD_PCT &&
                iterationsSinceSummarize >= SUMMARIZE_COOLDOWN_ITERATIONS &&
                currentMessages.length > 6
              ) {
                currentMessages = await summarizeMessages(currentMessages, this.anthropic);
                iterationsSinceSummarize = 0;
              }

              // Save checkpoint after each iteration (fire-and-forget)
              const iterCheckpoint: TaskCheckpoint = {
                version: 1,
                messages: currentMessages,
                iteration: iterations,
                toolCallCount: toolCallHashes.length,
                totalInputTokens,
                totalOutputTokens,
                toolCallHashes,
                elapsedMs: Date.now() - startTime,
                savedAt: new Date().toISOString(),
                reason: 'iteration_save',
              };
              void this.db.from('agent_workforce_tasks').update({
                checkpoint: serializeCheckpoint(iterCheckpoint),
                checkpoint_iteration: iterations,
              }).eq('id', taskId).then(() => {});

              // Check for pause request
              try {
                const { data: pauseCheck } = await this.db
                  .from('agent_workforce_tasks')
                  .select('pause_requested')
                  .eq('id', taskId)
                  .single();
                if (pauseCheck && (pauseCheck as { pause_requested?: number }).pause_requested) {
                  const pauseCheckpoint: TaskCheckpoint = { ...iterCheckpoint, reason: 'pause_requested' };
                  await this.db.from('agent_workforce_tasks').update({
                    checkpoint: serializeCheckpoint(pauseCheckpoint),
                    checkpoint_iteration: iterations,
                    status: 'paused',
                  }).eq('id', taskId);
                  logger.info({ taskId, iteration: iterations }, 'Task paused at checkpoint');
                  return {
                    success: true,
                    taskId,
                    status: 'paused',
                    output: { text: fullContent || textContent },
                    tokensUsed: totalInputTokens + totalOutputTokens,
                    costCents: calculateCostCents(modelId as ClaudeModel, totalInputTokens, totalOutputTokens),
                  };
                }
              } catch { /* non-fatal pause check */ }

              continue;
            }

            fullContent = textContent;
            break;
          }

          // Check for irreversible tools used in Anthropic path
          const irreversibleAnthropicTools = anthropicToolsUsed.filter(
            name => getToolReversibility(name) === 'irreversible'
          );
          if (irreversibleAnthropicTools.length > 0) {
            this.emit('task:warning', {
              taskId,
              warning: 'irreversible_tools_used',
              tools: irreversibleAnthropicTools,
            });
          }
        } else {
          // Simple single call (no tools)
          const response = await this.anthropic!.messages.create({
            model: modelId,
            max_tokens: agentConfig.max_tokens || 4096,
            temperature: agentConfig.temperature ?? 0.7,
            system: systemPrompt,
            messages,
          });

          totalInputTokens = response.usage.input_tokens;
          totalOutputTokens = response.usage.output_tokens;
          this.emit('task:progress', { taskId, tokensUsed: totalInputTokens + totalOutputTokens });

          const textBlocks = response.content.filter((b): b is TextBlock => b.type === 'text');
          fullContent = textBlocks.map(b => b.text).join('\n');
        }
      } finally {
        // Always close the browser after task execution (if it was activated)
        if (browserService) {
          await browserService.close().catch(err => {
            logger.error({ err }, '[RuntimeEngine] Browser cleanup failed');
          });
        }
        // Always close desktop after task execution (if it was activated)
        if (desktopService) {
          await desktopService.close();
        }
        // Close MCP connections
        if (mcpClients) {
          await mcpClients.close().catch(err => {
            logger.error({ err }, '[RuntimeEngine] MCP cleanup failed');
          });
        }
      }

      return await finalizeTaskSuccess.call(this, {
        taskId,
        agentId,
        workspaceId,
        task,
        agent,
        agentConfig,
        fullContent,
        totalInputTokens,
        totalOutputTokens,
        reactTrace,
        providerReportedCostCents,
        useModelRouter,
        modelId,
        startTime,
        traceId,
        taskInput,
        autonomyLevel,
        approvalRequired,
        activeSessionId,
      });
    } catch (error) {
      return await handleTaskFailure.call(this, {
        error,
        taskId,
        agentId,
        workspaceId,
        taskTitle,
        startTime,
      });
    } finally {
      this.semaphore.release();
    }
    }); // end withSpan('agent.execute')
  }

  // summarizeMessages() extracted to ./message-summarization.js

  /**
   * Collect state updates made during this task for cloud sync.
   * Used by both success and failure report paths.
   */
  async collectStateUpdates(
    workspaceId: string, agentId: string, taskStartIso: string,
  ): Promise<import('../control-plane/types.js').TaskReportStateUpdate[]> {
    const { data: stateRows } = await this.db
      .from('agent_workforce_task_state')
      .select('key, value, value_type, scope, scope_id')
      .eq('workspace_id', workspaceId)
      .eq('agent_id', agentId)
      .gte('updated_at', taskStartIso);

    if (!stateRows || (stateRows as unknown[]).length === 0) return [];

    return (stateRows as Array<{ key: string; value: string; value_type: string; scope: string; scope_id: string | null }>).map(r => ({
      key: r.key,
      value: r.value,
      valueType: r.value_type,
      scope: r.scope,
      scopeId: r.scope_id || undefined,
    }));
  }

  /** Returns current task queue status for monitoring */
  getQueueStatus(): { active: number; waiting: number; concurrency: number } {
    return {
      active: this.semaphore.active,
      waiting: this.semaphore.waiting,
      concurrency: this.semaphore.concurrency,
    };
  }

  /** Reject all queued (waiting) tasks immediately. Used during shutdown. */
  drainQueue(reason: string): void {
    const drained = this.semaphore.rejectAll(new Error(reason));
    if (drained > 0) {
      logger.warn(`[RuntimeEngine] Drained ${drained} queued task(s): ${reason}`);
    }
  }

  // ==========================================================================
  // OLLAMA EXECUTION PATH
  // ==========================================================================

  async executeWithModelRouter(opts: {
    systemPrompt: string;
    messages: MessageParam[];
    tools: Array<WebSearchTool20250305 | Tool>;
    maxTokens: number;
    temperature: number;
    taskId: string;
    agentId: string;
    workspaceId: string;
    goalId?: string;
    fileAccessGuard: FileAccessGuard | null;
    approvalRequired: boolean;
    browserEnabled: boolean;
    mcpClients?: McpClientManager | null;
    desktopOptions?: Partial<DesktopServiceOptions>;
    difficulty?: 'simple' | 'moderate' | 'complex';
    gitEnabled?: boolean;
    /** When present, forces tool_choice: 'required' on first iteration */
    skillsDocument?: string;
  }): Promise<{ fullContent: string; totalInputTokens: number; totalOutputTokens: number; reactTrace: LocalReActStep[]; providerCostCents?: number; actualModelUsed?: string }> {
    // Query routing stats for adaptive model selection
    let routingHistory: import('./model-router.js').RoutingHistory | undefined;
    try {
      const { data: stats } = await this.db
        .from('agent_workforce_routing_stats')
        .select('avg_truth_score, attempts')
        .eq('agent_id', opts.agentId)
        .order('attempts', { ascending: false })
        .limit(1);
      if (stats && stats.length > 0) {
        const row = stats[0] as Record<string, unknown>;
        routingHistory = {
          avgTruthScore: (row.avg_truth_score as number) || 0,
          attempts: (row.attempts as number) || 0,
        };
      }
    } catch { /* routing stats table may not exist yet */ }

    // BPP-aware model selection: use brain confidence when available
    const provider = await this.modelRouter!.selectModelWithContext('agent_task', {
      selfModelConfidence: this.brain?.predictiveEngine?.getToolSuccessRate('agent_task'),
      routingHistory,
      difficulty: opts.difficulty,
    });

    // Agents never pin a model — the router picks dynamically per iteration
    // via `selectAgentModelForIteration`, combining difficulty, iteration
    // index, SOP presence, and vision needs.
    const needsVision = false; // TODO: detect from task/tools when vision tasks are supported
    let actualModelUsed: string | undefined;

    // Filter to client tools only (exclude Anthropic server-side tools like web_search)
    const clientTools = opts.tools.filter(
      (t): t is Tool => 'input_schema' in t,
    );
    const openaiTools = convertToolsToOpenAI(clientTools);

    // Build OpenAI-format message history
    type OllamaMessage = {
      role: 'user' | 'assistant' | 'system' | 'tool';
      content: string;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
      tool_call_id?: string;
    };

    const loopMessages: OllamaMessage[] = opts.messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let providerCostCents = 0;
    let fullContent = '';
    const reactTrace: LocalReActStep[] = [];

    // Browser and desktop state for on-demand activation
    let browserService: LocalBrowserService | null = null;
    let browserActivated = false;
    let desktopService: import('./desktop/local-desktop.service.js').LocalDesktopService | null = null;
    let desktopActivated = false;
    let iteration = 0;
    let consecutiveParseErrors = 0;
    let toolLoopAborted = false;
    const toolCallHashes: string[] = [];
    const routerToolsUsed: string[] = [];
    try {
      for (; iteration < MAX_TOOL_LOOP_ITERATIONS; iteration++) {
        const iterationStart = Date.now();
        // Build active tool list (may include browser tools after activation)
        const activeTools = browserActivated
          ? [...openaiTools.filter(t => t.function.name !== 'request_browser'), ...convertToolsToOpenAI(BROWSER_TOOL_DEFINITIONS)]
          : openaiTools;

        let response: ModelResponseWithTools;
        try {
          const providerWithTools = provider as ModelProvider & { createMessageWithTools?: typeof provider.createMessageWithTools };
          if (!providerWithTools.createMessageWithTools) {
            // Provider doesn't support tools — text-only fallback.
            // No model pin: let the provider use its configured default.
            const textResponse = await provider.createMessage({
              system: opts.systemPrompt,
              messages: loopMessages.map(m => ({
                role: m.role === 'tool' ? 'user' : m.role,
                content: m.content,
              })),
              maxTokens: opts.maxTokens,
              temperature: opts.temperature,
            });
            return {
              fullContent: textResponse.content,
              totalInputTokens: textResponse.inputTokens,
              totalOutputTokens: textResponse.outputTokens,
              reactTrace: [],
            };
          }

          // Dynamic per-iteration model selection.
          // Agents never pin — the router picks across tiers based on
          // iteration index, difficulty, error signal, SOP presence, and
          // vision requirements.
          const iterModel = selectAgentModelForIteration(
            iteration, opts.difficulty, consecutiveParseErrors > 0, !!opts.skillsDocument,
            needsVision, provider,
          );
          if (!actualModelUsed && iterModel) actualModelUsed = iterModel;
          logger.debug({ model: iterModel, iteration, provider: provider.name, difficulty: opts.difficulty }, '[engine] agent iteration model');

          // Force first tool call when SOP procedures are in the prompt
          // (iteration 0 + skillsDocument present = model MUST call a tool)
          const forceToolCall = iteration === 0 && opts.skillsDocument;
          response = await providerWithTools.createMessageWithTools({
            system: opts.systemPrompt,
            messages: loopMessages.map(m => ({
              role: m.role === 'tool' ? 'user' : m.role,
              content: m.content,
            })),
            maxTokens: opts.maxTokens,
            temperature: forceToolCall ? 0.3 : opts.temperature, // Lower temp for forced tool calls
            tools: activeTools,
            model: iterModel,
            toolChoice: forceToolCall ? 'required' : 'auto',
          } as Parameters<typeof providerWithTools.createMessageWithTools>[0]);
        } catch (err) {
          // Credit exhaustion: fall back to local Ollama and emit event
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.toLowerCase().includes('insufficient credits') || errMsg.toLowerCase().includes('credit') && errMsg.toLowerCase().includes('exhaust')) {
            if (this.modelRouter) {
              this.modelRouter.setCreditBalance(0);
            }
            this.emitter?.emit('credits:exhausted');
            logger.warn('[engine] Cloud credits exhausted, falling back to local model');
            // Try local Ollama as fallback
            const ollamaAvailable = this.modelRouter ? await this.modelRouter.isOllamaAvailable() : false;
            if (ollamaAvailable) {
              const localProvider = this.modelRouter!.getOllamaProvider()!;
              const textResponse = await localProvider.createMessage({
                system: opts.systemPrompt,
                messages: loopMessages.map(m => ({
                  role: m.role === 'tool' ? 'user' : m.role,
                  content: m.content,
                })),
                maxTokens: opts.maxTokens,
                temperature: opts.temperature,
              });
              return {
                fullContent: textResponse.content,
                totalInputTokens: textResponse.inputTokens,
                totalOutputTokens: textResponse.outputTokens,
                reactTrace: [],
              };
            }
          }
          // If tool calling fails on first iteration, fall back to text-only
          if (iteration === 0) {
            const textResponse = await provider.createMessage({
              system: opts.systemPrompt,
              messages: loopMessages.map(m => ({
                role: m.role === 'tool' ? 'user' : m.role,
                content: m.content,
              })),
              maxTokens: opts.maxTokens,
              temperature: opts.temperature,
            });
            return {
              fullContent: textResponse.content,
              totalInputTokens: textResponse.inputTokens,
              totalOutputTokens: textResponse.outputTokens,
              reactTrace: [],
            };
          }
          throw err;
        }

        totalInputTokens += response.inputTokens;
        totalOutputTokens += response.outputTokens;
        if (response.costCents) providerCostCents += response.costCents;
        this.emit('task:progress', { taskId: opts.taskId, tokensUsed: totalInputTokens + totalOutputTokens });

        if (response.content) {
          fullContent = response.content;
        }

        // Log tool call status for debugging
        logger.debug({
          iteration,
          toolCallCount: response.toolCalls?.length ?? 0,
          hasContent: !!response.content,
          contentPreview: response.content?.slice(0, 100),
          model: response.model,
        }, '[engine] agent iteration response');

        // No tool calls = done
        if (!response.toolCalls || response.toolCalls.length === 0) {
          break;
        }

        // Append assistant message with tool calls
        loopMessages.push({
          role: 'assistant',
          content: response.content || '',
          tool_calls: response.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: tc.function,
          })),
        });

        // Execute each tool call
        for (const toolCall of response.toolCalls) {
          const toolName = toolCall.function.name;

          if (!toolName) {
            const errorMsg = 'Tool call missing function name. Provide a valid tool name.';
            logger.warn(`[RuntimeEngine] ${errorMsg}`);
            loopMessages.push({ role: 'tool', content: errorMsg, tool_call_id: toolCall.id });
            continue;
          }

          const parsed = parseToolArguments(toolCall.function.arguments, toolName);
          if (parsed.error) {
            logger.warn(`[RuntimeEngine] ${parsed.error}`);
            loopMessages.push({
              role: 'tool',
              content: parsed.error,
              tool_call_id: toolCall.id,
            });
            consecutiveParseErrors++;
            if (consecutiveParseErrors >= 3) {
              fullContent += '\n\n[Agent had repeated trouble calling tools and stopped.]';
              toolLoopAborted = true;
              break;
            }
            continue;
          }
          consecutiveParseErrors = 0;
          const toolInput = parsed.args;

          // Dispatch tool via registry
          const routerToolCtx = this.buildToolContext({
            taskId: opts.taskId,
            agentId: opts.agentId,
            workspaceId: opts.workspaceId,
            goalId: opts.goalId,
            browserService,
            browserActivated,
            desktopService: desktopService,
            desktopActivated,
            desktopOptions: opts.desktopOptions,
            fileAccessGuard: opts.fileAccessGuard,
            mcpClients: opts.mcpClients ?? null,
            gitEnabled: opts.gitEnabled,
          });
          const toolResult = await this.dispatchTool(toolName, toolInput, routerToolCtx);

          // Sync browser state back from context
          if (toolResult.browserActivated && !browserActivated) {
            browserService = routerToolCtx.browserService;
            browserActivated = true;
          }

          // Sync desktop state back from context (request_desktop activates desktop tools)
          if (routerToolCtx.desktopActivated && !desktopActivated) {
            desktopService = routerToolCtx.desktopService;
            desktopActivated = true;
            // Remove request_desktop from tool list and add full desktop tools
            const reqIdx = openaiTools.findIndex(t => t.function.name === 'request_desktop');
            if (reqIdx >= 0) openaiTools.splice(reqIdx, 1);
            openaiTools.push(...convertToolsToOpenAI(DESKTOP_TOOL_DEFINITIONS));
            logger.info('[engine] Desktop activated in model router path — desktop tools injected');
          }

          // Expand FileAccessGuard when doc mounts add new paths
          if (toolResult.mountedDocPaths?.length && opts.fileAccessGuard) {
            const currentPaths = opts.fileAccessGuard.getAllowedPaths();
            const expanded = [...currentPaths, ...toolResult.mountedDocPaths];
            opts.fileAccessGuard = new FileAccessGuard(expanded);
          }

          // Flatten content to string for Ollama format
          let resultContent: string;
          if (typeof toolResult.content === 'string') {
            resultContent = toolResult.is_error ? `Error: ${toolResult.content}` : toolResult.content;
          } else {
            resultContent = toolResult.content.map(b => 'text' in b ? b.text : JSON.stringify(b)).join('\n');
          }

          // Track tool name for reversibility check
          routerToolsUsed.push(toolName);

          // Brain: record tool execution
          const toolSuccess = !resultContent.startsWith('Error:');
          this.brain.recordToolExecution(toolName, toolInput, toolSuccess);
          toolCallHashes.push(hashToolCall(toolName, toolInput));

          loopMessages.push({
            role: 'tool',
            content: resultContent,
            tool_call_id: toolCall.id,
          });
        }

        // Collect ReAct step for Ollama iteration
        if (response.toolCalls && response.toolCalls.length > 0) {
          const reactStep: LocalReActStep = {
            iteration: iteration + 1,
            thought: truncate(response.content || '', REACT_SUMMARY_MAX_LENGTH),
            actions: response.toolCalls.map(tc => ({
              tool: tc.function.name,
              inputSummary: truncate(tc.function.arguments, REACT_SUMMARY_MAX_LENGTH),
            })),
            observations: response.toolCalls.map(tc => {
              const toolMsg = loopMessages.find(
                m => m.role === 'tool' && m.tool_call_id === tc.id,
              );
              return {
                tool: tc.function.name,
                resultSummary: truncate(toolMsg?.content || '', REACT_SUMMARY_MAX_LENGTH),
                success: !toolMsg?.content.startsWith('Error:'),
              };
            }),
            durationMs: Date.now() - iterationStart,
            timestamp: new Date().toISOString(),
          };
          reactTrace.push(reactStep);
          this.emit('task:react_step', { taskId: opts.taskId, step: reactStep });
        }

        if (toolLoopAborted) break;

        // Brain: enriched stagnation warning (Ollama path)
        if (this.brain.isStagnating()) {
          const lastMsg = loopMessages[loopMessages.length - 1];
          if (lastMsg.role === 'tool') {
            lastMsg.content = `${lastMsg.content}\n\n${this.brain.buildStagnationWarning()}`;
          }
        }

        // Inject reflection prompt every 5 iterations
        if ((iteration + 1) % 5 === 0) {
          const lastMsg = loopMessages[loopMessages.length - 1];
          if (lastMsg.role === 'tool') {
            const reflectionText = REFLECTION_PROMPT
              .replace('{{N}}', String(iteration + 1))
              .replace('{{MAX}}', String(MAX_TOOL_LOOP_ITERATIONS));
            lastMsg.content = `${lastMsg.content}\n\n${reflectionText}`;
          }
        }
      }

      if (iteration >= MAX_TOOL_LOOP_ITERATIONS) {
        logger.warn(`[RuntimeEngine] Tool loop hit ${MAX_TOOL_LOOP_ITERATIONS} iteration limit for task ${opts.taskId}`);
        fullContent += '\n\n[Agent reached the maximum number of tool calls and stopped.]';
      }
    } finally {
      if (browserService) {
        await browserService.close().catch(err => {
          logger.error({ err }, '[RuntimeEngine] Browser cleanup failed');
        });
      }
      if (desktopService) {
        await desktopService.close().catch((err: unknown) => {
          logger.error({ err }, '[RuntimeEngine] Desktop cleanup failed');
        });
      }
    }

    // Check for irreversible tools used in Ollama path
    const irreversibleTools = routerToolsUsed.filter(
      name => getToolReversibility(name) === 'irreversible'
    );
    if (irreversibleTools.length > 0) {
      this.emit('task:warning', {
        taskId: opts.taskId,
        warning: 'irreversible_tools_used',
        tools: irreversibleTools,
      });
    }

    return { fullContent, totalInputTokens, totalOutputTokens, reactTrace, providerCostCents: providerCostCents || undefined, actualModelUsed };
  }

  // ==========================================================================
  // MEMORY COMPILATION (simplified, self-contained)
  // ==========================================================================

  async compileMemory(agentId: string, workspaceId: string, taskTitle: string): Promise<string> {
    try {
      const relevantMemories = await retrieveRelevantMemories({
        db: this.db,
        workspaceId,
        query: taskTitle,
        limit: 10,
        agentId,
      });

      // Recent task summaries (recency data, not scored)
      const { data: recentTasks } = await this.db
        .from<{ title: string; status: string }>('agent_workforce_tasks')
        .select('title, status')
        .eq('agent_id', agentId)
        .order('created_at', { ascending: false })
        .limit(5);

      if (relevantMemories.length === 0 && (!recentTasks || recentTasks.length === 0)) {
        return '';
      }

      const sections: string[] = ['## Agent Memory'];

      // Partition by trust level
      const verified = relevantMemories.filter(m => m.trustLevel === 'verified');
      const learned = relevantMemories.filter(m => m.trustLevel !== 'verified');

      const formatGroup = (memories: typeof relevantMemories): string[] => {
        const lines: string[] = [];
        const facts = memories.filter(m => m.memoryType === 'fact');
        const skills = memories.filter(m => m.memoryType === 'skill');
        const positive = memories.filter(m => m.memoryType === 'feedback_positive');
        const negative = memories.filter(m => m.memoryType === 'feedback_negative');

        if (facts.length > 0) lines.push(...facts.map(f => `- ${f.content}`));
        if (skills.length > 0) lines.push(...skills.map(s => `- ${s.content}`));
        if (positive.length > 0) lines.push(...positive.map(f => `[+] ${f.content}`));
        if (negative.length > 0) lines.push(...negative.map(f => `[-] ${f.content}`));
        return lines;
      };

      if (verified.length > 0) {
        sections.push('### Verified Knowledge');
        sections.push(...formatGroup(verified));
      }

      if (learned.length > 0) {
        sections.push('### Learned Patterns (may need verification)');
        sections.push(...formatGroup(learned));
      }

      if (recentTasks && recentTasks.length > 0) {
        const taskSummaries = (recentTasks ?? [])
          .map(t => `- ${t.title} (${t.status})`)
          .join('\n');
        sections.push(`### Recent Tasks\n${taskSummaries}`);
      }

      // Device-pinned memories: fetch from remote devices if fetcher is available
      if (this.deviceFetcher) {
        try {
          const { searchManifest } = await import('../data-locality/manifest.js');
          const keywords = taskTitle.toLowerCase().split(/\s+/).filter(w => w.length > 3);
          if (keywords.length > 0) {
            const matches = await searchManifest(this.db, workspaceId, keywords, { dataType: 'memory', limit: 3 });
            const pinnedLines: string[] = [];
            for (const match of matches) {
              try {
                const result = await this.deviceFetcher.fetch(match.dataId);
                const data = result.data as Record<string, unknown> | null;
                if (data?.content) pinnedLines.push(`- ${data.content}`);
              } catch { /* device offline or denied */ }
            }
            if (pinnedLines.length > 0) {
              sections.push(`### Device-Pinned Knowledge (ephemeral)\n${pinnedLines.join('\n')}`);
            }
          }
        } catch { /* non-fatal */ }
      }

      return sections.join('\n\n');
    } catch (err) {
      logger.error({ err }, '[RuntimeEngine] Memory compilation failed');
      return '';
    }
  }

  // ==========================================================================
  // KNOWLEDGE COMPILATION (simplified, same budget-aware approach)
  // ==========================================================================

  async compileKnowledge(agentId: string, workspaceId: string, taskTitle: string, taskDescription?: string | null): Promise<string> {
    try {
      const query = taskDescription ? `${taskTitle} ${taskDescription}` : taskTitle;
      const chunks = await retrieveKnowledgeChunks({
        db: this.db,
        workspaceId,
        agentId,
        query,
        tokenBudget: 8000,
        maxChunks: 12,
      });

      if (chunks.length === 0) return '';

      const sections = chunks.map(c => `### ${c.documentTitle}\n${c.content}`);
      return `## Knowledge Base\n\n${sections.join('\n\n')}`;
    } catch (err) {
      logger.error({ err }, '[RuntimeEngine] Knowledge compilation failed');
      return '';
    }
  }

  // extractMemories() extracted to ./memory-sync.js

  /**
   * Compile relevant skills/SOPs for an agent's task.
   *
   * DEPRECATED — early-returns an empty string. This method used to
   * load `agent_workforce_skills` rows, filter them by `agent_ids`,
   * run `matchesTriggers(skill.triggers, extractKeywords(taskTitle))`
   * as a keyword match, and inject the top 5 matches into the agent's
   * system prompt as a "## Matched SOPs" section. That path produced
   * the launch-eve regression where a file-rewrite task matched the
   * word "write" and got a desktop-SOP injection.
   *
   * Full rationale and removal plan at
   * /Users/jesus/.claude/plans/idempotent-tumbling-flame.md.
   *
   * Skills are now discovered exclusively by the LLM from its tool
   * list via `runtimeToolRegistry.getToolDefinitions()` merged into
   * the orchestrator's getTools() output. Keyword matching on the
   * task title is never used for skill discovery in the runtime.
   *
   * The method signature is preserved (returning an empty string) so
   * `runTask` callers don't need to be edited in this refactor. A
   * follow-up pass can remove the call site and drop this method.
   */
  async compileSkills(_agentId: string, _workspaceId: string, _taskTitle: string): Promise<string> {
    return '';
  }

}
