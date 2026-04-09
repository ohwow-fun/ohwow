/**
 * Arena Trajectory Recording — Structured agent execution traces
 *
 * Records every step taken in an arena episode into a structured
 * trajectory format suitable for behavior analysis and training.
 *
 * The TrajectoryRecorder listens to the ExperienceStream for arena events
 * and buffers steps per episode. On episode end, it persists the complete
 * trajectory to the database.
 *
 * Export format is JSONL (one trajectory per line), compatible with
 * external training pipelines.
 */

import type { ExperienceStream } from '../../brain/experience-stream.js';
import type { Experience } from '../../brain/types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

/** A single step recorded during an arena episode. */
export interface TrajectoryStep {
  /** Step index (1-based). */
  stepIndex: number;
  /** Tool that was called. */
  toolName: string;
  /** Keys of the tool input (full input omitted for size). */
  inputKeys: string[];
  /** Reward received for this step. */
  reward: number;
  /** Cumulative reward up to this step. */
  cumulativeReward: number;
  /** Whether the tool call succeeded. */
  toolSuccess: boolean;
  /** Whether this step ended the episode. */
  done: boolean;
  /** Whether this step truncated the episode. */
  truncated: boolean;
  /** Wall-clock duration of this step in ms. */
  durationMs: number;
  /** Timestamp of this step. */
  timestamp: number;
}

/** A complete trajectory for one arena episode. */
export interface Trajectory {
  /** Unique trajectory ID (matches episode ID). */
  id: string;
  /** Arena this trajectory was recorded in. */
  arenaId: string;
  /** Arena name for display. */
  arenaName: string;
  /** Agent that ran this episode (if known). */
  agentId?: string;
  /** All steps in chronological order. */
  steps: TrajectoryStep[];
  /** Total accumulated reward. */
  totalReward: number;
  /** Whether the goal was reached. */
  success: boolean;
  /** Whether the episode was truncated (max steps). */
  truncated: boolean;
  /** Total wall-clock duration in ms. */
  durationMs: number;
  /** When the episode started. */
  startedAt: number;
  /** Arbitrary metadata. */
  metadata: Record<string, unknown>;
}

// ============================================================================
// TRAJECTORY RECORDER
// ============================================================================

/**
 * Listens to arena events in the ExperienceStream and builds
 * trajectories automatically. Persists completed trajectories to the DB.
 */
export class TrajectoryRecorder {
  private experienceStream: ExperienceStream;
  private db: DatabaseAdapter | null;
  private workspaceId: string;
  private maxCompleted: number;

  /** Active episode buffers: episodeId → { steps, arenaId, arenaName, startedAt } */
  private activeEpisodes = new Map<string, {
    arenaId: string;
    arenaName: string;
    startedAt: number;
    steps: TrajectoryStep[];
  }>();

  /** Completed trajectories (kept in memory for export). */
  private completed: Trajectory[] = [];

  /** Unsubscribe functions for experience stream listeners. */
  private unsubscribers: Array<() => void> = [];

  constructor(options: {
    experienceStream: ExperienceStream;
    db?: DatabaseAdapter;
    workspaceId?: string;
    /** Max trajectories kept in memory (default 500). Oldest dropped when exceeded. */
    maxCompleted?: number;
  }) {
    this.experienceStream = options.experienceStream;
    this.db = options.db ?? null;
    this.workspaceId = options.workspaceId ?? 'default';
    this.maxCompleted = options.maxCompleted ?? 500;
  }

  /** Start listening for arena events. */
  start(): void {
    this.unsubscribers.push(
      this.experienceStream.on('arena_episode_start', (exp) => this.onEpisodeStart(exp)),
      this.experienceStream.on('arena_step', (exp) => this.onStep(exp)),
      this.experienceStream.on('arena_episode_end', (exp) => this.onEpisodeEnd(exp)),
    );
  }

  /** Stop listening and clean up. */
  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  /** Get all completed trajectories (in-memory). */
  getCompleted(): Trajectory[] {
    return this.completed;
  }

  /** Get trajectories for a specific arena. */
  getByArena(arenaId: string): Trajectory[] {
    return this.completed.filter(t => t.arenaId === arenaId);
  }

  /** Export all completed trajectories as JSONL string. */
  exportAsJsonl(): string {
    return this.completed.map(t => JSON.stringify(t)).join('\n');
  }

  /** Clear in-memory completed trajectories. */
  clear(): void {
    this.completed = [];
  }

  // --------------------------------------------------------------------------
  // EVENT HANDLERS
  // --------------------------------------------------------------------------

  private onEpisodeStart(exp: Experience): void {
    const data = exp.data as {
      arenaId: string;
      arenaName: string;
      episodeId: string;
    };

    this.activeEpisodes.set(data.episodeId, {
      arenaId: data.arenaId,
      arenaName: data.arenaName,
      startedAt: exp.timestamp,
      steps: [],
    });
  }

  private onStep(exp: Experience): void {
    const data = exp.data as {
      episodeId: string;
      stepNumber: number;
      action: { toolName: string; inputKeys: string[] };
      reward: number;
      cumulativeReward: number;
      toolSuccess: boolean;
      done: boolean;
      truncated: boolean;
      durationMs: number;
    };

    const episode = this.activeEpisodes.get(data.episodeId);
    if (!episode) return;

    episode.steps.push({
      stepIndex: data.stepNumber,
      toolName: data.action.toolName,
      inputKeys: data.action.inputKeys,
      reward: data.reward,
      cumulativeReward: data.cumulativeReward,
      toolSuccess: data.toolSuccess,
      done: data.done,
      truncated: data.truncated,
      durationMs: data.durationMs,
      timestamp: exp.timestamp,
    });
  }

  private onEpisodeEnd(exp: Experience): void {
    const data = exp.data as {
      arenaId: string;
      episodeId: string;
      totalReward: number;
      steps: number;
      success: boolean;
      truncated: boolean;
      durationMs: number;
    };

    const episode = this.activeEpisodes.get(data.episodeId);
    if (!episode) return;

    const trajectory: Trajectory = {
      id: data.episodeId,
      arenaId: episode.arenaId,
      arenaName: episode.arenaName,
      steps: episode.steps,
      totalReward: data.totalReward,
      success: data.success,
      truncated: data.truncated,
      durationMs: data.durationMs,
      startedAt: episode.startedAt,
      metadata: {},
    };

    this.completed.push(trajectory);
    // Cap in-memory buffer — drop oldest when exceeded
    while (this.completed.length > this.maxCompleted) {
      this.completed.shift();
    }
    this.activeEpisodes.delete(data.episodeId);

    // Persist to DB (fire-and-forget)
    this.persist(trajectory).catch((err) => {
      logger.warn({ err, trajectoryId: trajectory.id }, 'Failed to persist arena trajectory');
    });
  }

  // --------------------------------------------------------------------------
  // PERSISTENCE
  // --------------------------------------------------------------------------

  private async persist(trajectory: Trajectory): Promise<void> {
    if (!this.db) return;

    await this.db.from('arena_trajectories').insert({
      id: trajectory.id,
      arena_id: trajectory.arenaId,
      agent_id: trajectory.agentId ?? 'unknown',
      workspace_id: this.workspaceId,
      steps: JSON.stringify(trajectory.steps),
      total_reward: trajectory.totalReward,
      success: trajectory.success ? 1 : 0,
      duration_ms: trajectory.durationMs,
      metadata: JSON.stringify(trajectory.metadata),
    });
  }
}
