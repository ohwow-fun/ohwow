/**
 * ExecutionGraph Engine — Local Workspace
 *
 * Simplified graph executor for the local runtime. Same topological
 * execution with parallel node support, condition gating, loop/subgraph
 * nodes, and deadlock detection. Uses callbacks for node execution
 * so the caller provides the actual LLM/A2A logic.
 */

import crypto from 'crypto';
import type {
  ExecutionGraph,
  ExecutionNode,
  ExecutionEdge,
  EdgeGuard,
  AgentPromptConfig,
  A2ACallConfig,
  ConditionConfig,
  LoopConfig,
  ParallelGateConfig,
  SubgraphConfig,
  NodeStatus,
  NodeExecutionResult,
  GraphExecutionResult,
  ExecutionCheckpoint,
} from './execution-graph-types.js';

// ============================================================================
// CONTEXT
// ============================================================================

export interface LocalGraphExecutionContext {
  runId: string;
  variables?: Record<string, string>;
  executeAgentPrompt: (config: AgentPromptConfig, context: string) => Promise<{ output: string; tokensUsed: number }>;
  executeA2ACall?: (config: A2ACallConfig, context: string) => Promise<{ output: string; tokensUsed: number }>;
  resolveSubgraph?: (workflowId: string) => Promise<ExecutionGraph | null>;
  onCheckpoint?: (checkpoint: ExecutionCheckpoint) => Promise<void>;
  onNodeStatusChange?: (nodeId: string, status: NodeStatus) => Promise<void>;
  isCancelled?: () => Promise<boolean>;
}

// ============================================================================
// ENGINE
// ============================================================================

export async function executeLocalGraph(
  graph: ExecutionGraph,
  ctx: LocalGraphExecutionContext,
  checkpoint?: ExecutionCheckpoint,
): Promise<GraphExecutionResult> {
  const startTime = Date.now();
  const nodeResults: Record<string, NodeExecutionResult> = {};
  const nodeOutputs: Record<string, unknown> = {};
  const nodeStatuses: Record<string, NodeStatus> = {};
  const loopCounters: Record<string, number> = {};
  const completedNodes = new Set<string>();
  const failedNodes: string[] = [];
  const activeEdges = new Set<string>(graph.edges.map(edgeKey));

  // Restore checkpoint
  if (checkpoint) {
    for (const nodeId of checkpoint.completedNodes) {
      completedNodes.add(nodeId);
      nodeStatuses[nodeId] = 'completed';
    }
    Object.assign(nodeOutputs, checkpoint.nodeOutputs);
    Object.assign(loopCounters, checkpoint.loopCounters);
    for (const [nodeId, status] of Object.entries(checkpoint.nodeStatuses)) {
      nodeStatuses[nodeId] = status as NodeStatus;
    }
  }

  const allNodeIds = new Set(graph.nodes.map((n) => n.id));

  // Build incoming edges index
  const incomingEdges = new Map<string, ExecutionEdge[]>();
  for (const node of graph.nodes) {
    incomingEdges.set(node.id, []);
  }
  for (const edge of graph.edges) {
    incomingEdges.get(edge.to)?.push(edge);
  }

  while (completedNodes.size < allNodeIds.size) {
    if (ctx.isCancelled && await ctx.isCancelled()) {
      return buildResult(nodeResults, failedNodes, completedNodes, startTime, 'Run cancelled');
    }

    const readyNodes = graph.nodes.filter((node) => {
      if (completedNodes.has(node.id)) return false;
      if (nodeStatuses[node.id] === 'running' || nodeStatuses[node.id] === 'skipped') return false;

      const incoming = incomingEdges.get(node.id) || [];
      if (incoming.length === 0) return true;

      if (node.type === 'parallel_gate') {
        const config = node.config as ParallelGateConfig;
        const done = incoming.filter(
          (e) => activeEdges.has(edgeKey(e)) && completedNodes.has(e.from),
        ).length;
        return done >= config.requiredCount;
      }

      return incoming.every((e) => {
        if (!activeEdges.has(edgeKey(e))) return true;
        return completedNodes.has(e.from);
      });
    });

    if (readyNodes.length === 0) {
      const remaining = graph.nodes.filter(
        (n) => !completedNodes.has(n.id) && nodeStatuses[n.id] !== 'skipped',
      );
      if (remaining.length === 0) break;
      return buildResult(
        nodeResults, failedNodes, completedNodes, startTime,
        `Deadlock: nodes ${remaining.map((n) => n.id).join(', ')} cannot proceed`,
      );
    }

    const results = await Promise.allSettled(
      readyNodes.map((node) => executeNode(node, graph, ctx, nodeOutputs, loopCounters, activeEdges)),
    );

    for (let i = 0; i < results.length; i++) {
      const node = readyNodes[i];
      const result = results[i];

      if (result.status === 'fulfilled') {
        const nr = result.value;
        nodeResults[node.id] = nr;
        nodeOutputs[node.id] = nr.output;
        nodeStatuses[node.id] = nr.status;

        if (nr.status === 'completed' || nr.status === 'skipped') {
          completedNodes.add(node.id);
        }

        if (nr.status === 'skipped') {
          for (const edge of graph.edges) {
            if (edge.from === node.id) {
              activeEdges.delete(edgeKey(edge));
              markDownstreamSkipped(edge.to, graph, activeEdges, completedNodes, nodeStatuses);
            }
          }
        }

        if (nr.status === 'failed') {
          failedNodes.push(node.id);
          completedNodes.add(node.id);
          return buildResult(nodeResults, failedNodes, completedNodes, startTime, `Node "${node.label}" failed: ${nr.error}`);
        }

        if (node.type === 'condition' && nr.status === 'completed') {
          gateConditionEdges(node, nr, graph.edges, activeEdges);
        }

        if (ctx.onNodeStatusChange) {
          await ctx.onNodeStatusChange(node.id, nr.status);
        }
      } else {
        const error = result.reason instanceof Error ? result.reason.message : 'Unknown error';
        nodeResults[node.id] = { nodeId: node.id, status: 'failed', output: null, tokensUsed: 0, durationMs: 0, error };
        failedNodes.push(node.id);
        completedNodes.add(node.id);
        return buildResult(nodeResults, failedNodes, completedNodes, startTime, `Node "${node.label}" failed: ${error}`);
      }
    }

    if (ctx.onCheckpoint) {
      await ctx.onCheckpoint({
        runId: ctx.runId,
        completedNodes: Array.from(completedNodes),
        nodeOutputs,
        nodeStatuses,
        loopCounters,
        savedAt: new Date().toISOString(),
      });
    }
  }

  return buildResult(nodeResults, failedNodes, completedNodes, startTime);
}

// ============================================================================
// NODE EXECUTION
// ============================================================================

async function executeNode(
  node: ExecutionNode,
  graph: ExecutionGraph,
  ctx: LocalGraphExecutionContext,
  nodeOutputs: Record<string, unknown>,
  loopCounters: Record<string, number>,
  activeEdges: Set<string>,
): Promise<NodeExecutionResult> {
  const startTime = Date.now();

  if (ctx.onNodeStatusChange) {
    await ctx.onNodeStatusChange(node.id, 'running');
  }

  try {
    switch (node.type) {
      case 'agent_prompt': {
        const config = node.config as AgentPromptConfig;
        const context = buildNodeContext(node.id, graph, nodeOutputs);
        const action = substituteVars(config.action, ctx.variables);
        const fullContext = context ? `${context}\n\nYour task: ${action}` : action;
        const result = await ctx.executeAgentPrompt(config, fullContext);
        return { nodeId: node.id, status: 'completed', output: result.output, tokensUsed: result.tokensUsed, durationMs: Date.now() - startTime };
      }

      case 'a2a_call': {
        const config = node.config as A2ACallConfig;
        if (!ctx.executeA2ACall) {
          return { nodeId: node.id, status: 'failed', output: null, tokensUsed: 0, durationMs: Date.now() - startTime, error: 'A2A calls not configured' };
        }
        const context = buildNodeContext(node.id, graph, nodeOutputs);
        const message = substituteVars(config.message, ctx.variables);
        const fullContext = context ? `${context}\n\n${message}` : message;
        const result = await ctx.executeA2ACall(config, fullContext);
        return { nodeId: node.id, status: 'completed', output: result.output, tokensUsed: result.tokensUsed, durationMs: Date.now() - startTime };
      }

      case 'condition': {
        const config = node.config as ConditionConfig;
        const predecessorEdges = graph.edges.filter((e) => e.to === node.id);
        let sourceOutput = '';
        for (const edge of predecessorEdges) {
          if (nodeOutputs[edge.from] != null) { sourceOutput = String(nodeOutputs[edge.from]); break; }
        }
        const passed = evaluateExpression(config.expression, sourceOutput);
        return { nodeId: node.id, status: 'completed', output: passed, tokensUsed: 0, durationMs: Date.now() - startTime };
      }

      case 'loop': {
        const config = node.config as LoopConfig;
        const maxIter = config.maxIterations || 5;
        let totalTokens = 0;
        let lastOutput: unknown = null;
        loopCounters[node.id] = loopCounters[node.id] || 0;

        while (loopCounters[node.id] < maxIter) {
          loopCounters[node.id]++;
          for (const childId of config.childNodeIds) {
            const child = graph.nodes.find((n) => n.id === childId);
            if (!child) continue;
            const cr = await executeNode(child, graph, ctx, nodeOutputs, loopCounters, activeEdges);
            nodeOutputs[childId] = cr.output;
            totalTokens += cr.tokensUsed;
            lastOutput = cr.output;
            if (cr.status === 'failed') {
              return { nodeId: node.id, status: 'failed', output: lastOutput, tokensUsed: totalTokens, durationMs: Date.now() - startTime, error: cr.error };
            }
          }
          if (evaluateExpression(config.exitCondition, lastOutput != null ? String(lastOutput) : '')) break;
        }
        return { nodeId: node.id, status: 'completed', output: lastOutput, tokensUsed: totalTokens, durationMs: Date.now() - startTime };
      }

      case 'parallel_gate': {
        const incoming = graph.edges.filter((e) => e.to === node.id);
        const outputs = incoming.map((e) => nodeOutputs[e.from]).filter((o) => o != null).map(String);
        return { nodeId: node.id, status: 'completed', output: outputs.join('\n\n'), tokensUsed: 0, durationMs: Date.now() - startTime };
      }

      case 'subgraph': {
        const config = node.config as SubgraphConfig;
        if (!ctx.resolveSubgraph) {
          return { nodeId: node.id, status: 'failed', output: null, tokensUsed: 0, durationMs: Date.now() - startTime, error: 'Subgraph resolution not configured' };
        }
        const subgraph = await ctx.resolveSubgraph(config.workflowId);
        if (!subgraph) {
          return { nodeId: node.id, status: 'failed', output: null, tokensUsed: 0, durationMs: Date.now() - startTime, error: `Subgraph ${config.workflowId} not found` };
        }
        const subResult = await executeLocalGraph(subgraph, { ...ctx, runId: crypto.randomUUID() });
        const lastId = subResult.completedNodes[subResult.completedNodes.length - 1];
        const lastNr = lastId ? subResult.nodeResults[lastId] : undefined;
        return { nodeId: node.id, status: subResult.success ? 'completed' : 'failed', output: lastNr?.output ?? null, tokensUsed: subResult.totalTokensUsed, durationMs: Date.now() - startTime, error: subResult.error };
      }

      default:
        return { nodeId: node.id, status: 'failed', output: null, tokensUsed: 0, durationMs: Date.now() - startTime, error: `Unknown node type: ${node.type}` };
    }
  } catch (err) {
    return { nodeId: node.id, status: 'failed', output: null, tokensUsed: 0, durationMs: Date.now() - startTime, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function edgeKey(edge: ExecutionEdge): string {
  return `${edge.from}->${edge.to}`;
}

function buildNodeContext(nodeId: string, graph: ExecutionGraph, nodeOutputs: Record<string, unknown>): string {
  const incoming = graph.edges.filter((e) => e.to === nodeId);
  if (incoming.length === 0) return '';

  const parts: string[] = [];
  for (const edge of incoming) {
    const output = nodeOutputs[edge.from];
    if (output != null) {
      const label = graph.nodes.find((n) => n.id === edge.from)?.label || edge.from;
      parts.push(`${label}:\n${String(output)}`);
    }
  }

  if (parts.length === 0) return '';
  if (parts.length === 1) return `Previous step output:\n${parts[0]}`;
  return `Outputs from previous steps:\n\n${parts.join('\n\n')}`;
}

function substituteVars(text: string, variables?: Record<string, string>): string {
  if (!variables) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => variables[key] ?? match);
}

function evaluateExpression(expression: string, output: string): boolean {
  const expr = expression.trim();

  const containsMatch = expr.match(/output\.(contains|includes)\(['"](.+?)['"]\)/);
  if (containsMatch) return output.toLowerCase().includes(containsMatch[2].toLowerCase());

  const notContainsMatch = expr.match(/!output\.(contains|includes)\(['"](.+?)['"]\)/);
  if (notContainsMatch) return !output.toLowerCase().includes(notContainsMatch[2].toLowerCase());

  if (!expr.includes('(') && !expr.includes(')')) {
    return output.toLowerCase().includes(expr.toLowerCase());
  }

  return true;
}

function evaluateEdgeGuard(guard: EdgeGuard, output: string): boolean {
  switch (guard.type) {
    case 'output_contains': return output.toLowerCase().includes(guard.value.toLowerCase());
    case 'output_not_contains': return !output.toLowerCase().includes(guard.value.toLowerCase());
    case 'status_equals': return true;
    case 'expression': return evaluateExpression(guard.value, output);
    default: return true;
  }
}

function gateConditionEdges(
  conditionNode: ExecutionNode,
  result: NodeExecutionResult,
  edges: ExecutionEdge[],
  activeEdges: Set<string>,
): void {
  const outgoing = edges.filter((e) => e.from === conditionNode.id);
  const conditionOutput = result.output != null ? String(result.output) : '';
  const passed = conditionOutput === 'true';

  for (const edge of outgoing) {
    const key = edgeKey(edge);
    if (edge.label === 'true' && !passed) activeEdges.delete(key);
    else if (edge.label === 'false' && passed) activeEdges.delete(key);
    else if (edge.guard && !evaluateEdgeGuard(edge.guard, conditionOutput)) activeEdges.delete(key);
  }
}

function markDownstreamSkipped(
  nodeId: string,
  graph: ExecutionGraph,
  activeEdges: Set<string>,
  completedNodes: Set<string>,
  nodeStatuses: Record<string, NodeStatus>,
): void {
  if (completedNodes.has(nodeId)) return;

  const incoming = graph.edges.filter((e) => e.to === nodeId);
  const allDeactivated = incoming.length > 0 && incoming.every((e) => !activeEdges.has(edgeKey(e)));

  if (allDeactivated) {
    nodeStatuses[nodeId] = 'skipped';
    completedNodes.add(nodeId);
    for (const edge of graph.edges.filter((e) => e.from === nodeId)) {
      activeEdges.delete(edgeKey(edge));
      markDownstreamSkipped(edge.to, graph, activeEdges, completedNodes, nodeStatuses);
    }
  }
}

function buildResult(
  nodeResults: Record<string, NodeExecutionResult>,
  failedNodes: string[],
  completedNodes: Set<string>,
  startTime: number,
  error?: string,
): GraphExecutionResult {
  return {
    success: failedNodes.length === 0 && !error,
    completedNodes: Array.from(completedNodes),
    failedNodes,
    nodeResults,
    totalTokensUsed: Object.values(nodeResults).reduce((sum, r) => sum + r.tokensUsed, 0),
    durationMs: Date.now() - startTime,
    error,
  };
}
