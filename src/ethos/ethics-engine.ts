import type { DatabaseAdapter } from '../db/adapter-types.js';
import type {
  EthicalContext,
  EthicalEvaluation,
  MoralProfile,
  MoralDevelopmentStage,
  FrameworkResult,
} from './types.js';
import { checkMoralConstraints } from './constraints.js';
import { checkDutyRules } from './deontological.js';
import { predictOutcomes } from './consequentialist.js';
import { assessCharacterAlignment } from './virtue-based.js';
import { assessRelationshipImpact } from './care-based.js';
import { detectDilemma } from './dilemma.js';
import { logger } from '../lib/logger.js';

export class EthicsEngine {
  private evaluationCount = 0;
  private violationCount = 0;
  private dilemmaCount = 0;

  constructor(
    private db: DatabaseAdapter | null,
    private workspaceId: string,
  ) {}

  /**
   * Full ethical evaluation of a proposed action.
   * Runs constraints first (fast), then all 4 frameworks.
   */
  async evaluate(ctx: EthicalContext): Promise<EthicalEvaluation> {
    this.evaluationCount++;

    // Step 1: Hard constraints (synchronous, fast)
    const violations = checkMoralConstraints(ctx);
    if (violations.length > 0) {
      const evaluation: EthicalEvaluation = {
        action: ctx.action,
        permitted: false,
        confidence: 1.0,
        frameworkResults: [],
        constraintViolations: violations,
        dilemmaDetected: false,
        dilemmaDescription: null,
        recommendation: 'block',
        reasoning: `Moral constraint violated: ${violations.join(', ')}`,
      };

      this.violationCount += violations.length;
      await this.persistEvaluation(evaluation);
      logger.info({ action: ctx.action, violations }, 'ethos: constraint violation');
      return evaluation;
    }

    // Step 2: Run all 4 frameworks
    const frameworkResults: FrameworkResult[] = [
      checkDutyRules(ctx),
      predictOutcomes(ctx),
      assessCharacterAlignment(ctx),
      assessRelationshipImpact(ctx),
    ];

    // Step 3: Check for dilemma
    const dilemma = detectDilemma(frameworkResults);
    if (dilemma.detected) {
      this.dilemmaCount++;
    }

    // Step 4: Synthesize recommendation
    const recommendation = synthesizeRecommendation(frameworkResults, dilemma.detected);
    const confidence = frameworkResults.reduce((sum, r) => sum + r.confidence, 0) / frameworkResults.length;

    const evaluation: EthicalEvaluation = {
      action: ctx.action,
      permitted: recommendation !== 'block',
      confidence,
      frameworkResults,
      constraintViolations: [],
      dilemmaDetected: dilemma.detected,
      dilemmaDescription: dilemma.description,
      recommendation,
      reasoning: buildReasoning(frameworkResults, recommendation),
    };

    await this.persistEvaluation(evaluation);
    logger.debug({ action: ctx.action, recommendation }, 'ethos: evaluation complete');
    return evaluation;
  }

  /**
   * Quick constraint check only (no framework evaluation).
   * Use for fast pre-screening before full evaluation.
   */
  quickCheck(ctx: EthicalContext): { permitted: boolean; violations: string[] } {
    const violations = checkMoralConstraints(ctx);
    return {
      permitted: violations.length === 0,
      violations,
    };
  }

  /** Get current moral profile */
  getMoralProfile(): MoralProfile {
    let stage: MoralDevelopmentStage = 'rule_following';
    if (this.evaluationCount > 50 && this.violationCount < 3) {
      stage = 'social_contract';
    }
    if (this.evaluationCount > 200 && this.dilemmaCount > 5) {
      stage = 'principled';
    }

    return {
      stage,
      consistencyScore: this.evaluationCount > 0
        ? 1 - (this.violationCount / this.evaluationCount)
        : 1.0,
      dilemmasResolved: this.dilemmaCount,
      constraintViolations: this.violationCount,
      lastEvaluated: new Date().toISOString(),
    };
  }

  /**
   * Build prompt injection text for ethical awareness.
   * Returns null if no active concerns.
   */
  buildPromptContext(lastEvaluation: EthicalEvaluation | null): string | null {
    if (!lastEvaluation) return null;

    if (lastEvaluation.recommendation === 'proceed') return null;

    const lines: string[] = [];

    if (lastEvaluation.constraintViolations.length > 0) {
      lines.push(`Constraint violations: ${lastEvaluation.constraintViolations.join(', ')}`);
    }

    if (lastEvaluation.dilemmaDetected && lastEvaluation.dilemmaDescription) {
      lines.push(lastEvaluation.dilemmaDescription);
    }

    if (lastEvaluation.recommendation === 'escalate') {
      lines.push('Recommendation: escalate to human for this decision.');
    } else if (lastEvaluation.recommendation === 'proceed_with_caution') {
      lines.push(`Proceed with caution: ${lastEvaluation.reasoning}`);
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  /** Persist evaluation to database */
  private async persistEvaluation(evaluation: EthicalEvaluation): Promise<void> {
    if (!this.db) return;

    try {
      await this.db.from('ethical_evaluations').insert({
        workspace_id: this.workspaceId,
        action: evaluation.action,
        permitted: evaluation.permitted ? 1 : 0,
        recommendation: evaluation.recommendation,
        reasoning: evaluation.reasoning,
        framework_results: JSON.stringify(evaluation.frameworkResults),
        constraint_violations: JSON.stringify(evaluation.constraintViolations),
        dilemma_detected: evaluation.dilemmaDetected ? 1 : 0,
      });
    } catch (err) {
      logger.warn({ err }, 'ethos: failed to persist evaluation');
    }
  }
}

function synthesizeRecommendation(
  results: FrameworkResult[],
  dilemmaDetected: boolean,
): 'proceed' | 'proceed_with_caution' | 'escalate' | 'block' {
  const denials = results.filter(r => r.verdict === 'deny');
  const cautions = results.filter(r => r.verdict === 'caution');

  // Any confident denial -> escalate
  if (denials.some(d => d.confidence > 0.7)) {
    return 'escalate';
  }

  // Multiple denials -> block
  if (denials.length >= 2) {
    return 'block';
  }

  // Dilemma -> escalate
  if (dilemmaDetected) {
    return 'escalate';
  }

  // Single denial or cautions -> caution
  if (denials.length > 0 || cautions.length >= 2) {
    return 'proceed_with_caution';
  }

  // Minor cautions -> proceed with caution
  if (cautions.length > 0) {
    return 'proceed_with_caution';
  }

  return 'proceed';
}

function buildReasoning(results: FrameworkResult[], _recommendation: string): string {
  const reasonings = results
    .filter(r => r.verdict !== 'approve')
    .map(r => `[${r.framework}] ${r.reasoning}`);

  if (reasonings.length === 0) {
    return 'All ethical frameworks approve this action.';
  }

  return reasonings.join(' | ');
}
