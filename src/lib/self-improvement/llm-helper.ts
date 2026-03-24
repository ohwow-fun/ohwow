/**
 * LLM Helper — Adapter for ModelRouter in self-improvement modules
 *
 * All self-improvement modules that need LLM calls go through this helper.
 * It abstracts the ModelRouter provider selection and provides a simple
 * call interface that mirrors what the cloud uses.
 */

import type { ModelRouter, ModelMessage, CreateMessageParams } from '../../execution/model-router.js';
import type { LLMCallResult } from './types.js';
import { logger } from '../logger.js';

// ============================================================================
// COST CALCULATION
// ============================================================================

/** Haiku pricing per million tokens (as of 2025) */
const HAIKU_INPUT_COST_PER_M = 0.80;
const HAIKU_OUTPUT_COST_PER_M = 4.00;

/** Calculate cost in cents for a Haiku call */
export function calculateCostCents(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1_000_000) * HAIKU_INPUT_COST_PER_M;
  const outputCost = (outputTokens / 1_000_000) * HAIKU_OUTPUT_COST_PER_M;
  return Math.round((inputCost + outputCost) * 100) / 100;
}

// ============================================================================
// LLM CALL HELPER
// ============================================================================

/**
 * Make an LLM call via ModelRouter for self-improvement tasks.
 * Uses the 'memory_extraction' task type to route appropriately
 * (Ollama when available, Claude fallback).
 */
export async function callLLM(
  router: ModelRouter,
  params: {
    system: string;
    userMessage: string;
    maxTokens?: number;
    temperature?: number;
  },
): Promise<LLMCallResult> {
  try {
    const provider = await router.getProvider('memory_extraction');

    const messages: ModelMessage[] = [
      { role: 'user', content: params.userMessage },
    ];

    const createParams: CreateMessageParams = {
      system: params.system,
      messages,
      maxTokens: params.maxTokens ?? 300,
      temperature: params.temperature ?? 0.3,
    };

    const response = await provider.createMessage(createParams);

    return {
      success: true,
      content: response.content,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      tokensUsed: response.inputTokens + response.outputTokens,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, '[LLMHelper] LLM call failed');
    return {
      success: false,
      content: '',
      inputTokens: 0,
      outputTokens: 0,
      tokensUsed: 0,
      error: message,
    };
  }
}

// ============================================================================
// JSON PARSING HELPER
// ============================================================================

/**
 * Parse JSON from LLM response, handling markdown code fences.
 */
export function parseJSONResponse<T>(content: string): T | null {
  try {
    let raw = content.trim();
    const fenceMatch = raw.match(/^```(?:json)?\s*\n?([\s\S]*?)```$/);
    if (fenceMatch) raw = fenceMatch[1].trim();
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ============================================================================
// KEYWORD UTILITIES (shared across E13, E26)
// ============================================================================

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'and',
  'or', 'but', 'not', 'no', 'it', 'its', 'this', 'that', 'these',
  'those', 'when', 'where', 'what', 'which', 'who', 'whom', 'how',
  'if', 'then', 'than', 'so', 'up', 'out', 'just', 'also', 'very',
]);

/** Extract keywords from text (lowercase, stop-word-filtered) */
export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/** Calculate Jaccard similarity between two keyword sets */
export function keywordOverlap(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
