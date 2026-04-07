/**
 * Sequential Executor — Local Runtime
 *
 * Executes a SequenceDefinition by running agents in topological waves.
 * Each agent sees the actual outputs of its predecessor steps.
 *
 * Uses the RuntimeEngine.executeTask() path (same as run_agent tool).
 * Creates one task per step in the local SQLite database.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { RuntimeEngine } from '../../execution/engine.js';
import type {
  SequenceDefinition,
  SequenceStep,
  SequenceStepResult,
  SequenceResult,
  SequenceEvent,
} from './types.js';
import Anthropic from '@anthropic-ai/sdk';
import type { ModelRouter } from '../../execution/model-router.js';
import { topologicalSort } from './topological-sort.js';
import { buildPredecessorContext } from './predecessor-context.js';
import { checkAbstention } from './abstention-check.js';
import { estimateSequenceCost, checkSequenceBudget } from './cost-estimator.js';
import { logger } from '../../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ExecuteSequenceOptions {
  db: DatabaseAdapter;
  engine: RuntimeEngine;
  workspaceId: string;
  definition: SequenceDefinition;
  onEvent?: (event: SequenceEvent) => void;
  /** Enable abstention checks before each step (default: true). */
  enableAbstention?: boolean;
  /** Anthropic client for abstention checks (if available). */
  anthropic?: Anthropic;
  /** Model router for abstention checks via Ollama. */
  modelRouter?: ModelRouter | null;
  /** Timeout per step in ms (default: 120s). */
  stepTimeoutMs?: number;
}

// ============================================================================
// HELPERS
// ============================================================================

function emit(onEvent: ((e: SequenceEvent) => void) | undefined, event: SequenceEvent): void {
  if (onEvent) {
    try {
      onEvent(event);
    } catch {
      // Swallow event handler errors
    }
  }
}

function skippedResult(step: SequenceStep, wave: number, reason: string): SequenceStepResult {
  return {
    stepId: step.id,
    agentId: step.agentId,
    status: 'skipped',
    wave,
    inputTokens: 0,
    outputTokens: 0,
    costCents: 0,
    error: reason,
  };
}

// ============================================================================
// MAIN EXECUTOR
// ============================================================================

export async function executeSequence(
  options: ExecuteSequenceOptions
): Promise<SequenceResult> {
  const { db, engine, workspaceId, definition, onEvent, stepTimeoutMs = 120_000 } = options;
  const startTime = Date.now();

  const waves = topologicalSort(definition.steps);
  const totalWaves = waves.length;

  emit(onEvent, {
    type: 'sequence_start',
    name: definition.name,
    totalSteps: definition.steps.length,
    waves: totalWaves,
  });

  // Resolve agent names
  const agentIds = [...new Set(definition.steps.map((s) => s.agentId))];
  const agentNames = new Map<string, string>();

  for (const agentId of agentIds) {
    const { data: agent } = await db
      .from('agent_workforce_agents')
      .select('id, name')
      .eq('id', agentId)
      .single();
    if (agent) {
      const a = agent as { id: string; name: string };
      agentNames.set(a.id, a.name);
    }
  }

  // State
  const completedResults = new Map<string, SequenceStepResult>();
  const allResults: SequenceStepResult[] = [];
  let totalCostCents = 0;

  // Save sequence run record
  let runId: string | null = null;
  try {
    const { data: run } = await db
      .from('agent_workforce_sequence_runs')
      .insert({
        workspace_id: workspaceId,
        name: definition.name,
        source_prompt: definition.sourcePrompt ?? null,
        status: 'running',
        steps: JSON.stringify(definition.steps),
        step_results: JSON.stringify([]),
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (run) runId = (run as { id: string }).id;
  } catch (err) {
    logger.warn({ err }, 'Failed to create sequence run record');
  }

  // Pre-execution cost estimate and budget check
  const costEstimate = estimateSequenceCost(definition);
  const budgetCheck = checkSequenceBudget(costEstimate, definition.budgetCents);

  if (!budgetCheck.allowed) {
    const errorResult: SequenceResult = {
      success: false, stepResults: [],
      totalInputTokens: 0, totalOutputTokens: 0, totalCostCents: 0,
      totalDurationMs: Date.now() - startTime,
      participatedCount: 0, abstainedCount: 0, finalOutput: '',
    };
    emit(onEvent, { type: 'sequence_error', error: budgetCheck.reason ?? 'Budget exceeded' });
    return errorResult;
  }

  // Execute waves
  for (let waveIndex = 0; waveIndex < totalWaves; waveIndex++) {
    const wave = waves[waveIndex];
    const waveNumber = waveIndex + 1;

    emit(onEvent, {
      type: 'wave_start',
      wave: waveNumber,
      stepIds: wave.map((s) => s.id),
    });

    // Abstention check phase
    const abstentionEnabled = options.enableAbstention !== false;
    let stepsToExecute = wave;

    if (abstentionEnabled && wave.length > 0 && (options.anthropic || options.modelRouter)) {
      const abstentionResults = await Promise.all(
        wave.map(async (step) => {
          const predecessors = step.dependsOn
            .map((depId) => completedResults.get(depId))
            .filter((r): r is SequenceStepResult => r !== undefined && r.status === 'completed');
          const predecessorSummary = predecessors
            .map((p) => {
              const name = agentNames.get(p.agentId) ?? 'Agent';
              return `${name}: ${(p.output ?? '').slice(0, 200)}`;
            })
            .join('\n');

          const decision = await checkAbstention({
            agentName: agentNames.get(step.agentId) ?? 'Agent',
            agentRole: step.expectedRole ?? '',
            stepPrompt: step.prompt,
            predecessorSummary,
            anthropic: options.anthropic,
            modelRouter: options.modelRouter,
          });

          return { step, decision };
        })
      );

      const participating = abstentionResults.filter((r) => r.decision.participate);
      const abstaining = abstentionResults.filter((r) => !r.decision.participate);

      // Anchor agent: if ALL abstain, force the highest-confidence one
      if (participating.length === 0 && abstaining.length > 0) {
        const anchor = abstaining.reduce((best, curr) =>
          curr.decision.confidence > best.decision.confidence ? curr : best
        );
        stepsToExecute = [anchor.step];

        for (const { step, decision } of abstaining) {
          if (step.id === anchor.step.id) continue;
          const abstainResult: SequenceStepResult = {
            stepId: step.id, agentId: step.agentId, status: 'abstained',
            abstentionReason: decision.reason, wave: waveNumber,
            inputTokens: 0, outputTokens: 0, costCents: 0,
          };
          allResults.push(abstainResult);
          completedResults.set(step.id, abstainResult);
          emit(onEvent, {
            type: 'step_abstained', stepId: step.id, agentId: step.agentId,
            agentName: agentNames.get(step.agentId) ?? 'Agent', reason: decision.reason,
          });
        }
      } else {
        stepsToExecute = participating.map((r) => r.step);
        for (const { step, decision } of abstaining) {
          const abstainResult: SequenceStepResult = {
            stepId: step.id, agentId: step.agentId, status: 'abstained',
            abstentionReason: decision.reason, wave: waveNumber,
            inputTokens: 0, outputTokens: 0, costCents: 0,
          };
          allResults.push(abstainResult);
          completedResults.set(step.id, abstainResult);
          emit(onEvent, {
            type: 'step_abstained', stepId: step.id, agentId: step.agentId,
            agentName: agentNames.get(step.agentId) ?? 'Agent', reason: decision.reason,
          });
        }
      }
    }

    // Execute participating steps concurrently
    const wavePromises = stepsToExecute.map((step) =>
      executeStep({
        step,
        wave: waveNumber,
        db,
        engine,
        workspaceId,
        completedResults,
        agentNames,
        definition,
        stepTimeoutMs,
        onEvent,
      })
    );

    const waveResults = await Promise.allSettled(wavePromises);

    for (let i = 0; i < waveResults.length; i++) {
      const settled = waveResults[i];
      const step = stepsToExecute[i];

      let result: SequenceStepResult;
      if (settled.status === 'fulfilled') {
        result = settled.value;
      } else {
        result = skippedResult(step, waveNumber, settled.reason?.message ?? 'Unexpected error');
        result.status = 'failed';
      }

      allResults.push(result);
      completedResults.set(step.id, result);
      totalCostCents += result.costCents;

      emit(onEvent, {
        type: 'step_complete',
        stepId: step.id,
        status: result.status,
        durationMs: result.durationMs ?? 0,
        costCents: result.costCents,
      });
    }

    emit(onEvent, { type: 'wave_complete', wave: waveNumber });

    // Budget check
    if (definition.budgetCents && totalCostCents >= definition.budgetCents) {
      emit(onEvent, {
        type: 'cost_warning',
        currentCostCents: totalCostCents,
        budgetCents: definition.budgetCents,
      });
      for (let futureWave = waveIndex + 1; futureWave < totalWaves; futureWave++) {
        for (const step of waves[futureWave]) {
          allResults.push(skippedResult(step, futureWave + 1, 'Budget exceeded'));
        }
      }
      break;
    }
  }

  // Build result
  const participatedCount = allResults.filter((r) => r.status === 'completed').length;
  const abstainedCount = allResults.filter((r) => r.status === 'abstained').length;
  const success = allResults.some((r) => r.status === 'completed');

  const finalOutput = allResults
    .filter((r) => r.status === 'completed' && r.output)
    .map((r) => {
      const name = agentNames.get(r.agentId) ?? 'Agent';
      const role = r.chosenRole ? ` (${r.chosenRole})` : '';
      return `## ${name}${role}\n\n${r.output}`;
    })
    .join('\n\n---\n\n');

  const sequenceResult: SequenceResult = {
    success,
    stepResults: allResults,
    totalInputTokens: allResults.reduce((sum, r) => sum + r.inputTokens, 0),
    totalOutputTokens: allResults.reduce((sum, r) => sum + r.outputTokens, 0),
    totalCostCents,
    totalDurationMs: Date.now() - startTime,
    participatedCount,
    abstainedCount,
    finalOutput,
  };

  // Update run record
  if (runId) {
    try {
      await db
        .from('agent_workforce_sequence_runs')
        .update({
          status: success ? 'completed' : 'failed',
          step_results: JSON.stringify(allResults),
          total_cost_cents: totalCostCents,
          participated_count: participatedCount,
          abstained_count: abstainedCount,
          final_output: finalOutput || null,
          completed_at: new Date().toISOString(),
        })
        .eq('id', runId);
    } catch (err) {
      logger.warn({ err, runId }, 'Failed to update sequence run record');
    }
  }

  emit(onEvent, { type: 'sequence_complete', result: sequenceResult });

  return sequenceResult;
}

// ============================================================================
// STEP EXECUTION
// ============================================================================

interface ExecuteStepOptions {
  step: SequenceStep;
  wave: number;
  db: DatabaseAdapter;
  engine: RuntimeEngine;
  workspaceId: string;
  completedResults: Map<string, SequenceStepResult>;
  agentNames: Map<string, string>;
  definition: SequenceDefinition;
  stepTimeoutMs: number;
  onEvent?: (event: SequenceEvent) => void;
}

async function executeStep(options: ExecuteStepOptions): Promise<SequenceStepResult> {
  const {
    step, wave, db, engine, workspaceId,
    completedResults, agentNames, definition, stepTimeoutMs,
  } = options;

  const stepStart = Date.now();

  // Check dependencies
  for (const depId of step.dependsOn) {
    const depResult = completedResults.get(depId);
    if (!depResult || (depResult.status !== 'completed' && depResult.status !== 'abstained')) {
      return skippedResult(step, wave, `Dependency ${depId} did not complete successfully`);
    }
  }

  // Build predecessor context
  const predecessors = step.dependsOn
    .map((depId) => completedResults.get(depId))
    .filter((r): r is SequenceStepResult => r !== undefined);

  const predecessorContext = buildPredecessorContext({
    predecessors,
    agentNames,
  });

  const taskInput = predecessorContext
    ? `${predecessorContext}\n\n---\n\n## Your Task\n\n${step.prompt}`
    : step.prompt;

  // Create task in SQLite
  const { data: task } = await db
    .from('agent_workforce_tasks')
    .insert({
      workspace_id: workspaceId,
      agent_id: step.agentId,
      title: `[Sequence] ${definition.name} — ${step.id}`,
      input: taskInput,
      status: 'pending',
      requires_approval: 0,
    })
    .select('id')
    .single();

  if (!task) {
    return {
      stepId: step.id,
      agentId: step.agentId,
      status: 'failed',
      wave,
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      error: 'Failed to create task',
    };
  }

  const taskId = (task as { id: string }).id;

  try {
    const result = await Promise.race([
      engine.executeTask(step.agentId, taskId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Step timed out')), stepTimeoutMs)
      ),
    ]);

    const outputText = typeof result.output === 'string'
      ? result.output
      : result.output
        ? JSON.stringify(result.output)
        : '';

    return {
      stepId: step.id,
      agentId: step.agentId,
      taskId,
      status: result.success ? 'completed' : 'failed',
      output: outputText,
      wave,
      startedAt: new Date(stepStart).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - stepStart,
      inputTokens: 0,
      outputTokens: 0,
      costCents: result.costCents,
      error: result.error,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Step execution failed';
    logger.error({ err, stepId: step.id, agentId: step.agentId }, 'Sequential step execution failed');

    return {
      stepId: step.id,
      agentId: step.agentId,
      taskId,
      status: 'failed',
      wave,
      startedAt: new Date(stepStart).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - stepStart,
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      error: errorMessage,
    };
  }
}
