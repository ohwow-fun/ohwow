/**
 * WisdomEngine — Prefrontal Cortex (Luria's Executive Function)
 *
 * "The only true wisdom is in knowing you know nothing." — Socrates
 * "Before I act, I consult the wisest part of myself." — Plato's Logistikon
 *
 * Wisdom is the deliberative, strategic layer that consults a stronger
 * model at key decision points. Unlike the Dialectic (a quick gut reaction
 * using the cheapest model), Wisdom is a deep strategic consultation
 * using the STRONGEST available model.
 *
 * Embodied in ohwow's cognitive architecture as an autonomous brain
 * process — not a tool the executor calls, but an inner voice that
 * speaks when the stakes are high.
 *
 * Three triggers:
 * - planning: Before starting complex work (System 2 activation)
 * - stuck: When stagnation is detected (error recovery escalation)
 * - validation: Before declaring completion (quality gate)
 *
 * Cost: ~600 tokens output per call at the strongest model's rates.
 * Default cap: 3 calls per session.
 */

import type { ModelRouter } from '../execution/model-router.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export type WisdomTrigger = 'planning' | 'stuck' | 'validation';

export interface WisdomResult {
  /** Whether wisdom was actually sought. */
  consulted: boolean;
  /** Strategic guidance text. null if not consulted or approach validated. */
  guidance: string | null;
  /** Why wisdom was sought. */
  reason: WisdomTrigger;
  /** Which model provided the guidance. */
  model: string;
  /** Total tokens used (input + output). */
  tokensUsed: number;
}

export interface WisdomContext {
  /** The original user request. */
  userMessage: string;
  /** Condensed tool call history (name: OK/FAILED). */
  toolHistory: string;
  /** What the executor has generated so far. */
  currentContent: string;
  /** Condensed business/agent context. */
  systemContext: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const WISDOM_SYSTEM_PROMPT = `You are the inner wisdom of an AI orchestrator that is mid-task.
You see what has been attempted and what the results were.

Your job:
1. Assess whether the current approach is working
2. Identify blind spots, missed strategies, or wrong assumptions
3. Give concrete, actionable next steps

Rules:
- Be specific and practical (not vague)
- Under 300 words
- If the approach is solid and on track, respond with just "PROCEED"
- Focus on WHAT to do differently, not on describing what went wrong
- If tools are failing, suggest alternative tools or approaches
- If the task requires multiple agents, suggest which agents to delegate to`;

const TRIGGER_DESCRIPTIONS: Record<WisdomTrigger, string> = {
  planning: 'Pre-flight: The orchestrator is about to start a complex multi-step task and wants strategic direction before committing to an approach.',
  stuck: 'Stuck: The orchestrator has been stagnating (repeated failures or identical tool calls). It needs a course correction.',
  validation: 'Completion check: The orchestrator believes it has completed the task and wants validation before reporting to the user.',
};

// ============================================================================
// WISDOM ENGINE
// ============================================================================

export class WisdomEngine {
  private callsThisSession = 0;
  private maxCallsPerSession: number;

  constructor(maxCalls = 3) {
    this.maxCallsPerSession = maxCalls;
  }

  /** Can wisdom still be sought this session? */
  canSeek(): boolean {
    return this.callsThisSession < this.maxCallsPerSession;
  }

  /** Reset call counter for a new session/turn. */
  resetSession(): void {
    this.callsThisSession = 0;
  }

  /**
   * Seek wisdom from the strongest available model.
   *
   * The wisdom engine sees a condensed version of the conversation
   * and returns focused strategic guidance.
   */
  async seek(
    context: WisdomContext,
    reason: WisdomTrigger,
    modelRouter: ModelRouter,
  ): Promise<WisdomResult> {
    if (!this.canSeek()) {
      return { consulted: false, guidance: null, reason, model: '', tokensUsed: 0 };
    }

    try {
      // Get the strongest available provider (escalates to complex difficulty)
      const provider = await modelRouter.getProvider('orchestrator', 'complex');

      const userPrompt = [
        `[TASK]\n${context.userMessage.slice(0, 500)}`,
        context.systemContext ? `\n[BUSINESS CONTEXT]\n${context.systemContext.slice(0, 500)}` : '',
        context.toolHistory ? `\n[TOOL HISTORY]\n${context.toolHistory}` : '',
        context.currentContent ? `\n[CURRENT OUTPUT]\n${context.currentContent.slice(0, 1000)}` : '',
        `\n[REASON FOR CONSULTATION]\n${TRIGGER_DESCRIPTIONS[reason]}`,
      ].filter(Boolean).join('\n');

      const response = await provider.createMessage({
        system: WISDOM_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: 600,
        temperature: 0.3,
      });

      this.callsThisSession++;
      const content = response.content.trim();
      const tokensUsed = response.inputTokens + response.outputTokens;
      const model = response.model || provider.name;

      // If wisdom says PROCEED, approach is validated
      if (content.toUpperCase().startsWith('PROCEED')) {
        logger.debug({ reason, model }, '[Wisdom] Approach validated');
        return { consulted: true, guidance: null, reason, model, tokensUsed };
      }

      logger.info({ reason, model, guidance: content.slice(0, 100) }, '[Wisdom] Guidance provided');
      return { consulted: true, guidance: content, reason, model, tokensUsed };
    } catch (err) {
      logger.error({ err, reason }, '[Wisdom] Consultation failed');
      return { consulted: false, guidance: null, reason, model: '', tokensUsed: 0 };
    }
  }
}
