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

/**
 * Semantic purpose for an LLM call. A superset of OperationType that adds
 * fine-grained categories agents use when invoking the `llm` organ tool.
 *
 * Purposes are the unit of model routing. Agents act as sub-orchestrators:
 * each step of a cognitive cycle (perceive, deliberate, act, learn) picks a
 * purpose and the router selects the appropriate model given the purpose,
 * agent-level policy, workspace defaults, and runtime signals.
 */
export type Purpose =
  | OperationType
  | 'reasoning'
  | 'generation'
  | 'summarization'
  | 'extraction'
  | 'critique'
  | 'translation'
  | 'embedding';

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

/**
 * Default execution policies for the extended Purpose set. Legacy OperationType
 * values keep their DEFAULT_POLICIES entries; the new purposes get sensible
 * defaults that match the philosophy (cheap/routine local, quality-sensitive
 * cloud, interactive auto).
 */
export const PURPOSE_DEFAULTS: Record<Exclude<Purpose, OperationType>, ExecutionPolicy> = {
  reasoning:     { modelSource: 'auto',  fallback: 'local' },
  generation:    { modelSource: 'auto',  fallback: 'local' },
  summarization: { modelSource: 'local', fallback: 'cloud' },
  extraction:    { modelSource: 'local', fallback: 'none'  },
  critique:      { modelSource: 'cloud', fallback: 'local' },
  translation:   { modelSource: 'local', fallback: 'cloud' },
  embedding:     { modelSource: 'local', fallback: 'none'  },
};

/**
 * Per-agent model policy. Agents NEVER pin a model — the router picks per
 * sub-task. This policy only exposes hard constraints the router must honor
 * while choosing on the agent's behalf.
 *
 * Resolution order for a concrete model string:
 *
 *   1. call-site constraints (tightest win, e.g. `preferModel`)
 *   2. workspace `PURPOSE_DEFAULTS[purpose]`
 *   3. workspace `DEFAULT_POLICIES[operationType]`
 *   4. router internal fallback chain
 *
 * `localOnly` and `maxCostCents` are hard constraints the router must honor.
 */
export interface AgentModelPolicy {
  /** Hard constraint: force local inference for this agent regardless of purpose. */
  localOnly?: boolean;
  /** Hard constraint: reject calls that would exceed this cost in cents. */
  maxCostCents?: number;
  /** Escalation behavior. `on_failure` retries on a more capable model. */
  escalate?: 'never' | 'on_complex' | 'on_failure';
}

/**
 * Resolve the effective ExecutionPolicy for a Purpose, honoring agent-level
 * constraints. Returns the shape-level policy (modelSource / fallback); the
 * concrete model string is picked by ModelRouter later.
 */
export function resolvePurposePolicy(
  purpose: Purpose,
  agent?: AgentModelPolicy,
  userOverrides?: Partial<Record<OperationType, ExecutionPolicy>>,
): ExecutionPolicy {
  // Prefer explicit policy for legacy OperationType values (stays compatible
  // with existing user overrides).
  const legacyPolicy = (DEFAULT_POLICIES as Record<string, ExecutionPolicy>)[purpose];
  const extendedPolicy = (PURPOSE_DEFAULTS as Record<string, ExecutionPolicy>)[purpose];
  const override = userOverrides?.[purpose as OperationType];
  const basePolicy: ExecutionPolicy =
    override ?? legacyPolicy ?? extendedPolicy ?? DEFAULT_POLICIES.agent_task;

  if (!agent) return basePolicy;

  // localOnly is a hard constraint: clamp to local with no fallback escape hatch.
  if (agent.localOnly) {
    return { ...basePolicy, modelSource: 'local', fallback: 'none' };
  }

  return basePolicy;
}

/**
 * Read the AgentModelPolicy from an agent config blob (parsed JSON). Returns
 * undefined when the blob is missing or malformed. This is the single choke
 * point for "what model policy does this agent carry" — do not reach into
 * `config.model_policy` directly elsewhere, so the shape can evolve without
 * chasing call sites.
 */
export function getAgentModelPolicy(
  agentConfig: unknown,
): AgentModelPolicy | undefined {
  if (!agentConfig || typeof agentConfig !== 'object') return undefined;
  const cfg = agentConfig as { model_policy?: unknown };
  const raw = cfg.model_policy;
  if (!raw || typeof raw !== 'object') return undefined;
  // Strip any legacy `default` / `purposes` pins that may still be in old
  // rows — per-agent pinning is gone, the router owns the choice.
  const { localOnly, maxCostCents, escalate } = raw as AgentModelPolicy;
  return { localOnly, maxCostCents, escalate };
}
