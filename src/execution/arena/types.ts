/**
 * Arena Type System — Standardized Agent Training Environments
 *
 * An Arena wraps any software environment (browser, desktop, MCP, composite)
 * into a standardized reset/step/observe loop with reward signals.
 *
 * Core mapping from existing ohwow concepts:
 * - Affordance[] → what the agent can do (action space)
 * - UmweltDimension[] + Proprioception → what the agent perceives (observation)
 * - RewardFunction → how the agent is scored
 * - ExperienceStream → where arena events are recorded
 *
 * Inspired by CMU Gym-Anything (arXiv:2604.06126) but using ohwow's
 * embodied cognition vocabulary instead of OpenAI Gym's.
 */

import type { Affordance, UmweltDimension } from '../../body/types.js';
import type { ToolCallOutcome } from '../../orchestrator/tool-executor.js';

// ============================================================================
// OBSERVATION — What the agent perceives after each step
// ============================================================================

/**
 * A snapshot of the world as the agent perceives it.
 *
 * Combines visual state (screenshots), semantic state (DOM, text),
 * and embodied state (affordances, umwelt) into a single structure.
 */
export interface Observation {
  /** Screenshot from browser or desktop (base64). */
  screenshot?: string;
  /** DOM snapshot from browser (Stagehand observe). */
  dom?: string;
  /** Text output from the last tool execution. */
  text?: string;
  /** Parsed structured data from tool results. */
  structuredData?: unknown;
  /** Currently available actions (Gibson's affordances). */
  affordances: Affordance[];
  /** Current perceptual dimensions (von Uexkull's Umwelt). */
  umwelt: UmweltDimension[];
  /** Environment metadata. */
  metadata: ObservationMetadata;
}

export interface ObservationMetadata {
  /** Current URL if browser-based. */
  url?: string;
  /** Frontmost application if desktop-based. */
  app?: string;
  /** When this observation was captured. */
  timestamp: number;
  /** Current step number in the episode. */
  stepNumber: number;
}

// ============================================================================
// ACTION — What the agent can do
// ============================================================================

/**
 * An action in the arena: invoke a tool with specific input.
 * Maps directly to the existing ToolCallRequest but without the ID
 * (the arena assigns IDs internally).
 */
export interface ArenaAction {
  /** Tool to invoke (must be in the current action space). */
  toolName: string;
  /** Tool input parameters. */
  input: Record<string, unknown>;
}

// ============================================================================
// STEP RESULT — What comes back after each action
// ============================================================================

/**
 * The result of taking a single step in the arena.
 * Combines observation, reward, and termination signals.
 */
export interface StepResult {
  /** The new observation after the action. */
  observation: Observation;
  /** Scalar reward for this step. */
  reward: number;
  /** Whether the episode ended naturally (goal reached or failure). */
  done: boolean;
  /** Whether the episode was cut short (max steps reached, timeout). */
  truncated: boolean;
  /** Additional step metadata. */
  info: StepInfo;
}

export interface StepInfo {
  /** The tool outcome from execution. */
  toolOutcome: ToolCallOutcome;
  /** Wall-clock time for this step in ms. */
  durationMs: number;
  /** Cumulative reward so far in this episode. */
  cumulativeReward: number;
  /** Steps remaining before truncation. */
  stepsRemaining: number;
}

// ============================================================================
// REWARD FUNCTION — How the agent is scored
// ============================================================================

/**
 * A reward function scores each step based on the observation,
 * action taken, and tool outcome. Returns a scalar value.
 *
 * Reward functions are composable via compositeReward().
 */
export type RewardFunction = (
  observation: Observation,
  action: ArenaAction,
  outcome: ToolCallOutcome,
  stepNumber: number,
) => number;

// ============================================================================
// ARENA CONFIGURATION
// ============================================================================

/** The software domain this arena targets. */
export type ArenaDomain = 'browser' | 'desktop' | 'mcp' | 'composite';

/**
 * Configuration for an arena instance.
 * Defines the environment, its constraints, and how episodes are scored.
 */
export interface ArenaConfig {
  /** Unique identifier for this arena. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** What this arena is about. */
  description: string;
  /** Which software domain this wraps. */
  domain: ArenaDomain;
  /** Maximum steps per episode before truncation. */
  maxSteps: number;
  /** How each step is scored. */
  rewardFn: RewardFunction;
  /** Optional setup function called on reset() to initialize the environment. */
  initialState?: () => Promise<void>;
  /** Optional function to check if the goal is reached (triggers done=true). */
  successCriteria?: (obs: Observation) => boolean;
  /** Optional list of allowed tools (restricts action space). */
  allowedTools?: string[];
  /** Optional timeout per step in ms. */
  stepTimeoutMs?: number;
}

// ============================================================================
// EPISODE — A single run through the arena
// ============================================================================

/** Summary of a completed episode. */
export interface EpisodeSummary {
  /** Unique episode ID. */
  episodeId: string;
  /** Arena this episode ran in. */
  arenaId: string;
  /** Total reward accumulated. */
  totalReward: number;
  /** Number of steps taken. */
  steps: number;
  /** Whether the goal was reached. */
  success: boolean;
  /** Whether the episode was truncated (max steps). */
  truncated: boolean;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** When the episode started. */
  startedAt: number;
}
