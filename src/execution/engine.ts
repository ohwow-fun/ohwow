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
  BROWSER_SYSTEM_PROMPT,
  REQUEST_BROWSER_TOOL,
} from './browser/index.js';
import {
  LocalDesktopService,
  DESKTOP_TOOL_DEFINITIONS,
  REQUEST_DESKTOP_TOOL,
} from './desktop/index.js';
import type { DesktopServiceOptions } from './desktop/index.js';
import {
  DRAFT_TOOL_DEFINITIONS,
  DRAFT_TOOL_PROMPT_HINT,
} from './draft-tools.js';
import {
  ScraplingService,
  SCRAPLING_TOOL_DEFINITIONS,
  SCRAPLING_SYSTEM_PROMPT,
} from './scrapling/index.js';
import { parseToolArguments } from './tool-parse.js';
import { Semaphore } from './semaphore.js';
import {
  FileAccessGuard,
  FILESYSTEM_TOOL_DEFINITIONS,
  FILESYSTEM_SYSTEM_PROMPT,
} from './filesystem/index.js';
import {
  BASH_TOOL_DEFINITIONS,
  BASH_SYSTEM_PROMPT,
} from './bash/index.js';
import { DEVOPS_SYSTEM_PROMPT } from './devops/devops-prompts.js';
import {
  DocMountManager,
  DOC_MOUNT_TOOL_DEFINITIONS,
  DOC_MOUNT_SYSTEM_PROMPT,
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
import { scoreDifficulty } from './difficulty-scorer.js';
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
  private anthropic: Anthropic | null;
  private emitter: TypedEventBus<RuntimeEvents> | null;
  private modelRouter: ModelRouter | null;
  private scraplingService: ScraplingService;
  private semaphore: Semaphore;
  private pendingElicitations = new Map<string, (result: Record<string, unknown> | null) => void>();
  private circuitBreaker = new CircuitBreaker();
  private toolRegistry = createDefaultToolRegistry();
  private docMountManager: DocMountManager;
  /** Brain: unified cognitive coordinator for agent task execution. */
  private brain = new Brain({ modelRouter: null });
  private taskDistributor: import('../peers/task-distributor.js').TaskDistributor | null = null;
  private ccSessionStore: ClaudeCodeSessionStore | null = null;
  private deviceFetcher: import('../data-locality/fetch-client.js').DeviceDataFetcher | null = null;

  /** Set the device data fetcher for device-pinned memory retrieval */
  setDeviceFetcher(fetcher: import('../data-locality/fetch-client.js').DeviceDataFetcher): void {
    this.deviceFetcher = fetcher;
  }

  constructor(
    private db: DatabaseAdapter,
    private config: EngineConfig,
    private effects: RuntimeEffects,
    private businessContext: BusinessContext,
    emitter?: TypedEventBus<RuntimeEvents>,
    modelRouter?: ModelRouter,
    scraplingService?: ScraplingService,
  ) {
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
  private emit(event: string, data: unknown): void {
    this.emitter?.emit(event, data);
  }

  /** Build a ToolExecutionContext for the current task */
  private buildToolContext(opts: {
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
    };
  }

  /** Dispatch a tool call via the registry */
  private async dispatchTool(
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
  private async shouldUseClaudeCodeCli(agentConfig: Record<string, unknown>): Promise<boolean> {
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
  private async executeWithClaudeCodeCliPath(opts: {
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
      const { type: responseType, cleanContent } = this.parseResponseMeta(content);

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
  async executeTask(agentId: string, taskId: string): Promise<ExecuteAgentResult> {
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
      const [memoryDoc, knowledgeDoc, skillsDoc] = await Promise.all([
        this.compileMemory(agentId, workspaceId, task.title),
        this.compileKnowledge(agentId, workspaceId, task.title, task.description),
        this.compileSkills(agentId, workspaceId, task.title),
      ]);

      // 4. Build system prompt
      const webSearchEnabled = agentConfig.web_search_enabled !== false;
      const browserEnabled = agentConfig.browser_enabled !== false; // opt-out: default true
      const autonomyLevel: number = agentConfig.autonomy_level ?? 2;
      const approvalRequired = autonomyLevel === 1;

      const scraplingEnabled = agentConfig.scraping_enabled !== false;
      const localFilesEnabled = agentConfig.local_files_enabled === true;
      const bashEnabled = agentConfig.bash_enabled === true;
      const mcpEnabled = agentConfig.mcp_enabled === true;
      const devopsEnabled = agentConfig.devops_enabled === true;
      const desktopEnabled = agentConfig.desktop_enabled === true;
      const desktopRecordingEnabled = agentConfig.desktop_recording_enabled === true;
      const desktopPreActionScreenshots = agentConfig.desktop_pre_action_screenshots === true;
      const desktopAllowedApps: string[] = agentConfig.desktop_allowed_apps ?? [];
      const agentMcpServers: McpServerConfig[] = agentConfig.mcp_servers ?? [];

      // Auto-inject GitHub MCP server for devops-enabled agents
      if (devopsEnabled && mcpEnabled) {
        const hasGitHub = agentMcpServers.some(s => s.name === 'github');
        if (!hasGitHub && process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
          agentMcpServers.push({
            name: 'github',
            transport: 'stdio' as const,
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN },
          });
        }
      }

      // Desktop service options (passed via buildToolContext → request-desktop-executor)
      const desktopOptions: Partial<DesktopServiceOptions> = {
        enableRecording: desktopRecordingEnabled,
        enablePreActionScreenshots: desktopPreActionScreenshots,
        allowedApps: desktopAllowedApps,
        autonomyLevel,
      };

      // Load file access guard if enabled
      let fileAccessGuard: FileAccessGuard | null = null;
      if (localFilesEnabled) {
        const { data: pathData } = await this.db
          .from('agent_file_access_paths')
          .select('path')
          .eq('agent_id', agentId);

        const paths = pathData
          ? (pathData as Array<{ path: string }>).map((p) => p.path)
          : [];

        if (paths.length > 0) {
          fileAccessGuard = new FileAccessGuard(paths);
        }
      }

      // Auto-mount declared documentation for this agent
      const mountedDocs: string[] = (() => {
        try {
          const raw = agentConfig.mounted_docs;
          if (Array.isArray(raw)) return raw as string[];
          if (typeof raw === 'string') return JSON.parse(raw) as string[];
          return [];
        } catch { return []; }
      })();

      if (mountedDocs.length > 0) {
        for (const docUrl of mountedDocs) {
          try {
            const existing = await this.docMountManager.getMountByUrl(docUrl, workspaceId);
            if (existing && existing.status === 'ready') {
              // Already mounted — expand file access
              const current = fileAccessGuard?.getAllowedPaths() ?? [];
              fileAccessGuard = new FileAccessGuard([...current, existing.mountPath]);
            } else if (!existing) {
              // Mount in background — don't block task start
              this.docMountManager.mount(docUrl, workspaceId).catch((err) => {
                logger.warn({ err, url: docUrl }, '[engine] Background doc mount failed');
              });
            } else if (existing.status === 'stale' || existing.status === 'failed') {
              // Stale/failed — still serve from disk if available, refresh in background
              const current = fileAccessGuard?.getAllowedPaths() ?? [];
              fileAccessGuard = new FileAccessGuard([...current, existing.mountPath]);
              this.docMountManager.refreshIfStale(existing.id).catch((err) => {
                logger.warn({ err, url: docUrl }, '[engine] Background doc refresh failed');
              });
            }
          } catch (err) {
            logger.warn({ err, url: docUrl }, '[engine] Auto-mount check failed');
          }
        }
      }

      // Load goal context if task is linked to a goal
      let goalContext: string | undefined;
      if (task.goal_id) {
        const { data: goalData } = await this.db
          .from('agent_workforce_goals')
          .select('title, description, target_metric, target_value, current_value, unit')
          .eq('id', task.goal_id)
          .single();

        if (goalData) {
          const g = goalData as { title: string; description?: string; target_metric?: string; target_value?: number; current_value?: number; unit?: string };
          const parts = [`## Strategic Goal\nThis task contributes to: "${g.title}"`];
          if (g.description) parts.push(`Why: ${g.description}`);
          if (g.target_metric) {
            parts.push(`Target: ${g.current_value ?? 0}${g.unit || ''} \u2192 ${g.target_value}${g.unit || ''} (${g.target_metric})`);
          }
          parts.push('Keep this goal in mind when making decisions about scope, tone, and priorities.');
          goalContext = parts.join('\n');
        }
      }

      // Scan user-provided fields for injection attempts (log-only)
      scanForInjection(
        { title: task.title, description: task.description, input: typeof task.input === 'string' ? task.input : null },
        { taskId, agentId },
      );

      let systemPrompt = this.buildSystemPrompt({
        agentName: agent.name,
        agentRole: agent.role,
        agentPrompt: agent.system_prompt,
        taskTitle: task.title,
        taskDescription: task.description || undefined,
        memoryDocument: memoryDoc || undefined,
        knowledgeDocument: knowledgeDoc || undefined,
        skillsDocument: skillsDoc || undefined,
        webSearchEnabled,
        browserEnabled: false, // Browser instructions injected on-demand, not upfront
        scraplingEnabled,
        localFilesEnabled: localFilesEnabled && fileAccessGuard !== null,
        bashEnabled: bashEnabled && fileAccessGuard !== null,
        devopsEnabled,
        desktopEnabled,
        approvalRequired,
        goalContext,
      });

      // 4.1 Inject persistent state context
      try {
        const stateDoc = await loadStateContext(this.db, workspaceId, agentId, task.goal_id || undefined);
        if (stateDoc) {
          systemPrompt += `\n\n${stateDoc}`;
        }
      } catch {
        logger.warn('[RuntimeEngine] State context injection skipped');
      }

      // 4.1b Inject previous task context for cross-task continuity
      try {
        const prevContext = await loadPreviousTaskContext(this.db, workspaceId, agentId, taskId);
        if (prevContext) {
          systemPrompt += `\n\n${prevContext}`;
        }
      } catch {
        logger.warn('[RuntimeEngine] Previous task context injection skipped');
      }

      // 4.1c Inject parent task output for dependency chains
      if (task.parent_task_id) {
        try {
          const { data: parentData } = await this.db
            .from('agent_workforce_tasks')
            .select('title, output')
            .eq('id', task.parent_task_id)
            .single();
          if (parentData) {
            const parent = parentData as { title: string; output: string | unknown };
            const parentOutput = typeof parent.output === 'string'
              ? parent.output
              : JSON.stringify(parent.output);
            const trimmed = parentOutput.length > 4000
              ? parentOutput.slice(0, 4000) + '...'
              : parentOutput;
            systemPrompt += `\n\n## Parent Task Output\nFrom task "${parent.title}":\n\n${trimmed}`;
          }
        } catch {
          logger.warn('[RuntimeEngine] Parent task context injection skipped');
        }
      }

      // 4.2 Inject cross-session working memory
      let activeSessionId: string | null = null;
      try {
        // Expire stale sessions
        await this.db
          .from('agent_workforce_sessions')
          .update({ status: 'expired' })
          .eq('workspace_id', workspaceId)
          .eq('agent_id', agentId)
          .eq('status', 'active')
          .lt('expires_at', new Date().toISOString());

        // Find active session
        const { data: sessionData } = await this.db
          .from('agent_workforce_sessions')
          .select('*')
          .eq('workspace_id', workspaceId)
          .eq('agent_id', agentId)
          .eq('status', 'active')
          .order('last_active_at', { ascending: false })
          .limit(1)
          .single();

        if (sessionData && sessionData.context_summary) {
          activeSessionId = sessionData.id as string;
          systemPrompt += `\n\n## Recent Session Context\n${sessionData.context_summary}`;
          await this.db
            .from('agent_workforce_tasks')
            .update({ session_id: activeSessionId })
            .eq('id', taskId);
        } else if (sessionData) {
          activeSessionId = sessionData.id as string;
          await this.db
            .from('agent_workforce_tasks')
            .update({ session_id: activeSessionId })
            .eq('id', taskId);
        } else {
          // Create new session
          const { data: newSession } = await this.db
            .from('agent_workforce_sessions')
            .insert({
              workspace_id: workspaceId,
              agent_id: agentId,
              title: task.title,
            })
            .select('id')
            .single();

          if (newSession) {
            activeSessionId = newSession.id as string;
            await this.db
              .from('agent_workforce_tasks')
              .update({ session_id: activeSessionId })
              .eq('id', taskId);
          }
        }
      } catch {
        // Session context is best-effort; don't fail the task
        logger.warn('[RuntimeEngine] Session context injection skipped');
      }

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
      const modelId = MODEL_MAP[agentConfig.model as ClaudeModel] || MODEL_MAP['claude-sonnet-4-5'];

      // Connect MCP clients (global servers merged with per-agent servers)
      let mcpClients: McpClientManager | null = null;
      if (mcpEnabled) {
        // Global servers: config file takes precedence; fall back to runtime_settings table
        let globalServers: McpServerConfig[] = this.config.mcpServers ?? [];
        if (globalServers.length === 0) {
          const { data: mcpSetting } = await this.db
            .from('runtime_settings')
            .select('value')
            .eq('key', 'global_mcp_servers')
            .maybeSingle();
          if (mcpSetting) {
            try {
              globalServers = JSON.parse((mcpSetting as { value: string }).value) as McpServerConfig[];
            } catch {
              globalServers = [];
            }
          }
        }
        const allServers = [...globalServers, ...agentMcpServers];
        if (allServers.length > 0) {
          mcpClients = await McpClientManager.connect(allServers, {
            onElicitation: async (serverName, message, schema) => {
              const requestId = crypto.randomUUID();
              this.emit('mcp:elicitation', { requestId, taskId, serverName, message, schema });
              return new Promise<Record<string, unknown> | null>((resolve) => {
                this.pendingElicitations.set(requestId, resolve);
                // Auto-decline after 5 minutes to prevent indefinite hangs
                setTimeout(() => {
                  if (this.pendingElicitations.has(requestId)) {
                    this.pendingElicitations.delete(requestId);
                    resolve(null);
                  }
                }, 5 * 60 * 1000);
              });
            },
          });
        }
      }

      // Build combined tool list — request_browser is lightweight, included by default
      let tools: Array<WebSearchTool20250305 | Tool> = [];
      // State tools always available — agents need cross-task persistence
      tools.push(...STATE_TOOL_DEFINITIONS);
      if (webSearchEnabled) tools.push(WEB_SEARCH_TOOL);
      if (browserEnabled) tools.push(REQUEST_BROWSER_TOOL);
      if (desktopEnabled) tools.push(REQUEST_DESKTOP_TOOL);
      // When real Chrome is available via CDP, skip Scrapling — Chrome handles
      // both public and authenticated pages. Scrapling is only useful as a
      // lightweight fallback when no browser is available.
      const useScrapling = scraplingEnabled && this.config.browserTarget !== 'chrome';
      if (useScrapling) tools.push(...SCRAPLING_TOOL_DEFINITIONS);
      if (useScrapling) tools.push(...DOC_MOUNT_TOOL_DEFINITIONS);
      if (localFilesEnabled && fileAccessGuard) tools.push(...FILESYSTEM_TOOL_DEFINITIONS);
      if (bashEnabled && fileAccessGuard) tools.push(...BASH_TOOL_DEFINITIONS);
      if (approvalRequired) tools.push(...DRAFT_TOOL_DEFINITIONS);
      if (mcpClients) tools.push(...mcpClients.getToolDefinitions());

      // Per-agent tool scoping: filter tools by allowlist/blocklist
      const allowedTools = agentConfig.allowed_tools as string[] | undefined;
      const blockedTools = agentConfig.blocked_tools as string[] | undefined;
      if (allowedTools?.length) {
        const allowSet = new Set(allowedTools);
        tools = tools.filter(t => 'name' in t && allowSet.has(t.name));
      } else if (blockedTools?.length) {
        const blockSet = new Set(blockedTools);
        tools = tools.filter(t => !('name' in t) || !blockSet.has(t.name));
      }

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

      // Decide execution path: model router (OpenRouter/Ollama/etc) vs direct Anthropic SDK
      // Use model router when: no Anthropic API key, OR agent has a non-Claude model
      const agentModelIsLocal = agentConfig.model
        && !(agentConfig.model as string).startsWith('claude-');
      const useModelRouter = agentModelIsLocal
        ? !!this.modelRouter
        : !this.config.anthropicApiKey && !!this.modelRouter;
      if (!useModelRouter && !this.anthropic) {
        throw new Error(`Agent "${agent.name}" requires an Anthropic API key for model ${agentConfig.model || 'claude-sonnet-4-5'}, but none is configured. Add a key in Settings or switch the agent to a local model.`);
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

      // Score task difficulty for model routing
      const difficulty = scoreDifficulty({
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
            agentModel: agentConfig.model as string | undefined,
            skillsDocument: skillsDoc || undefined,
          });
          fullContent = routerResult.fullContent;
          totalInputTokens = routerResult.totalInputTokens;
          totalOutputTokens = routerResult.totalOutputTokens;
          reactTrace = routerResult.reactTrace;
          providerReportedCostCents = routerResult.providerCostCents;
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

      // Parse response classification
      const { type: responseType, cleanContent } = this.parseResponseMeta(fullContent);

      const totalTokens = totalInputTokens + totalOutputTokens;
      // Use provider-reported cost (OpenRouter) when available, otherwise estimate
      const costCents = providerReportedCostCents
        ? providerReportedCostCents
        : useModelRouter
        ? 0
        : calculateCostCents(
            (agentConfig.model as ClaudeModel) || 'claude-sonnet-4-5',
            totalInputTokens,
            totalOutputTokens,
          );
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);

      // Run verifier check (opt-in, requires Anthropic key)
      let verifierEscalated = false;
      if (
        agentConfig.verifier_enabled === true &&
        this.config.anthropicApiKey &&
        cleanContent.length >= 100
      ) {
        try {
          const taskInputStr = typeof task.input === 'string'
            ? task.input
            : JSON.stringify(task.input ?? '');
          const verification = await verifyAgentOutputLocal(
            taskInputStr,
            cleanContent,
            [], // local engine tool summaries not tracked in this format
            { anthropicApiKey: this.config.anthropicApiKey },
          );
          if (verification && !verification.pass && verification.score < 0.5) {
            verifierEscalated = true;
          }
        } catch { /* non-fatal */ }
      }

      // Autonomy-level-based status routing
      let finalStatus: 'completed' | 'needs_approval' = 'completed';

      // L1 (Observer): All non-informational actions need approval
      if (autonomyLevel === 1) {
        finalStatus = responseType === 'informational' ? 'completed' : 'needs_approval';
      }

      // L2 (Supervised): Deliverable outputs need approval
      if (autonomyLevel <= 2 && responseType === 'deliverable') {
        finalStatus = 'needs_approval';
      }

      // L1-L3: Verifier escalation
      if (autonomyLevel <= 3 && verifierEscalated) {
        finalStatus = 'needs_approval';
      }

      // 7. Save output
      await this.db.from('agent_workforce_tasks').update({
        status: finalStatus,
        output: cleanContent,
        response_type: responseType || null,
        model_used: agentConfig.model,
        tokens_used: totalTokens,
        cost_cents: costCents,
        completed_at: new Date().toISOString(),
        duration_seconds: durationSeconds,
        updated_at: new Date().toISOString(),
      }).eq('id', taskId);

      // Persist ReAct trace in task metadata
      if (reactTrace.length > 0) {
        try {
          const { data: existing } = await this.db
            .from('agent_workforce_tasks')
            .select('metadata')
            .eq('id', taskId)
            .single();
          const existingMetadata = (existing?.metadata as Record<string, unknown>) || {};
          await this.db.from('agent_workforce_tasks').update({
            metadata: JSON.stringify({
              ...existingMetadata,
              react_trace: reactTrace,
            }),
          }).eq('id', taskId);
        } catch { /* non-fatal */ }
      }

      // Fire-and-forget output injection validation
      validateOutputSafety(cleanContent, this.modelRouter).then(async (result) => {
        if (!result.safe) {
          logger.warn(`[RuntimeEngine] Output injection detected for task ${taskId}: ${result.reason}`);
          try {
            const { data: existing } = await this.db
              .from('agent_workforce_tasks')
              .select('metadata')
              .eq('id', taskId)
              .single();
            const existingMetadata = (existing?.metadata as Record<string, unknown>) || {};
            await this.db.from('agent_workforce_tasks').update({
              metadata: JSON.stringify({
                ...existingMetadata,
                output_injection_flagged: true,
                output_injection_reason: result.reason,
              }),
            }).eq('id', taskId);
          } catch { /* non-fatal */ }
        }
      }).catch(() => {});

      // Fire-and-forget anomaly detection (mirrors cloud agent-runner-shared.ts:610-635)
      detectAndPersistAnomalies({
        db: this.db,
        agentId,
        workspaceId,
        taskId,
        tokensUsed: totalTokens,
        durationSeconds,
        failed: false,
        toolsUsed: reactTrace.flatMap(step => step.actions.map(a => a.tool)),
      });

      // Create deliverable record for all deliverable responses
      if (responseType === 'deliverable') {
        try {
          const { data: taskRow } = await this.db
            .from('agent_workforce_tasks')
            .select('deferred_action')
            .eq('id', taskId)
            .single();

          let deferredAction: { type: string; params: Record<string, unknown>; provider: string } | null = null;
          if (taskRow) {
            const raw = (taskRow as Record<string, unknown>).deferred_action;
            deferredAction = raw
              ? (typeof raw === 'string' ? JSON.parse(raw) : raw) as { type: string; params: Record<string, unknown>; provider: string }
              : null;
          }

          const deliverableType = !deferredAction ? 'document'
            : deferredAction.type.toLowerCase().includes('send_email') || deferredAction.type.toLowerCase().includes('gmail') ? 'email'
            : 'other';

          const deliverableTitle = !deferredAction ? task.title
            : deferredAction.params?.to ? `${deferredAction.type.replace(/_/g, ' ')} to ${deferredAction.params.to}`
            : `${deferredAction.type.replace(/_/g, ' ')}: ${task.title}`;

          await this.db.from('agent_workforce_deliverables').insert({
            workspace_id: workspaceId,
            task_id: taskId,
            agent_id: agentId,
            deliverable_type: deliverableType,
            provider: deferredAction?.provider || null,
            title: deliverableTitle,
            content: JSON.stringify(deferredAction?.params || { text: cleanContent }),
            status: finalStatus === 'needs_approval' ? 'pending_review' : 'approved',
            auto_created: 0,
          });
        } catch (err) {
          logger.error({ err }, '[RuntimeEngine] Deliverable creation failed');
        }
      }

      // Auto-deliverable fallback: if agent didn't tag but output is substantial
      if (!responseType && cleanContent) {
        try {
          const { data: taskMeta } = await this.db
            .from('agent_workforce_tasks')
            .select('source_type')
            .eq('id', taskId)
            .single();
          const sourceType = (taskMeta as Record<string, unknown> | null)?.source_type as string | null;
          const auto = this.shouldAutoCreateDeliverable(cleanContent, {
            title: task.title,
            sourceType,
          });
          if (auto.create) {
            await this.db.from('agent_workforce_deliverables').insert({
              workspace_id: workspaceId,
              task_id: taskId,
              agent_id: agentId,
              deliverable_type: auto.inferredType,
              title: task.title,
              content: JSON.stringify({ text: cleanContent }),
              status: finalStatus === 'needs_approval' ? 'pending_review' : 'approved',
              auto_created: 1,
            });
          }
        } catch (err) {
          logger.error({ err }, '[RuntimeEngine] Auto-deliverable fallback failed');
        }
      }

      // Save assistant message
      await this.db.from('agent_workforce_task_messages').insert({
        task_id: taskId,
        role: 'assistant',
        content: cleanContent,
        metadata: JSON.stringify({ model: agentConfig.model, tokensUsed: totalTokens }),
      });

      // Update agent stats with running averages
      const currentStats = typeof agent.stats === 'string' ? JSON.parse(agent.stats) : (agent.stats || {});
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
        p_description: `${totalTokens} tokens, ${durationSeconds}s`,
        p_agent_id: agentId,
        p_task_id: taskId,
        p_metadata: { runtime: true, model: agentConfig.model },
      });

      if (finalStatus === 'needs_approval') {
        this.emit('task:needs_approval', {
          taskId,
          agentId,
          agentName: agent.name,
          taskTitle: task.title,
          deliverableType: approvalRequired && responseType === 'deliverable' ? 'deliverable' : undefined,
          workspaceId,
        });
      }

      this.emit('task:completed', { taskId, agentId, status: finalStatus, tokensUsed: totalTokens, costCents });

      // 7.5 Auto-increment goal progress on successful completion
      // Skip auto-increment if agent explicitly called update_goal_progress
      const agentSetGoalManually = reactTrace.some(step =>
        step.actions.some(a => a.tool === 'update_goal_progress'),
      );
      if (task.goal_id && finalStatus === 'completed' && !agentSetGoalManually) {
        try {
          const { data: goalData } = await this.db
            .from('agent_workforce_goals')
            .select('current_value, target_value, status')
            .eq('id', task.goal_id)
            .single();

          if (goalData) {
            const goal = goalData as { current_value: number | null; target_value: number | null; status: string };
            const newValue = (goal.current_value ?? 0) + 1;
            const updateData: Record<string, unknown> = {
              current_value: newValue,
              updated_at: new Date().toISOString(),
            };
            // Auto-complete goal if target reached
            if (goal.target_value && newValue >= goal.target_value && goal.status === 'active') {
              updateData.status = 'completed';
              updateData.completed_at = new Date().toISOString();
            }
            await this.db
              .from('agent_workforce_goals')
              .update(updateData)
              .eq('id', task.goal_id);
          }
        } catch {
          logger.warn('[RuntimeEngine] Goal progress update skipped');
        }
      }

      // 7.6 Trigger pending child tasks (dependency chain)
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
                logger.info(`[RuntimeEngine] Triggering child task ${child.id} after parent ${taskId} completed`);
                this.executeTask(child.agent_id, child.id).catch(err => {
                  logger.error({ err }, `[RuntimeEngine] Child task ${child.id} execution failed`);
                });
              }
            }
          } catch {
            logger.warn('[RuntimeEngine] Child task triggering skipped');
          }
        })();
      }

      // 8. Extract memories and include in task report if sync is enabled
      const toolsUsedInTask = reactTrace.flatMap(step => step.actions.map(a => a.tool));
      extractMemoriesFromTask(
        { agentId, taskId, workspaceId, taskTitle: task.title, taskInput: taskInput || '', taskOutput: cleanContent, toolsUsed: toolsUsedInTask },
        { db: this.db, anthropic: this.anthropic, modelRouter: this.modelRouter, onMemoryExtracted: (aid, count) => this.emit('memory:extracted', { agentId: aid, count }) },
      )
        .then(async (extractedMemories) => {
          // Check if memory sync is enabled and agent has a sync policy
          if (extractedMemories.length > 0) {
            try {
              const { data: syncSetting } = await this.db
                .from('runtime_settings')
                .select('value')
                .eq('key', 'memory_sync_enabled')
                .maybeSingle();

              const syncEnabled = syncSetting && (syncSetting as { value: string }).value === 'true';

              // Get the agent's sync policy
              const { data: agentSyncData } = await this.db
                .from('agent_workforce_agents')
                .select('memory_sync_policy')
                .eq('id', agentId)
                .single();

              const agentSyncPolicy = ((agentSyncData as Record<string, unknown> | null)?.memory_sync_policy as MemorySyncPolicy) || 'none';

              if (syncEnabled && agentSyncPolicy !== 'none') {
                // Filter memories by sync policy
                const syncableMemories = extractedMemories.filter(m =>
                  isMemorySyncable(
                    {
                      memoryType: m.memoryType,
                      confidentialityLevel: m.confidentialityLevel as ConfidentialityLevel,
                      isLocalOnly: false,
                    },
                    agentSyncPolicy,
                  ),
                );

                if (syncableMemories.length > 0) {
                  // Send memories with the task report
                  this.effects.reportToCloud({
                    runtimeTaskId: taskId,
                    agentId,
                    taskTitle: task.title,
                    status: 'memory_sync',
                    tokensUsed: 0,
                    costCents: 0,
                    memories: { extracted: syncableMemories },
                  }).catch(() => {});
                }
              }
            } catch { /* non-fatal */ }
          }
        })
        .catch(err => {
          logger.error({ err }, '[RuntimeEngine] Memory extraction failed');
        });

      // Auto-trigger memory maintenance every 10 tasks
      if (newTotal % 10 === 0) {
        (async () => {
          try {
            await runAgentMemoryMaintenance(this.db, workspaceId, {
              agentId,
              anthropicApiKey: this.config.anthropicApiKey || undefined,
            });
          } catch { /* non-fatal */ }
        })();
      }

      // 8.1 Update session context (async, don't block)
      if (activeSessionId) {
        (async () => {
          try {
            const { data: session } = await this.db
              .from('agent_workforce_sessions')
              .select('context_summary')
              .eq('id', activeSessionId)
              .single();

            const existingContext = (session?.context_summary as string) || '';
            const taskSummary = `Task "${task.title}": ${cleanContent.slice(0, 200)}`;
            const newContext = existingContext
              ? `${existingContext}\n\n${taskSummary}`
              : taskSummary;

            const SESSION_TIMEOUT_HOURS = 4;
            await this.db
              .from('agent_workforce_sessions')
              .update({
                context_summary: newContext.slice(0, 4000),
                last_active_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + SESSION_TIMEOUT_HOURS * 3600000).toISOString(),
              })
              .eq('id', activeSessionId);
          } catch {
            logger.warn('[RuntimeEngine] Session context update skipped');
          }
        })();
      }

      // 9. Report to cloud (async, don't block)
      // Collect state updates made during this task for cloud sync
      const cloudReport: import('./types.js').TaskReport = {
        runtimeTaskId: taskId,
        agentId,
        taskTitle: task.title,
        status: finalStatus,
        tokensUsed: totalTokens,
        costCents,
        durationSeconds,
        modelUsed: agentConfig.model,
        startedAt: new Date(startTime).toISOString(),
        completedAt: new Date().toISOString(),
        taskOutput: cleanContent || undefined,
        reactTrace: reactTrace.length > 0 ? reactTrace : undefined,
      };

      // Include state updates modified during this task execution
      try {
        const updates = await this.collectStateUpdates(workspaceId, agentId, new Date(startTime).toISOString());
        if (updates.length > 0) {
          cloudReport.stateUpdates = updates;
        }
      } catch { /* non-fatal */ }

      // Include goal progress if applicable
      if (task.goal_id && finalStatus === 'completed') {
        try {
          const { data: goalRow } = await this.db
            .from('agent_workforce_goals')
            .select('current_value, status')
            .eq('id', task.goal_id)
            .single();
          if (goalRow) {
            const g = goalRow as { current_value: number; status: string };
            cloudReport.goalProgress = {
              goalId: task.goal_id,
              newValue: g.current_value,
              completed: g.status === 'completed',
            };
          }
        } catch { /* non-fatal */ }
      }

      this.effects.reportToCloud(cloudReport).catch(err => {
        logger.error({ err }, '[RuntimeEngine] Cloud report failed');
      });

      return {
        success: true,
        taskId,
        status: finalStatus,
        output: cleanContent,
        tokensUsed: totalTokens,
        costCents,
        responseType: responseType || undefined,
        traceId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);

      // Update task as failed with categorized error
      const failureCategory = classifyError(error);

      // Auto-retry for transient errors (rate limits, timeouts)
      if (isRetryableFailure(failureCategory)) {
        try {
          const { data: retryTask } = await this.db
            .from('agent_workforce_tasks')
            .select('retry_count, max_retries')
            .eq('id', taskId)
            .single();
          const retryCount = (retryTask as { retry_count: number; max_retries: number } | null)?.retry_count ?? 0;
          const maxRetries = (retryTask as { retry_count: number; max_retries: number } | null)?.max_retries ?? 3;

          if (retryCount < maxRetries) {
            const backoffMs = Math.pow(2, retryCount + 1) * 1000; // 2s, 4s, 8s
            const scheduledFor = new Date(Date.now() + backoffMs).toISOString();

            await this.db.from('agent_workforce_tasks').update({
              status: 'pending',
              retry_count: retryCount + 1,
              error_message: `Retry ${retryCount + 1}/${maxRetries}: ${errorMessage}`,
              updated_at: new Date().toISOString(),
              scheduled_for: scheduledFor,
            }).eq('id', taskId);

            // Reset agent to idle so it can pick up the retry
            await this.db.from('agent_workforce_agents').update({
              status: 'idle',
              updated_at: new Date().toISOString(),
            }).eq('id', agentId).then(() => {}, () => {});

            this.emit('task:retried', { taskId, agentId, retryCount: retryCount + 1, maxRetries });

            // Schedule re-execution after backoff
            setTimeout(() => {
              this.executeTask(agentId, taskId).catch(() => {});
            }, backoffMs);

            return {
              success: false,
              taskId,
              status: 'pending',
              error: `Retrying (${retryCount + 1}/${maxRetries}): ${errorMessage}`,
              tokensUsed: 0,
              costCents: 0,
            };
          }
        } catch {
          // If retry logic itself fails, fall through to normal failure handling
        }
      }

      this.emit('task:failed', { taskId, agentId, error: errorMessage });

      await this.db.from('agent_workforce_tasks').update({
        status: 'failed',
        error_message: errorMessage,
        failure_category: failureCategory,
        completed_at: new Date().toISOString(),
        duration_seconds: durationSeconds,
        updated_at: new Date().toISOString(),
      }).eq('id', taskId).then(() => {}, () => {});

      // Reset agent status and increment failed_tasks
      const { data: failedAgent } = await this.db.from('agent_workforce_agents')
        .select('stats').eq('id', agentId).single().then((r) => r, () => ({ data: null }));
      const failedStats = failedAgent
        ? (typeof (failedAgent as { stats: unknown }).stats === 'string'
          ? JSON.parse((failedAgent as { stats: string }).stats)
          : ((failedAgent as { stats: unknown }).stats || {}))
        : {};
      await this.db.from('agent_workforce_agents').update({
        status: 'idle',
        stats: JSON.stringify({
          ...failedStats,
          failed_tasks: (failedStats.failed_tasks || 0) + 1,
        }),
        updated_at: new Date().toISOString(),
      }).eq('id', agentId).then(() => {}, () => {});

      // Report failure to cloud (include state updates if possible)
      const failureReport: import('./types.js').TaskReport = {
        runtimeTaskId: taskId,
        agentId,
        taskTitle: taskTitle || `Task ${taskId}`,
        status: 'failed',
        tokensUsed: 0,
        costCents: 0,
        durationSeconds,
        errorMessage,
        startedAt: new Date(startTime).toISOString(),
        completedAt: new Date().toISOString(),
      };
      if (workspaceId) {
        try {
          const updates = await this.collectStateUpdates(workspaceId, agentId, new Date(startTime).toISOString());
          if (updates.length > 0) {
            failureReport.stateUpdates = updates;
          }
        } catch { /* non-fatal */ }
      }
      this.effects.reportToCloud(failureReport).catch(() => {});

      // Fire-and-forget anomaly detection for failures
      (async () => {
        try {
          const { data: failedAgentRow } = await this.db.from('agent_workforce_agents')
            .select('workspace_id').eq('id', agentId).single();
          const wsId = (failedAgentRow as { workspace_id: string } | null)?.workspace_id;
          if (!wsId) return;
          await detectAndPersistAnomalies({
            db: this.db,
            agentId,
            workspaceId: wsId,
            taskId,
            tokensUsed: 0,
            durationSeconds,
            failed: true,
            toolsUsed: [],
          });
        } catch { /* non-fatal */ }
      })();

      // Fire-and-forget: enrich failure with semantic root-cause classification
      if (this.modelRouter && failureCategory !== 'model_error' && failureCategory !== 'timeout') {
        (async () => {
          try {
            // Read task input from DB since it may not be in scope
            const { data: failedTaskRow } = await this.db.from('agent_workforce_tasks')
              .select('input').eq('id', taskId).single();
            const input = failedTaskRow
              ? String((failedTaskRow as Record<string, unknown>).input ?? '').slice(0, 300)
              : '';
            const rootCause = await classifyRootCause(this.modelRouter!, {
              taskTitle: taskTitle || '',
              taskInput: input,
              errorMessage,
            });
            if (rootCause !== 'unknown') {
              await this.db.from('agent_workforce_tasks')
                .update({ failure_category: rootCause })
                .eq('id', taskId);
            }
          } catch { /* non-fatal enrichment */ }
        })();
      }

      // If Ollama is the only provider and it's down, drain queued tasks immediately
      // instead of letting them each timeout serially
      if (!this.config.anthropicApiKey && this.modelRouter) {
        const isOllamaError = errorMessage.includes('Ollama') ||
          errorMessage.includes('ECONNREFUSED') ||
          errorMessage.includes('fetch failed') ||
          errorMessage.includes('Model too large') ||
          errorMessage.includes('Model not found');
        if (isOllamaError) {
          const ollamaUp = await this.modelRouter.isOllamaAvailable().catch(() => false);
          if (!ollamaUp) {
            const drained = this.semaphore.rejectAll(
              new Error('Ollama is not available. Queued tasks cancelled to avoid serial timeouts.')
            );
            if (drained > 0) {
              logger.warn(`[RuntimeEngine] Drained ${drained} queued task(s) — Ollama unavailable`);
            }
          }
        }
      }

      return {
        success: false,
        taskId,
        status: 'failed',
        error: errorMessage,
        tokensUsed: 0,
        costCents: 0,
      };
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
  private async collectStateUpdates(
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

  private async executeWithModelRouter(opts: {
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
    agentModel?: string;
    /** When present, forces tool_choice: 'required' on first iteration */
    skillsDocument?: string;
  }): Promise<{ fullContent: string; totalInputTokens: number; totalOutputTokens: number; reactTrace: LocalReActStep[]; providerCostCents?: number }> {
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

    // Browser state for on-demand activation
    let browserService: LocalBrowserService | null = null;
    let browserActivated = false;
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
            // Provider doesn't support tools — text-only fallback
            const textResponse = await provider.createMessage({
              system: opts.systemPrompt,
              messages: loopMessages.map(m => ({
                role: m.role === 'tool' ? 'user' : m.role,
                content: m.content,
              })),
              maxTokens: opts.maxTokens,
              temperature: opts.temperature,
              model: opts.agentModel,
            });
            return {
              fullContent: textResponse.content,
              totalInputTokens: textResponse.inputTokens,
              totalOutputTokens: textResponse.outputTokens,
              reactTrace: [],
            };
          }

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
            model: opts.agentModel,
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
            desktopService: null,
            desktopActivated: false,
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

    return { fullContent, totalInputTokens, totalOutputTokens, reactTrace, providerCostCents: providerCostCents || undefined };
  }

  // ==========================================================================
  // MEMORY COMPILATION (simplified, self-contained)
  // ==========================================================================

  private async compileMemory(agentId: string, workspaceId: string, taskTitle: string): Promise<string> {
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

  private async compileKnowledge(agentId: string, workspaceId: string, taskTitle: string, taskDescription?: string | null): Promise<string> {
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
   * Returns a formatted document for injection into the agent's system prompt.
   */
  private async compileSkills(agentId: string, workspaceId: string, taskTitle: string): Promise<string> {
    try {
      const { data: skills } = await this.db.from('agent_workforce_skills')
        .select('id, name, description, skill_type, definition, triggers, success_rate, times_used, agent_ids')
        .eq('workspace_id', workspaceId)
        .eq('is_active', 1)
        .order('pattern_support', { ascending: false })
        .limit(20);

      if (!skills || skills.length === 0) return '';

      // Filter: skills linked to this agent or workspace-wide (empty agent_ids)
      const agentSkills = (skills as Array<Record<string, unknown>>).filter(s => {
        try {
          const ids: string[] = JSON.parse((s.agent_ids as string) || '[]');
          return ids.length === 0 || ids.includes(agentId);
        } catch { return true; }
      });

      if (agentSkills.length === 0) return '';

      // Further filter by task relevance (keyword match against triggers)
      const { extractKeywords, matchesTriggers } = await import('../lib/token-similarity.js');
      const keywords = extractKeywords(taskTitle);
      const matched = keywords.length > 0
        ? agentSkills.filter(s => {
            try {
              const triggers: string[] = JSON.parse((s.triggers as string) || '[]');
              return triggers.length === 0 || matchesTriggers(triggers, keywords);
            } catch { return false; }
          })
        : agentSkills;

      const top = matched.slice(0, 5);
      if (top.length === 0) return '';

      // Format as procedure instructions
      return top.map(s => {
        const successLabel = s.success_rate != null ? ` (${Math.round(s.success_rate as number * 100)}% success)` : '';
        const header = `### ${s.name}${successLabel}\n${s.description || ''}`;

        if (s.skill_type === 'procedure' && s.definition) {
          try {
            const def = typeof s.definition === 'string' ? JSON.parse(s.definition as string) : s.definition;
            if (def.tool_sequence && Array.isArray(def.tool_sequence)) {
              const steps = def.tool_sequence.slice(0, 8).map((step: string | { tool: string; args?: Record<string, unknown> }, i: number) => {
                if (typeof step === 'string') return `${i + 1}. ${step}`;
                const argsStr = step.args ? `(${Object.entries(step.args).map(([, v]) => JSON.stringify(v)).join(', ')})` : '';
                return `${i + 1}. ${step.tool}${argsStr}`;
              }).join('\n');
              return `${header}\n**Steps:**\n${steps}`;
            }
          } catch { /* malformed definition */ }
        }
        return header;
      }).join('\n\n');
    } catch (err) {
      logger.debug({ err: err instanceof Error ? err.message : err }, '[engine] compileSkills failed');
      return '';
    }
  }

  // ==========================================================================
  // PROMPT BUILDING (simplified, self-contained)
  // ==========================================================================

  private buildSystemPrompt(opts: {
    agentName: string;
    agentRole: string;
    agentPrompt: string;
    taskTitle: string;
    taskDescription?: string;
    memoryDocument?: string;
    knowledgeDocument?: string;
    skillsDocument?: string;
    webSearchEnabled?: boolean;
    browserEnabled?: boolean;
    scraplingEnabled?: boolean;
    localFilesEnabled?: boolean;
    bashEnabled?: boolean;
    devopsEnabled?: boolean;
    desktopEnabled?: boolean;
    approvalRequired?: boolean;
    goalContext?: string;
  }): string {
    const biz = this.businessContext;
    const memorySection = opts.memoryDocument ? `\n${opts.memoryDocument}\n` : '';
    const knowledgeSection = opts.knowledgeDocument ? `\n${opts.knowledgeDocument}\n` : '';
    const skillsSection = opts.skillsDocument ? `\n## Standard Procedures\n**You MUST execute the tool calls listed below. Do NOT just describe what you would do — actually call each tool in sequence. Start by calling request_desktop or request_browser as the first step. If you skip the tool calls and only write text, the task will fail.**\n\n${opts.skillsDocument}\n` : '';
    const classificationSection = `\n## Response Classification
Before your response content, include exactly one hidden metadata tag on the very first line:
- <!--response_meta:{"type":"deliverable"}--> when your response contains a concrete work product (a draft, email, article, proposal, report, plan, code, creative content, data analysis, or any actionable output)
- <!--response_meta:{"type":"informational"}--> when your response is a brief answer, status update, clarification, or acknowledgment
${DRAFT_TOOL_PROMPT_HINT}`;
    const webSearchSection = opts.webSearchEnabled
      ? `\n## Web Search
You have web search capability. Use it whenever you need current or factual information.
- Be specific with search queries for better results.
- Cite your sources when presenting search results.
`
      : '';
    const browserSection = opts.browserEnabled ? BROWSER_SYSTEM_PROMPT : '';
    const scraplingSection = opts.scraplingEnabled ? SCRAPLING_SYSTEM_PROMPT : '';
    const docMountSection = opts.scraplingEnabled ? DOC_MOUNT_SYSTEM_PROMPT : '';
    const filesystemSection = opts.localFilesEnabled ? FILESYSTEM_SYSTEM_PROMPT : '';
    const bashSection = opts.bashEnabled ? BASH_SYSTEM_PROMPT : '';
    const devopsSection = opts.devopsEnabled ? DEVOPS_SYSTEM_PROMPT : '';

    // Guide the agent on when to use browser vs desktop
    const toolChoiceGuide = opts.browserEnabled && opts.desktopEnabled ? `
## Browser vs Desktop: When to Use Which

**Use request_desktop when the task involves:**
- Social media accounts (X/Twitter, Instagram, LinkedIn) — the user's Chrome has saved logins
- Email, banking, or any service requiring stored credentials
- Native macOS apps (Finder, Mail, Calendar, VS Code)
- Tasks where you need to see and interact with the actual screen

**Use request_browser (with profile="isolated") when the task involves:**
- Public web search, research, scraping
- Reading public pages that don't need login
- Tasks where speed matters more than credentials

**Rule of thumb:** If the task mentions a specific account, service login, or "my" (my email, my messages, my account), use request_desktop. If it's public information gathering, use request_browser.
` : '';

    const wrappedBusinessDesc = biz.businessDescription
      ? wrapUserData(biz.businessDescription)
      : `A ${biz.businessType.replace(/_/g, ' ')} business.`;

    return `You are ${opts.agentName}, a ${opts.agentRole} working for ${biz.businessName}.

## Business Context
${wrappedBusinessDesc}
${opts.goalContext ? `\n${opts.goalContext}\n` : ''}${memorySection}${knowledgeSection}${skillsSection}${toolChoiceGuide}${classificationSection}${webSearchSection}${browserSection}${scraplingSection}${docMountSection}${filesystemSection}${bashSection}${devopsSection}
## Guidelines
- Always maintain a professional and helpful tone
- Focus on quality and accuracy in your work
- If you're unsure about something, ask for clarification
- Provide clear, actionable outputs

## Current Task
Title: ${wrapUserData(opts.taskTitle)}
${opts.taskDescription ? `Description: ${wrapUserData(opts.taskDescription)}` : ''}

---

${opts.agentPrompt}`;
  }

  private parseResponseMeta(content: string): {
    type: 'deliverable' | 'informational' | null;
    cleanContent: string;
  } {
    const match = content.match(/^<!--response_meta:(.*?)-->\s*/);
    if (!match) return { type: null, cleanContent: content };
    try {
      const meta = JSON.parse(match[1]);
      if (meta.type === 'deliverable' || meta.type === 'informational') {
        return {
          type: meta.type,
          cleanContent: content.replace(/^<!--response_meta:.*?-->\s*/, ''),
        };
      }
    } catch {
      // Unparseable
    }
    return { type: null, cleanContent: content };
  }

  /** Heuristic: determine if an untagged response should auto-create a deliverable */
  private shouldAutoCreateDeliverable(
    content: string,
    task: { title: string; sourceType?: string | null },
  ): { create: boolean; inferredType: string } {
    const NO = { create: false, inferredType: 'other' };

    // Skip trivially short responses
    if (content.length < 200) return NO;

    // Skip system/heartbeat/internal tasks
    const lowerTitle = task.title.toLowerCase();
    const systemPrefixes = ['heartbeat', 'health check', 'system:', 'internal:', 'ping', 'cron:'];
    if (systemPrefixes.some(p => lowerTitle.startsWith(p))) return NO;
    if (task.sourceType === 'heartbeat' || task.sourceType === 'system') return NO;

    // Structure signals
    const hasHeaders = /^#{1,3}\s/m.test(content);
    const hasList = /^[-*]\s/m.test(content) || /^\d+\.\s/m.test(content);
    const hasCodeBlock = /```[\s\S]*?```/.test(content);
    const hasTable = /\|.*\|.*\|/m.test(content);
    const structureScore = [hasHeaders, hasList, hasCodeBlock, hasTable].filter(Boolean).length;

    // Substantial content (>500 chars) with any structure = deliverable
    if (content.length > 500 && structureScore >= 1) {
      return { create: true, inferredType: this.inferTypeFromContent(content, lowerTitle) };
    }

    // Very long content (>1500 chars) even without structure
    if (content.length > 1500) {
      return { create: true, inferredType: this.inferTypeFromContent(content, lowerTitle) };
    }

    // Medium content (200-500) with strong structure (2+ signals)
    if (content.length >= 200 && structureScore >= 2) {
      return { create: true, inferredType: this.inferTypeFromContent(content, lowerTitle) };
    }

    return NO;
  }

  /** Infer deliverable type from content patterns and task title */
  private inferTypeFromContent(content: string, lowerTitle: string): string {
    // Email patterns
    if (/subject:|dear |regards|sincerely/i.test(content) &&
        (lowerTitle.includes('email') || lowerTitle.includes('outreach') || lowerTitle.includes('message'))) {
      return 'email';
    }

    // Code patterns
    if (/```(ts|js|python|tsx|jsx|rust|go|java|sql|html|css|sh|bash)/i.test(content) ||
        lowerTitle.includes('code') || lowerTitle.includes('implement') || lowerTitle.includes('script')) {
      return 'code';
    }

    // Report patterns
    if (lowerTitle.includes('report') || lowerTitle.includes('analysis') || lowerTitle.includes('audit') ||
        /executive summary|key findings|recommendations|conclusion/i.test(content)) {
      return 'report';
    }

    // Plan patterns
    if (lowerTitle.includes('plan') || lowerTitle.includes('strategy') || lowerTitle.includes('roadmap') ||
        /phase \d|step \d|timeline|milestone/i.test(content)) {
      return 'plan';
    }

    // Data patterns
    if (lowerTitle.includes('data') || lowerTitle.includes('spreadsheet') || lowerTitle.includes('csv') ||
        /\|.*\|.*\|/m.test(content)) {
      return 'data';
    }

    // Creative patterns
    if (lowerTitle.includes('write') || lowerTitle.includes('draft') || lowerTitle.includes('blog') ||
        lowerTitle.includes('post') || lowerTitle.includes('article') || lowerTitle.includes('copy') ||
        lowerTitle.includes('creative') || lowerTitle.includes('story')) {
      return 'creative';
    }

    return 'document';
  }
}
