/**
 * Sequence Cost Estimator (Local Runtime)
 *
 * Estimates execution cost before running. For local Ollama models,
 * cost is zero (local inference). For Anthropic-backed models, uses
 * tier-based pricing heuristics.
 */

import type { SequenceDefinition } from './types.js';

// ============================================================================
// TYPES
// ============================================================================

export interface StepCostEstimate {
  stepId: string;
  agentId: string;
  modelTier: 'haiku' | 'sonnet' | 'opus';
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostCents: number;
}

export interface SequenceCostEstimate {
  totalEstimatedCents: number;
  perStep: StepCostEstimate[];
  optimisticCents: number;
  confidence: 'high' | 'medium' | 'low';
}

// ============================================================================
// COST MODEL
// ============================================================================

const TIER_COSTS: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  haiku:  { inputPer1M: 100,  outputPer1M: 500 },
  sonnet: { inputPer1M: 300,  outputPer1M: 1500 },
  opus:   { inputPer1M: 1500, outputPer1M: 7500 },
};

const AVG_TOKENS: Record<string, { input: number; output: number }> = {
  haiku:  { input: 2000, output: 800 },
  sonnet: { input: 3000, output: 1500 },
  opus:   { input: 4000, output: 2000 },
};

const ABSTENTION_CHECK_COST_CENTS = 0.01;

// ============================================================================
// MAIN FUNCTION
// ============================================================================

export function estimateSequenceCost(
  definition: SequenceDefinition
): SequenceCostEstimate {
  const perStep: StepCostEstimate[] = [];

  for (const step of definition.steps) {
    const tier = step.modelTier ?? 'sonnet';
    const costs = TIER_COSTS[tier] ?? TIER_COSTS.sonnet;
    const tokens = AVG_TOKENS[tier] ?? AVG_TOKENS.sonnet;

    const inputCost = (tokens.input / 1_000_000) * costs.inputPer1M;
    const outputCost = (tokens.output / 1_000_000) * costs.outputPer1M;
    const stepCost = Math.ceil(inputCost + outputCost);

    perStep.push({
      stepId: step.id,
      agentId: step.agentId,
      modelTier: tier,
      estimatedInputTokens: tokens.input,
      estimatedOutputTokens: tokens.output,
      estimatedCostCents: stepCost,
    });
  }

  const totalEstimatedCents = perStep.reduce((sum, s) => sum + s.estimatedCostCents, 0);
  const abstentionOverhead = Math.ceil(definition.steps.length * ABSTENTION_CHECK_COST_CENTS);

  const participatingSteps = Math.ceil(perStep.length * 0.5);
  const sortedCosts = [...perStep].sort((a, b) => b.estimatedCostCents - a.estimatedCostCents);
  const optimisticCents = sortedCosts
    .slice(0, participatingSteps)
    .reduce((sum, s) => sum + s.estimatedCostCents, 0) + abstentionOverhead;

  const confidence: 'high' | 'medium' | 'low' =
    definition.steps.length <= 3 ? 'high' :
    definition.steps.length <= 5 ? 'medium' : 'low';

  return {
    totalEstimatedCents: totalEstimatedCents + abstentionOverhead,
    perStep,
    optimisticCents,
    confidence,
  };
}

export function checkSequenceBudget(
  estimate: SequenceCostEstimate,
  budgetCents: number | undefined
): { allowed: boolean; reason?: string } {
  if (!budgetCents) return { allowed: true };

  if (estimate.totalEstimatedCents <= budgetCents) {
    return { allowed: true };
  }

  if (estimate.optimisticCents > budgetCents) {
    return {
      allowed: false,
      reason: `Estimated cost (${estimate.optimisticCents}c even with abstention) exceeds budget (${budgetCents}c)`,
    };
  }

  return { allowed: true };
}
