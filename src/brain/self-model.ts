/**
 * Self-Model — Transcendental Apperception (Kant)
 *
 * "The 'I think' must be able to accompany all my representations."
 * — Immanuel Kant, Critique of Pure Reason, B131
 *
 * The brain must know itself. Not as vanity, but as practical necessity:
 * a 4B-parameter local model should plan differently than Claude Opus.
 * An overloaded system should prioritize differently than an idle one.
 * A brain with 200 tokens of context left should compress, not expand.
 *
 * The SelfModel is constructed from the ExperienceStream and external
 * state (model router, context budget, engine load). It is read by:
 * - system-prompt.ts (to select full/compact/micro prompt mode)
 * - predictive-engine.ts (to calibrate confidence)
 * - brain.ts deliberate() (to scope plan ambition to actual capability)
 */

import type { SelfModel, ToolProfile, ToolMastery } from './types.js';
import type { ExperienceStream } from './experience-stream.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Thresholds for tool mastery (Merleau-Ponty). */
const MASTERY_THRESHOLDS: Record<ToolMastery, number> = {
  novice: 0,
  familiar: 20,
  mastered: 50,
};

/** Window for "recent" performance metrics (ms). */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Rolling average decay factor for confidence. */
const CONFIDENCE_DECAY = 0.1;

// ============================================================================
// SELF-MODEL BUILDER
// ============================================================================

/**
 * External state that the SelfModel reads from (injected, not owned).
 */
export interface SelfModelDeps {
  /** Current model identifier (e.g., 'claude-haiku-4-5-20251001' or 'qwen3:4b'). */
  activeModel: string;
  /** What the current model supports (e.g., ['tool_calling', 'vision']). */
  modelCapabilities: string[];
  /** Remaining context window tokens. */
  tokenBudgetRemaining: number;
  /** Known limitations (e.g., 'no_browser', 'ollama_only', 'no_anthropic_key'). */
  limitations: string[];
  /** Number of tasks currently executing. */
  currentLoad: number;
  /** Body proprioception, if embodiment layer is active. */
  bodyProprioception?: import('../body/types.js').Proprioception;
}

/**
 * Builds and maintains the brain's self-model.
 *
 * The self-model is not a static snapshot; it evolves as the brain
 * accumulates experiences. Confidence rises with prediction accuracy.
 * Tool proficiency grows with successful usage. Limitations are
 * detected from the environment, not hardcoded.
 */
export class SelfModelBuilder {
  private toolProfiles: Map<string, ToolProfile> = new Map();
  private rollingConfidence: number = 0.5; // start at maximum uncertainty

  constructor(private experienceStream: ExperienceStream) {}

  /**
   * Build the current self-model snapshot.
   *
   * This is called before each cognitive cycle (perceive/deliberate/act).
   * It combines live external state with accumulated experience data.
   */
  build(deps: SelfModelDeps): SelfModel {
    // Update confidence from experience stream
    const predictionAccuracy = this.experienceStream.getPredictionAccuracy(RECENT_WINDOW_MS);
    this.rollingConfidence = this.rollingConfidence * (1 - CONFIDENCE_DECAY) + predictionAccuracy * CONFIDENCE_DECAY;

    // Update tool profiles from recent executions
    this.updateToolProfiles();

    // Compute recent performance
    const recentPerformance = this.computeRecentPerformance();

    return {
      currentLoad: deps.currentLoad,
      tokenBudgetRemaining: deps.tokenBudgetRemaining,
      modelCapabilities: deps.modelCapabilities,
      activeModel: deps.activeModel,
      confidence: this.rollingConfidence,
      limitations: deps.limitations,
      toolProficiency: new Map(this.toolProfiles),
      recentPerformance,
      bodyState: deps.bodyProprioception,
    };
  }

  /**
   * Get the mastery level for a specific tool.
   */
  getToolMastery(toolName: string): ToolMastery {
    const profile = this.toolProfiles.get(toolName);
    if (!profile) return 'novice';
    return profile.mastery;
  }

  /**
   * Get a compact description for a mastered tool (saves tokens in prompts).
   * Returns undefined for non-mastered tools (use full description).
   */
  getCompactDescription(toolName: string): string | undefined {
    const profile = this.toolProfiles.get(toolName);
    if (profile?.mastery === 'mastered') {
      return profile.compactDescription;
    }
    return undefined;
  }

  /**
   * Record a tool execution to update proficiency tracking.
   * Called by the predictive engine after each tool call.
   */
  recordToolUse(toolName: string, success: boolean, latencyMs: number, nextTool?: string): void {
    const profile = this.getOrCreateProfile(toolName);

    profile.totalUses++;
    // Running average for success rate
    profile.successRate = profile.successRate + (((success ? 1 : 0) - profile.successRate) / profile.totalUses);
    // Running average for latency
    profile.avgLatencyMs = profile.avgLatencyMs + ((latencyMs - profile.avgLatencyMs) / profile.totalUses);
    // Update mastery level
    profile.mastery = this.computeMastery(profile.totalUses);

    // Track contextual patterns (Merleau-Ponty: the body remembers sequences)
    if (nextTool) {
      const currentCount = profile.contextualPatterns.get(nextTool) ?? 0;
      profile.contextualPatterns.set(nextTool, currentCount + 1);
    }
  }

  /**
   * Suggest the most likely next tool based on embodied patterns.
   */
  suggestNextTool(lastToolName: string): string | null {
    const profile = this.toolProfiles.get(lastToolName);
    if (!profile || profile.contextualPatterns.size === 0) return null;

    let bestTool: string | null = null;
    let bestCount = 0;

    for (const [tool, count] of profile.contextualPatterns) {
      if (count > bestCount) {
        bestCount = count;
        bestTool = tool;
      }
    }

    // Only suggest if the pattern is strong enough (>30% of uses)
    if (bestTool && bestCount > profile.totalUses * 0.3) {
      return bestTool;
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  private getOrCreateProfile(toolName: string): ToolProfile {
    let profile = this.toolProfiles.get(toolName);
    if (!profile) {
      profile = {
        name: toolName,
        totalUses: 0,
        successRate: 0.5,
        avgLatencyMs: 0,
        mastery: 'novice',
        contextualPatterns: new Map(),
      };
      this.toolProfiles.set(toolName, profile);
    }
    return profile;
  }

  private computeMastery(totalUses: number): ToolMastery {
    if (totalUses >= MASTERY_THRESHOLDS.mastered) return 'mastered';
    if (totalUses >= MASTERY_THRESHOLDS.familiar) return 'familiar';
    return 'novice';
  }

  private updateToolProfiles(): void {
    // Scan recent tool executions to ensure profiles are up to date
    const recentExecutions = this.experienceStream.getRecentToolExecutions(100);

    for (const exec of recentExecutions) {
      const profile = this.getOrCreateProfile(exec.toolName);
      // Only update mastery (detailed tracking happens in recordToolUse)
      profile.mastery = this.computeMastery(profile.totalUses);
    }
  }

  private computeRecentPerformance(): SelfModel['recentPerformance'] {
    const after = Date.now() - RECENT_WINDOW_MS;

    const toolExecutions = this.experienceStream.query({
      types: ['tool_executed'],
      after,
    });

    const stagnations = this.experienceStream.query({
      types: ['stagnation_detected'],
      after,
    });

    let successes = 0;
    let total = 0;
    let totalCost = 0;

    for (const exp of toolExecutions) {
      const data = exp.data as { success?: boolean; costCents?: number } | undefined;
      total++;
      if (data?.success) successes++;
      if (data?.costCents) totalCost += data.costCents;
    }

    return {
      completionRate: total > 0 ? successes / total : 0.5,
      avgStagnationRate: total > 0 ? stagnations.length / total : 0,
      avgCostPerTask: total > 0 ? totalCost / total : 0,
    };
  }
}
