/**
 * Temporal Frame — Time Consciousness (Heidegger)
 *
 * "Temporality temporalizes itself as a future which makes present
 * in the process of having been." — Martin Heidegger, Being and Time
 *
 * Heidegger's analysis of Dasein's temporality:
 * - Retention: the just-past that still shapes the present
 * - Primal Impression: the living now
 * - Protention: the anticipated future that draws us forward
 *
 * The brain doesn't just have "history." It has temporal consciousness:
 * - The past is retained as context that fades with time
 * - The future is anticipated through prediction patterns
 * - Prediction errors (where past protentions were wrong) are the
 *   primary learning signal
 *
 * This module builds TemporalFrame snapshots from the ExperienceStream.
 * The reflection module uses these for temporally-aware re-anchoring,
 * and the predictive engine uses prediction errors for calibration.
 */

import type {
  TemporalFrame,
  Stimulus,
  Experience,
  Prediction,
  PredictionError,
} from './types.js';
import type { ExperienceStream } from './experience-stream.js';
import type { PredictiveEngine } from './predictive-engine.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** How many recent experiences to keep in retention. */
const RETENTION_SIZE = 10;

/** How many predictions to generate for protention. */
const MAX_PROTENTIONS = 3;

/** Maximum prediction errors to include (most recent). */
const MAX_PREDICTION_ERRORS = 5;

/** Time window for "recent" prediction errors (ms). */
const PREDICTION_ERROR_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// TEMPORAL FRAME BUILDER
// ============================================================================

/**
 * Builds a TemporalFrame snapshot from the brain's current state.
 *
 * The TemporalFrame is not stored; it is computed fresh each cognitive
 * cycle. It represents the brain's temporal consciousness at this moment:
 * what it remembers, what it perceives, and what it anticipates.
 */
export class TemporalFrameBuilder {
  constructor(
    private experienceStream: ExperienceStream,
    private predictiveEngine?: PredictiveEngine,
  ) {}

  /**
   * Build a temporal frame for the current moment.
   *
   * @param currentStimulus - The stimulus being processed right now
   * @param recentToolNames - The last few tools used (for protention)
   */
  build(currentStimulus: Stimulus, recentToolNames?: string[]): TemporalFrame {
    return {
      retention: this.buildRetention(),
      impression: currentStimulus,
      protention: this.buildProtention(recentToolNames),
      predictionErrors: this.buildPredictionErrors(),
    };
  }

  /**
   * Build the retention: recent experiences that still shape the present.
   *
   * Heidegger: retention is not "memory" (explicit recall). It is the
   * just-past that is still implicitly present, like the notes of a
   * melody that have just passed but still inform the current note.
   */
  private buildRetention(): Experience[] {
    return this.experienceStream.getRecent(RETENTION_SIZE);
  }

  /**
   * Build protentions: anticipated future experiences.
   *
   * Heidegger: protention is the anticipated future that draws us forward.
   * It is not a prediction (explicit forecast) but an implicit expectation.
   * When you hear do-re-mi, you expect "fa" — that's protention.
   *
   * We generate protentions from:
   * 1. Tool sequence patterns (if the last tool was X, Y usually follows)
   * 2. Predictive engine's success/failure expectations
   */
  private buildProtention(recentToolNames?: string[]): Prediction[] {
    const protentions: Prediction[] = [];

    if (!recentToolNames || recentToolNames.length === 0) {
      return protentions;
    }

    const lastTool = recentToolNames[recentToolNames.length - 1];

    // If we have a predictive engine, ask it about the last tool
    if (this.predictiveEngine) {
      const successRate = this.predictiveEngine.getToolSuccessRate(lastTool);
      if (successRate < 0.4) {
        const alternative = this.predictiveEngine.suggestAlternative(lastTool);
        protentions.push({
          target: lastTool,
          expectedResult: 'failure',
          confidence: 1 - successRate,
          basis: `${lastTool} has been failing frequently (${Math.round(successRate * 100)}% success)`,
          suggestedAlternative: alternative ?? undefined,
        });
      }
    }

    // Pattern-based protention: common sequences
    // (This will be enhanced when connected to the self-improvement pattern miner)
    const recentExecs = this.experienceStream.getRecentToolExecutions(5);
    if (recentExecs.length >= 2) {
      // Detect if we're in a repeating pattern
      const toolSequence = recentExecs.map(e => e.toolName);
      const lastTwo = toolSequence.slice(-2);

      // If the same pair keeps repeating, protend a third
      const repeatCount = countConsecutiveRepeats(toolSequence, lastTwo);
      if (repeatCount >= 2) {
        protentions.push({
          target: lastTwo.join(' → '),
          expectedResult: 'partial',
          confidence: 0.6,
          basis: `The sequence ${lastTwo.join(' → ')} has repeated ${repeatCount} times`,
        });
      }
    }

    return protentions.slice(0, MAX_PROTENTIONS);
  }

  /**
   * Collect recent prediction errors.
   *
   * These are the brain's primary learning signal. Where the brain
   * expected one thing and got another, that delta contains information.
   */
  private buildPredictionErrors(): PredictionError[] {
    const errorExperiences = this.experienceStream.query({
      types: ['prediction_error'],
      after: Date.now() - PREDICTION_ERROR_WINDOW_MS,
      limit: MAX_PREDICTION_ERRORS,
    });

    return errorExperiences.map(exp => {
      const data = exp.data as PredictionError;
      return data;
    }).filter(Boolean);
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Count how many times a subsequence repeats at the end of a sequence.
 */
function countConsecutiveRepeats(sequence: string[], pattern: string[]): number {
  if (pattern.length === 0 || sequence.length < pattern.length) return 0;

  let count = 0;
  let pos = sequence.length;

  while (pos >= pattern.length) {
    const slice = sequence.slice(pos - pattern.length, pos);
    const matches = slice.every((s, i) => s === pattern[i]);
    if (!matches) break;
    count++;
    pos -= pattern.length;
  }

  return count;
}

// ============================================================================
// REFLECTION INTEGRATION
// ============================================================================

/**
 * Build a temporally-aware reflection prompt.
 *
 * This enhances the existing buildReflectionPrompt() from reflection.ts
 * with temporal context: what patterns have emerged, what predictions
 * have failed, and what the brain anticipates next.
 *
 * When the TemporalFrame is not available, callers should fall back
 * to the existing static reflection prompt.
 */
export function buildTemporalReflection(
  frame: TemporalFrame,
  userMessage: string,
  iteration: number,
  maxIterations: number,
): string {
  const parts: string[] = [];

  // Retention summary: what has been tried
  const recentTools = frame.retention
    .filter(e => e.type === 'tool_executed')
    .map(e => {
      const data = e.data as { toolName: string; success: boolean } | undefined;
      return data ? `${data.toolName}: ${data.success ? 'OK' : 'FAILED'}` : null;
    })
    .filter(Boolean);

  if (recentTools.length > 0) {
    parts.push(`Recent actions: ${recentTools.join(', ')}`);
  }

  // Prediction errors: where expectations were wrong
  if (frame.predictionErrors.length > 0) {
    const lessons = frame.predictionErrors
      .slice(-2)
      .map(e => e.lesson)
      .join('; ');
    parts.push(`Lessons from errors: ${lessons}`);
  }

  // Protention: what the brain anticipates
  if (frame.protention.length > 0) {
    const anticipations = frame.protention
      .map(p => {
        if (p.expectedResult === 'failure' && p.suggestedAlternative) {
          return `${p.target} may fail. Consider ${p.suggestedAlternative}.`;
        }
        return `Anticipated: ${p.target} → ${p.expectedResult}`;
      })
      .join(' ');
    parts.push(anticipations);
  }

  // Truncate user message for re-anchoring
  const displayMessage = userMessage.length > 200
    ? userMessage.slice(0, 200) + '...'
    : userMessage;

  const iterationWarning = iteration >= maxIterations - 2
    ? ` You are near the iteration limit (${iteration + 1}/${maxIterations}). Synthesize now.`
    : '';

  const temporalContext = parts.length > 0 ? `\n${parts.join('\n')}` : '';

  return `[Progress: iteration ${iteration + 1}/${maxIterations}. Original task: "${displayMessage}"${temporalContext}

Decision: If you have enough information, write your final answer now. If not, call another tool with a different approach.${iterationWarning}]`;
}
