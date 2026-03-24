/**
 * Execution Policy
 * Per-operation routing policies for hybrid local/cloud execution.
 * Controls where each operation type runs and how fallback works.
 */

/** Categories of operations for execution routing. */
export type OperationType =
  | 'orchestrator_chat'
  | 'agent_task'
  | 'planning'
  | 'browser_automation'
  | 'memory_extraction'
  | 'ocr'
  | 'workflow_step'
  | 'simple_classification'
  | 'desktop_control';

/** Where to execute and how to fall back. */
export interface ExecutionPolicy {
  /** Primary model source for this operation */
  modelSource: 'local' | 'cloud' | 'auto';
  /** Fallback source if primary fails or is unavailable */
  fallback: 'local' | 'cloud' | 'none';
  /** Max credits to spend on this operation before falling back to local */
  creditBudget?: number;
}

/**
 * Smart defaults per operation type.
 *
 * Philosophy:
 * - Cheap, routine tasks default to local (memory extraction, classification)
 * - Quality-sensitive tasks default to cloud (planning, complex reasoning)
 * - Interactive tasks default to auto (orchestrator, agent tasks)
 * - Everything falls back to local when possible (credits exhausted, cloud down)
 */
export const DEFAULT_POLICIES: Record<OperationType, ExecutionPolicy> = {
  orchestrator_chat:    { modelSource: 'auto',  fallback: 'local' },
  agent_task:           { modelSource: 'auto',  fallback: 'local' },
  planning:             { modelSource: 'cloud', fallback: 'local' },
  browser_automation:   { modelSource: 'local', fallback: 'cloud' },
  memory_extraction:    { modelSource: 'local', fallback: 'none' },
  ocr:                  { modelSource: 'local', fallback: 'cloud' },
  workflow_step:        { modelSource: 'auto',  fallback: 'local' },
  simple_classification: { modelSource: 'local', fallback: 'none' },
  desktop_control:       { modelSource: 'cloud', fallback: 'none' },
};

/**
 * Resolve the effective policy for an operation.
 * User overrides take precedence over defaults.
 */
export function resolvePolicy(
  operationType: OperationType,
  userOverrides?: Partial<Record<OperationType, ExecutionPolicy>>
): ExecutionPolicy {
  return userOverrides?.[operationType] ?? DEFAULT_POLICIES[operationType];
}

/**
 * Determine if an operation should prefer local execution given credit state.
 * Returns true when credits are low and the operation supports local fallback.
 */
export function shouldPreferLocal(
  policy: ExecutionPolicy,
  creditBalancePercent: number,
  lowCreditThreshold: number = 10
): boolean {
  if (policy.modelSource === 'local') return true;
  if (policy.modelSource === 'cloud') return false;
  // auto mode: prefer local when credits are low
  return creditBalancePercent <= lowCreditThreshold && policy.fallback !== 'none';
}
