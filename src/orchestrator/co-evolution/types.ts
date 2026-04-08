/**
 * Co-Evolution Types — Local Runtime
 *
 * Simplified types for the local co-evolution engine.
 * Mirrors the cloud types but adapted for SQLite/DatabaseAdapter.
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface LocalCoEvolutionConfig {
  objective: string;
  agentIds: string[];
  maxRounds: number;
  budgetCents?: number;
  /** How many top attempts to show each agent (default 3). */
  topKForContext?: number;
  /** Evaluation prompt for the LLM judge. */
  evaluationPrompt?: string;
}

// ============================================================================
// ATTEMPT RECORDS
// ============================================================================

export interface LocalAttemptRecord {
  id: string;
  round: number;
  agentId: string;
  agentName: string;
  parentAttemptId: string | null;
  parentAgentId: string | null;
  deliverable: string;
  strategySummary: string;
  score: number;
  costCents: number;
  durationMs: number;
  status: 'completed' | 'failed';
  error?: string;
}

// ============================================================================
// RESULTS
// ============================================================================

export interface LocalCoEvolutionResult {
  runId: string;
  bestAttempt: LocalAttemptRecord | null;
  bestScore: number | null;
  totalRounds: number;
  totalAttempts: number;
  totalCostCents: number;
  totalDurationMs: number;
  stoppedReason: string;
  attempts: LocalAttemptRecord[];
}
