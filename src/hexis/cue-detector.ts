/**
 * Cue Detector — matches current context against known habit cues.
 * Pure function: no side effects, no DB access.
 */

import type { Habit, HabitMatch } from './types.js';

/**
 * Detect which habits match the current intent and recent tool usage.
 * Returns matches sorted by (habit strength * cue confidence), descending.
 * Only returns matches with confidence > 0.3.
 */
export function detectCues(
  intent: string,
  recentTools: string[],
  habits: Habit[],
): HabitMatch[] {
  const matches: HabitMatch[] = [];
  const intentLower = intent.toLowerCase();

  for (const habit of habits) {
    const cue = habit.cue;
    let confidence = 0;

    switch (cue.type) {
      case 'intent_match': {
        const patternLower = cue.pattern.toLowerCase();
        if (intentLower.includes(patternLower)) {
          confidence = cue.confidence;
        }
        break;
      }

      case 'context_match': {
        const patternLower = cue.pattern.toLowerCase();
        if (intentLower.includes(patternLower)) {
          confidence = cue.confidence * 0.8; // slightly lower confidence for context
        }
        break;
      }

      case 'sequential': {
        const lastTool = recentTools.length > 0 ? recentTools[recentTools.length - 1] : null;
        if (lastTool && lastTool === cue.pattern) {
          confidence = cue.confidence;
        }
        break;
      }

      case 'temporal':
        // Temporal cues are handled by the scheduler, not in-context detection
        break;
    }

    if (confidence > 0.3) {
      const toolCount = habit.routine.toolSequence.length;
      matches.push({
        habit,
        cueMatchConfidence: confidence,
        suggestedShortcut: `Run "${habit.name}" (${habit.routine.description})`,
        savingsEstimate: toolCount > 1
          ? `skip ${toolCount - 1} deliberation step${toolCount - 1 === 1 ? '' : 's'}`
          : 'execute immediately',
      });
    }
  }

  // Sort by combined score: strength * confidence, descending
  matches.sort((a, b) => {
    const scoreA = a.habit.strength * a.cueMatchConfidence;
    const scoreB = b.habit.strength * b.cueMatchConfidence;
    return scoreB - scoreA;
  });

  return matches;
}
