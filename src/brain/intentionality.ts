/**
 * Intentionality — Phenomenological Intent Enrichment (Husserl)
 *
 * "Consciousness is always consciousness OF something."
 * — Edmund Husserl, Logical Investigations
 *
 * Husserl's key insight: every mental act has a structure:
 * - Noema: WHAT is intended (the classified intent)
 * - Noesis: HOW it is intended (the mode, confidence)
 * - Horizon: the implicit background expectations
 *
 * The horizon is what makes this more than regex pattern matching.
 * When the user says "set up email automation," the horizon includes:
 * - The expectation that automation tools will be needed
 * - The implied context that the user has an email service
 * - The uncertainty about which email service they use
 *
 * This module wraps the existing classifyIntent() without replacing it.
 * The regex classifier provides the noema; this adds the horizon.
 * No LLM calls. Pure heuristic enrichment.
 */

import type { ClassifiedIntent } from '../orchestrator/orchestrator-types.js';
import type { IntentSection } from '../orchestrator/tool-definitions.js';
import type { EnrichedIntent, ContextHorizon } from './types.js';
import type { ExperienceStream } from './experience-stream.js';

// ============================================================================
// HORIZON PATTERNS — What comes next, what's implied, what's uncertain
// ============================================================================

/**
 * Maps intent → sections that the NEXT turn will likely need.
 * This is the "protention" aspect: anticipating what comes next.
 */
const NEXT_TURN_PREDICTIONS: Record<string, { sections: IntentSection[]; expectedAction: string }> = {
  greeting: { sections: ['pulse', 'agents'], expectedAction: 'user will ask about status or give a task' },
  task: { sections: ['agents', 'projects'], expectedAction: 'user will confirm or adjust the task' },
  file: { sections: ['filesystem'], expectedAction: 'user will ask to edit or search more files' },
  status: { sections: ['agents', 'projects', 'pulse'], expectedAction: 'user will drill into a specific metric' },
  research: { sections: ['rag', 'browser'], expectedAction: 'user will ask follow-up questions' },
  crm: { sections: ['memory', 'agents'], expectedAction: 'user will ask to act on a contact' },
  message: { sections: ['channels'], expectedAction: 'user will confirm or adjust the message' },
  media: { sections: ['agents'], expectedAction: 'user will review or iterate on generated media' },
  browser: { sections: ['browser'], expectedAction: 'user will ask to interact with the page' },
  desktop: { sections: ['desktop'], expectedAction: 'user will ask for another desktop action' },
  plan: { sections: ['agents', 'projects'], expectedAction: 'user will confirm or modify the plan' },
};

/**
 * Keywords that imply additional context sections beyond the classified intent.
 * The horizon detects these to pre-warm context that the regex classifier misses.
 */
const IMPLICATION_PATTERNS: Array<{ pattern: RegExp; impliedSections: IntentSection[]; context: string }> = [
  { pattern: /\b(automat|workflow|trigger|schedule|cron)\b/i, impliedSections: ['agents', 'projects'], context: 'automation tools likely needed' },
  { pattern: /\b(contact|lead|customer|deal|pipeline)\b/i, impliedSections: ['memory'], context: 'CRM context likely needed' },
  { pattern: /\b(remember|recall|last time|previously|before)\b/i, impliedSections: ['memory', 'rag'], context: 'memory retrieval likely needed' },
  { pattern: /\b(connect|integrat|api|webhook|slack|discord)\b/i, impliedSections: ['channels', 'agents'], context: 'integration context likely needed' },
  { pattern: /\b(cost|credit|usage|billing|budget)\b/i, impliedSections: ['pulse', 'business'], context: 'business metrics likely needed' },
  { pattern: /\b(team|agent|delegate|assign)\b/i, impliedSections: ['agents'], context: 'agent roster likely needed' },
  { pattern: /\b(goal|okr|kpi|metric|target)\b/i, impliedSections: ['projects', 'pulse'], context: 'goals and tracking likely needed' },
];

/**
 * Patterns that signal uncertainty — the brain should clarify or be cautious.
 */
const UNCERTAINTY_PATTERNS: Array<{ pattern: RegExp; uncertainty: string }> = [
  { pattern: /\b(maybe|perhaps|not sure|i think|might|possibly)\b/i, uncertainty: 'user expressed uncertainty about their request' },
  { pattern: /\b(or|either|alternatively|option)\b/i, uncertainty: 'user presented alternatives; may need clarification' },
  { pattern: /\b(what do you think|should i|recommend|suggest)\b/i, uncertainty: 'user seeking advice rather than giving instruction' },
  { pattern: /\b(everything|all|anything|whatever)\b/i, uncertainty: 'request is very broad; may need scoping' },
];

// ============================================================================
// ENRICHMENT
// ============================================================================

/**
 * Enrich a classified intent with phenomenological depth.
 *
 * The classified intent is the noema (what is intended).
 * This function adds the horizon (implicit expectations).
 *
 * @param classified - The regex-based classification from intent-classifier.ts
 * @param userMessage - The raw user message
 * @param conversationHistory - Recent conversation turns (for context)
 * @param experienceStream - The brain's experience log (for pattern detection)
 */
export function enrichIntent(
  classified: ClassifiedIntent,
  userMessage: string,
  conversationHistory?: Array<{ role: string; content: string }>,
  experienceStream?: ExperienceStream,
): EnrichedIntent {
  const horizon = buildHorizon(classified, userMessage, conversationHistory, experienceStream);
  const confidence = estimateConfidence(classified, userMessage, conversationHistory);

  return {
    ...classified,
    // Merge horizon-implied sections into the classified sections
    sections: mergeSections(classified.sections, horizon.preWarmSections),
    horizon,
    confidence,
  };
}

// ============================================================================
// HORIZON BUILDING
// ============================================================================

function buildHorizon(
  classified: ClassifiedIntent,
  userMessage: string,
  conversationHistory?: Array<{ role: string; content: string }>,
  experienceStream?: ExperienceStream,
): ContextHorizon {
  // 1. Expected next action (protention)
  const nextPrediction = NEXT_TURN_PREDICTIONS[classified.intent];
  const expectedNextAction = nextPrediction?.expectedAction ?? null;

  // 2. Implied context from keywords
  const impliedContext: string[] = [];
  const preWarmSections: IntentSection[] = [];

  // Add next-turn sections for pre-warming
  if (nextPrediction) {
    for (const section of nextPrediction.sections) {
      if (!classified.sections.has(section)) {
        preWarmSections.push(section);
      }
    }
  }

  // Scan for implication patterns
  for (const { pattern, impliedSections, context } of IMPLICATION_PATTERNS) {
    if (pattern.test(userMessage)) {
      impliedContext.push(context);
      for (const section of impliedSections) {
        if (!classified.sections.has(section) && !preWarmSections.includes(section)) {
          preWarmSections.push(section);
        }
      }
    }
  }

  // 3. Detect uncertainties
  const uncertainties: string[] = [];
  for (const { pattern, uncertainty } of UNCERTAINTY_PATTERNS) {
    if (pattern.test(userMessage)) {
      uncertainties.push(uncertainty);
    }
  }

  // 4. Conversation context enrichment
  if (conversationHistory && conversationHistory.length > 0) {
    const lastAssistant = conversationHistory
      .filter(m => m.role === 'assistant')
      .pop();

    // If assistant just asked a question, user is likely answering it
    if (lastAssistant?.content.includes('?')) {
      impliedContext.push('this may be an answer to a previous question');
    }

    // If the conversation has been about a specific topic, carry that forward
    const recentTopics = extractTopicsFromHistory(conversationHistory.slice(-4));
    if (recentTopics.length > 0) {
      impliedContext.push(`conversation is about: ${recentTopics.join(', ')}`);
    }
  }

  // 5. Experience-stream enrichment
  if (experienceStream) {
    // If recent tools have been failing, note that
    const recentFailures = experienceStream.query({
      types: ['prediction_error'],
      limit: 3,
    });
    if (recentFailures.length >= 2) {
      uncertainties.push('recent tool failures detected; may need alternative approach');
    }
  }

  return {
    expectedNextAction,
    impliedContext,
    uncertainties,
    preWarmSections,
  };
}

// ============================================================================
// CONFIDENCE ESTIMATION
// ============================================================================

/**
 * Estimate confidence in the intent classification.
 *
 * - Regex match with no ambiguity: 0.8
 * - Regex match confirmed by conversation context: 0.9
 * - General fallback (no pattern matched): 0.5
 * - Ambiguous (multiple patterns could match): 0.6
 */
function estimateConfidence(
  classified: ClassifiedIntent,
  userMessage: string,
  conversationHistory?: Array<{ role: string; content: string }>,
): number {
  // General fallback has lowest confidence
  if (classified.intent === 'general') return 0.5;

  // Base confidence from regex classification
  let confidence = 0.75;

  // Boost if message is short and specific (less ambiguity)
  if (userMessage.split(/\s+/).length <= 8) confidence += 0.05;

  // Boost if conversation history supports this intent
  if (conversationHistory && conversationHistory.length > 0) {
    const recentIntentWords = conversationHistory
      .slice(-2)
      .map(m => m.content.toLowerCase())
      .join(' ');

    // If the conversation has been about the same topic, confidence rises
    if (classified.intent === 'file' && /file|code|edit/i.test(recentIntentWords)) confidence += 0.1;
    if (classified.intent === 'crm' && /contact|lead|customer/i.test(recentIntentWords)) confidence += 0.1;
    if (classified.intent === 'research' && /research|search|find/i.test(recentIntentWords)) confidence += 0.1;
    if (classified.intent === 'browser' && /website|browse|url/i.test(recentIntentWords)) confidence += 0.1;
  }

  // Cap at 0.95 (never 100% confident from heuristics alone)
  return Math.min(0.95, confidence);
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Merge pre-warm sections into the existing section set.
 */
function mergeSections(existing: Set<IntentSection>, additional: IntentSection[]): Set<IntentSection> {
  if (additional.length === 0) return existing;
  const merged = new Set(existing);
  for (const section of additional) {
    merged.add(section);
  }
  return merged;
}

/**
 * Extract rough topics from recent conversation turns.
 */
function extractTopicsFromHistory(messages: Array<{ role: string; content: string }>): string[] {
  const topics: string[] = [];
  const combined = messages.map(m => m.content.toLowerCase()).join(' ');

  if (/\b(agent|task|automat)\b/.test(combined)) topics.push('agents/tasks');
  if (/\b(contact|lead|customer|crm)\b/.test(combined)) topics.push('CRM');
  if (/\b(file|code|edit|write)\b/.test(combined)) topics.push('files');
  if (/\b(website|url|browse|scrape)\b/.test(combined)) topics.push('browsing');
  if (/\b(email|whatsapp|telegram|message)\b/.test(combined)) topics.push('messaging');
  if (/\b(plan|goal|strategy)\b/.test(combined)) topics.push('planning');

  return topics;
}
