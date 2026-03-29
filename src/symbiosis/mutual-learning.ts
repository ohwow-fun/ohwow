/**
 * Mutual Learning — Tracking bidirectional growth
 *
 * True symbiosis: both parties grow
 *
 * In a healthy partnership, learning flows both ways. When a human
 * uses an agent's output without changes, the agent may have taught
 * the human something (or at least saved them the effort of thinking
 * through it). When a human modifies the output but still uses it,
 * they are teaching the agent what "good" looks like.
 *
 * These are proxy signals, not ground truth. But over time, the
 * ratios tell a story about who is learning from whom.
 *
 * Pure functions. No LLM. No database.
 */

import type { LearningInput, LearningMetrics } from './types.js';

/**
 * Detect learning events from task output history.
 *
 * Heuristics:
 * - **Agent taught human**: Output was used without modification.
 *   The human accepted the agent's judgment or approach.
 * - **Human taught agent**: Output was modified but still used.
 *   The human corrected the agent, providing a learning signal.
 * - Output not used at all: neither party learned (task was a miss).
 *
 * @param tasks - Array of task outputs with modification and usage flags
 * @returns Learning metrics for the partnership
 */
export function detectLearnings(tasks: LearningInput[]): LearningMetrics {
  let agentTaughtHuman = 0;
  let humanTaughtAgent = 0;

  for (const task of tasks) {
    if (!task.outputUsed) {
      // Output rejected entirely; no learning signal
      continue;
    }

    if (task.humanModified) {
      // Human corrected the output but kept it: teaching moment for agent
      humanTaughtAgent++;
    } else {
      // Human accepted as-is: agent's judgment was trusted/educational
      agentTaughtHuman++;
    }
  }

  return { agentTaughtHuman, humanTaughtAgent };
}
