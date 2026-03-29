/**
 * Self-Improvement Module — Public API
 *
 * Open-source implementation of the self-improvement algorithms:
 * E13 (compression), E14 (routing), E22 (skills), E23 (MCTS),
 * E24 (digital twin), E25 (self-play), E26 (principles),
 * E27 (process mining), E21 (proactive engine).
 *
 * All algorithm code is 100% open source.
 * Run locally with `ohwow improve` or connect to ohwow.fun
 * for managed orchestration and dashboards.
 */

// Main orchestrator
export { runImprovementCycle } from './improve.js';

// E13 — Memory Compression
export { compressEpisodicMemories } from './memory-compression.js';

// E14 — Thompson Sampling Routing
export { TaskRouter, createTaskRouter, classifyTaskType } from './task-router.js';

// E22 — Pattern Mining & Skill Synthesis
export { mineToolPatterns } from './pattern-miner.js';
export { synthesizeSkills } from './skill-synthesizer.js';

// E23 — MCTS Planning
export { runMCTSPlanning, shouldActivatePlanner } from './mcts-planner.js';

// E24 — Digital Twin
export { pearsonCorrelation, linearCoefficient, buildCausalEdges, propagateIntervention } from './causal-model.js';
export { whatIf, runScenarios } from './simulator.js';
export { buildDigitalTwin } from './digital-twin.js';

// E25 — Self-Play Training
export { generateScenarios } from './scenario-generator.js';
export { executeSandbox } from './sandbox-executor.js';
export { runPracticeSessions } from './practice-evaluator.js';

// E26 — Principle Distillation
export { distillPrinciples } from './principle-distiller.js';

// E27 — Process Mining
export { mineWorkflowPatterns } from './sequence-miner.js';
export { suggestWorkflows } from './workflow-suggester.js';

// E21 — Proactive Engine
export { evaluateSignals } from './signal-evaluator.js';

// Shared utilities
export { calculateCostCents, extractKeywords, keywordOverlap } from './llm-helper.js';

// Types
export type {
  // E13
  CompressionResult,
  // E14
  AgentScore, RoutingDecision, TaskRoutingContext,
  // E22
  ToolCall, MinedPattern, SynthesizedSkillMetadata, SynthesisResult,
  // E23
  CandidateAction, PlannerConfig, PlannerResult,
  // E24
  CausalNode, CausalEdge, Intervention, SimulationResult, CausalModelSnapshot, TwinBuildResult,
  // E25
  TrainingScenario, PracticeResult, PracticeRunSummary,
  // E26
  PrincipleCategory, DistillationResult,
  // E27
  ProcessStep, WorkflowCandidate, ProcessMiningResult,
  // E21
  SignalSource, ProactiveSignal, ProactiveRunSummary,
  // Orchestrator
  ImprovementCycleResult,
} from './types.js';
