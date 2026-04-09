/**
 * LocalArena — Standardized agent training environment for the local runtime
 *
 * Wraps the existing tool execution pipeline into a reset/step/observe loop.
 * Each step routes through the same ToolExecutor used by the orchestrator,
 * so agents in the arena use the same tools as in production.
 *
 * Integration points:
 * - Tool execution: via executeToolCall() from tool-executor.ts
 * - Observation: via DigitalBody.getProprioception()
 * - Experience: arena events are appended to the ExperienceStream
 */

import crypto from 'crypto';
import type {
  ArenaConfig,
  ArenaAction,
  StepResult,
  Observation,
  EpisodeSummary,
} from './types.js';
import type {
  ToolExecutionContext,
  ToolCallOutcome,
} from '../../orchestrator/tool-executor.js';
import { executeToolCall } from '../../orchestrator/tool-executor.js';
import type { ExperienceStream } from '../../brain/experience-stream.js';
import type { Proprioception } from '../../body/types.js';
import { logger } from '../../lib/logger.js';

// ============================================================================
// LOCAL ARENA
// ============================================================================

export class LocalArena {
  private config: ArenaConfig;
  private toolCtx: ToolExecutionContext;
  private experienceStream: ExperienceStream | null;
  private getProprioception: (() => Proprioception) | null;

  // Episode state
  private episodeId: string | null = null;
  private stepCount: number = 0;
  private cumulativeReward: number = 0;
  private startedAt: number = 0;
  private lastObservation: Observation | null = null;
  private isDone: boolean = false;

  constructor(options: {
    config: ArenaConfig;
    toolCtx: ToolExecutionContext;
    experienceStream?: ExperienceStream;
    /** Function to get current body state. Pass digitalBody.getProprioception. */
    getProprioception?: () => Proprioception;
  }) {
    this.config = options.config;
    this.toolCtx = options.toolCtx;
    this.experienceStream = options.experienceStream ?? null;
    this.getProprioception = options.getProprioception ?? null;
  }

  // --------------------------------------------------------------------------
  // CORE LOOP
  // --------------------------------------------------------------------------

  /**
   * Start a new episode. Resets all state and runs the initial setup.
   * Returns the first observation.
   */
  async reset(): Promise<Observation> {
    // Finalize previous episode if any
    if (this.episodeId && !this.isDone) {
      this.finalizeEpisode(false, true);
    }

    this.episodeId = crypto.randomUUID();
    this.stepCount = 0;
    this.cumulativeReward = 0;
    this.startedAt = Date.now();
    this.isDone = false;

    // Run initial state setup if provided
    if (this.config.initialState) {
      await this.config.initialState();
    }

    // Record episode start
    this.experienceStream?.append(
      'arena_episode_start',
      {
        arenaId: this.config.id,
        arenaName: this.config.name,
        episodeId: this.episodeId,
        domain: this.config.domain,
        maxSteps: this.config.maxSteps,
      },
      'orchestrator',
    );

    this.lastObservation = this.buildObservation();
    return this.lastObservation;
  }

  /**
   * Take a single step: execute the action, observe the result, compute reward.
   */
  async step(action: ArenaAction): Promise<StepResult> {
    if (!this.episodeId) {
      throw new Error('Arena: call reset() before step()');
    }
    if (this.isDone) {
      throw new Error('Arena: episode is done. Call reset() to start a new one.');
    }

    // Validate action against allowed tools
    if (this.config.allowedTools && !this.config.allowedTools.includes(action.toolName)) {
      return this.buildErrorStep(action, `Tool "${action.toolName}" not in allowed tools for this arena`);
    }

    const stepStart = Date.now();
    this.stepCount++;

    // Execute the tool through the existing pipeline
    let outcome: ToolCallOutcome;
    try {
      outcome = await this.executeTool(action);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message, tool: action.toolName }, 'Arena step tool execution error');
      outcome = {
        toolName: action.toolName,
        result: { success: false, error: message },
        resultContent: `Error: ${message}`,
        isError: true,
      };
    }

    const durationMs = Date.now() - stepStart;

    // Build new observation
    const observation = this.buildObservation(outcome);
    this.lastObservation = observation;

    // Compute reward
    const reward = this.config.rewardFn(observation, action, outcome, this.stepCount);
    this.cumulativeReward += reward;

    // Check termination conditions
    const done = this.config.successCriteria
      ? this.config.successCriteria(observation)
      : false;
    const truncated = this.stepCount >= this.config.maxSteps;
    this.isDone = done || truncated;

    // Record step in experience stream
    this.experienceStream?.append(
      'arena_step',
      {
        arenaId: this.config.id,
        episodeId: this.episodeId,
        stepNumber: this.stepCount,
        action: { toolName: action.toolName, inputKeys: Object.keys(action.input) },
        reward,
        cumulativeReward: this.cumulativeReward,
        toolSuccess: !outcome.isError,
        done,
        truncated,
        durationMs,
      },
      'orchestrator',
      // Link to episode start for causal chain
      this.episodeId,
    );

    // Finalize episode if done
    if (this.isDone) {
      this.finalizeEpisode(done, truncated);
    }

    return {
      observation,
      reward,
      done,
      truncated,
      info: {
        toolOutcome: outcome,
        durationMs,
        cumulativeReward: this.cumulativeReward,
        stepsRemaining: Math.max(0, this.config.maxSteps - this.stepCount),
      },
    };
  }

  /**
   * Get the current observation without taking an action.
   */
  observe(): Observation {
    if (this.lastObservation) return this.lastObservation;
    return this.buildObservation();
  }

  /**
   * Get the current action space (available tools as affordances).
   */
  getActionSpace(): string[] {
    if (this.config.allowedTools) return this.config.allowedTools;

    const proprio = this.getProprioception?.();
    if (proprio) {
      return proprio.affordances.map(a => a.action);
    }

    return [];
  }

  /**
   * Get the current episode summary (or null if no episode active).
   */
  getEpisodeSummary(): EpisodeSummary | null {
    if (!this.episodeId) return null;
    return {
      episodeId: this.episodeId,
      arenaId: this.config.id,
      totalReward: this.cumulativeReward,
      steps: this.stepCount,
      success: this.isDone && this.stepCount < this.config.maxSteps,
      truncated: this.stepCount >= this.config.maxSteps,
      durationMs: Date.now() - this.startedAt,
      startedAt: this.startedAt,
    };
  }

  /** The arena configuration. */
  getConfig(): ArenaConfig {
    return this.config;
  }

  /** Current episode ID, or null. */
  getEpisodeId(): string | null {
    return this.episodeId;
  }

  // --------------------------------------------------------------------------
  // INTERNALS
  // --------------------------------------------------------------------------

  /**
   * Execute a tool call through the existing executor pipeline.
   * Drains the async generator to get the final outcome.
   */
  private async executeTool(action: ArenaAction): Promise<ToolCallOutcome> {
    const request = {
      id: crypto.randomUUID(),
      name: action.toolName,
      input: action.input,
    };

    // executeToolCall is an async generator yielding events + returning outcome
    const gen = executeToolCall(request, this.toolCtx);
    let outcome: ToolCallOutcome | undefined;

    // Drain all events, keeping the final return value
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const result = await gen.next();
      if (result.done) {
        outcome = result.value;
        break;
      }
      // Events (tool_start, tool_done, etc.) are discarded in arena mode.
      // Future: could be captured for richer trajectory recording.
    }

    if (!outcome) {
      throw new Error(`Tool ${action.toolName} returned no outcome`);
    }

    return outcome;
  }

  /**
   * Build an observation from the current body state and optional tool outcome.
   */
  private buildObservation(outcome?: ToolCallOutcome): Observation {
    const proprio = this.getProprioception?.();

    return {
      screenshot: outcome?.screenshotPath,
      text: outcome?.resultContent,
      structuredData: outcome?.result?.data,
      affordances: proprio?.affordances ?? [],
      umwelt: proprio?.umwelt ?? [],
      metadata: {
        timestamp: Date.now(),
        stepNumber: this.stepCount,
      },
    };
  }

  /**
   * Build an error step result for invalid actions.
   */
  private buildErrorStep(action: ArenaAction, error: string): StepResult {
    const outcome: ToolCallOutcome = {
      toolName: action.toolName,
      result: { success: false, error },
      resultContent: error,
      isError: true,
    };

    const observation = this.buildObservation(outcome);
    this.lastObservation = observation;

    const reward = this.config.rewardFn(observation, action, outcome, this.stepCount);
    this.cumulativeReward += reward;

    return {
      observation,
      reward,
      done: false,
      truncated: false,
      info: {
        toolOutcome: outcome,
        durationMs: 0,
        cumulativeReward: this.cumulativeReward,
        stepsRemaining: Math.max(0, this.config.maxSteps - this.stepCount),
      },
    };
  }

  /**
   * Record episode completion in the experience stream.
   */
  private finalizeEpisode(success: boolean, truncated: boolean): void {
    this.experienceStream?.append(
      'arena_episode_end',
      {
        arenaId: this.config.id,
        episodeId: this.episodeId,
        totalReward: this.cumulativeReward,
        steps: this.stepCount,
        success,
        truncated,
        durationMs: Date.now() - this.startedAt,
      },
      'orchestrator',
      this.episodeId ?? undefined,
    );
  }
}
