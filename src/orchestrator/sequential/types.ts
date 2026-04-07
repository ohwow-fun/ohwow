/**
 * Sequential Multi-Agent Coordination — Core Types (Local Runtime)
 *
 * A Sequential protocol where agents process in a fixed order,
 * each seeing predecessors' actual outputs and choosing their own
 * contribution. Based on MIPT research showing Sequential beats
 * Coordinator by 14% and Shared by 44%.
 */

// ============================================================================
// SEQUENCE DEFINITION
// ============================================================================

export interface SequenceStep {
  id: string;
  agentId: string;
  prompt: string;
  dependsOn: string[];
  modelTier?: 'haiku' | 'sonnet' | 'opus';
  expectedRole?: string;
  environment?: 'local' | 'cloud' | 'auto';
}

export interface SequenceDefinition {
  name: string;
  description?: string;
  steps: SequenceStep[];
  budgetCents?: number;
  sourcePrompt?: string;
}

// ============================================================================
// EXECUTION RESULTS
// ============================================================================

export type SequenceStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'abstained';

export interface SequenceStepResult {
  stepId: string;
  agentId: string;
  taskId?: string;
  status: SequenceStepStatus;
  output?: string;
  chosenRole?: string;
  abstentionReason?: string;
  wave: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  error?: string;
}

export interface SequenceResult {
  success: boolean;
  stepResults: SequenceStepResult[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostCents: number;
  totalDurationMs: number;
  participatedCount: number;
  abstainedCount: number;
  finalOutput: string;
}

// ============================================================================
// STREAMING EVENTS
// ============================================================================

export type SequenceEvent =
  | { type: 'sequence_start'; name: string; totalSteps: number; waves: number }
  | { type: 'wave_start'; wave: number; stepIds: string[] }
  | { type: 'step_start'; stepId: string; agentId: string; agentName: string; wave: number }
  | { type: 'step_output'; stepId: string; content: string }
  | { type: 'step_complete'; stepId: string; status: SequenceStepStatus; durationMs: number; costCents: number }
  | { type: 'step_abstained'; stepId: string; agentId: string; agentName: string; reason: string }
  | { type: 'wave_complete'; wave: number }
  | { type: 'sequence_complete'; result: SequenceResult }
  | { type: 'sequence_error'; error: string }
  | { type: 'cost_warning'; currentCostCents: number; budgetCents: number };
