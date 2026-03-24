/**
 * ExecutionGraph Type System — Local Workspace
 *
 * Mirrors the cloud ExecutionGraph types for local workflow execution.
 * Same type definitions, used by the local graph engine.
 */

// ============================================================================
// NODE TYPES
// ============================================================================

export type ExecutionNodeType =
  | 'agent_prompt'
  | 'a2a_call'
  | 'condition'
  | 'loop'
  | 'parallel_gate'
  | 'subgraph';

// ============================================================================
// NODE CONFIG
// ============================================================================

export interface AgentPromptConfig {
  agentId: string;
  agentName: string;
  action: string;
  model?: string;
  maxTokens?: number;
}

export interface A2ACallConfig {
  connectionId: string;
  skillId?: string;
  message: string;
}

export interface ConditionConfig {
  expression: string;
  trueLabel?: string;
  falseLabel?: string;
}

export interface LoopConfig {
  maxIterations: number;
  exitCondition: string;
  childNodeIds: string[];
}

export interface ParallelGateConfig {
  requiredCount: number;
}

export interface SubgraphConfig {
  workflowId: string;
}

export type NodeConfig =
  | AgentPromptConfig
  | A2ACallConfig
  | ConditionConfig
  | LoopConfig
  | ParallelGateConfig
  | SubgraphConfig;

// ============================================================================
// GRAPH STRUCTURE
// ============================================================================

export interface ExecutionNode {
  id: string;
  type: ExecutionNodeType;
  label: string;
  config: NodeConfig;
  position?: { x: number; y: number };
}

export interface EdgeGuard {
  type: 'output_contains' | 'output_not_contains' | 'status_equals' | 'expression';
  value: string;
}

export interface ExecutionEdge {
  from: string;
  to: string;
  label?: string;
  guard?: EdgeGuard;
}

export interface WorkflowVariable {
  name: string;
  type: 'string' | 'number' | 'boolean';
  defaultValue?: string;
}

export interface ExecutionGraph {
  nodes: ExecutionNode[];
  edges: ExecutionEdge[];
  variables?: WorkflowVariable[];
  version: number;
}

// ============================================================================
// EXECUTION STATE
// ============================================================================

export type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface NodeExecutionResult {
  nodeId: string;
  status: NodeStatus;
  output: unknown;
  tokensUsed: number;
  durationMs: number;
  error?: string;
}

export interface ExecutionCheckpoint {
  runId: string;
  completedNodes: string[];
  nodeOutputs: Record<string, unknown>;
  nodeStatuses: Record<string, NodeStatus>;
  loopCounters: Record<string, number>;
  savedAt: string;
}

export interface GraphExecutionResult {
  success: boolean;
  completedNodes: string[];
  failedNodes: string[];
  nodeResults: Record<string, NodeExecutionResult>;
  totalTokensUsed: number;
  durationMs: number;
  error?: string;
}
