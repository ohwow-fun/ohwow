/**
 * Cross-Environment Step Executor (Local Side)
 *
 * When the local sequential executor encounters a step with
 * `environment: 'cloud'`, this module dispatches it to the
 * cloud via the ControlPlaneClient proxy.
 *
 * Falls back to local execution if no cloud connection is available.
 */

import type { ControlPlaneClient } from '../../control-plane/client.js';
import type { SequenceStepResult, SequenceStep } from './types.js';
import { logger } from '../../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface CrossEnvStepInput {
  step: SequenceStep;
  wave: number;
  taskInput: string;
  controlPlane: ControlPlaneClient | null;
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

/**
 * Dispatch a step to the cloud via the control plane proxy.
 * Returns null if no cloud connection (caller should fall back to local).
 */
export async function executeStepOnCloud(
  input: CrossEnvStepInput
): Promise<SequenceStepResult | null> {
  const { step, wave, taskInput, controlPlane } = input;
  const startTime = Date.now();

  if (!controlPlane) {
    logger.info({ stepId: step.id }, '[CrossEnv] No control plane available, falling back to local');
    return null;
  }

  try {
    const result = await controlPlane.proxyCloudPost(
      '/api/agents/sequences/execute-step',
      {
        agentId: step.agentId,
        stepPrompt: step.prompt,
        stepId: step.id,
        predecessorContext: taskInput !== step.prompt ? taskInput : undefined,
      }
    );

    if (!result.ok) {
      logger.warn({ error: result.error, stepId: step.id }, '[CrossEnv] Cloud step execution failed');
      return null;
    }

    const data = result.data as {
      success: boolean;
      taskId?: string;
      output?: string;
      inputTokens?: number;
      outputTokens?: number;
      costCents?: number;
      durationMs?: number;
      error?: string;
    };

    return {
      stepId: step.id,
      agentId: step.agentId,
      taskId: data.taskId,
      status: data.success ? 'completed' : 'failed',
      output: data.output ?? '',
      wave,
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: data.durationMs ?? (Date.now() - startTime),
      inputTokens: data.inputTokens ?? 0,
      outputTokens: data.outputTokens ?? 0,
      costCents: data.costCents ?? 0,
      error: data.error,
    };
  } catch (err) {
    logger.warn({ err, stepId: step.id }, '[CrossEnv] Cloud dispatch failed');
    return null;
  }
}
