import { useState, useCallback, useRef, useEffect } from 'react';
import type { FlowNode, FlowEdge } from '../renderer/types';
import type { AutomationStepType } from '../../types';
import { STEP_TYPE_LABELS } from '../../types';
import type { AutomationAction } from '../../types';
import { getStepOutputFields } from '../utils/field-utils';
import type {
  TriggerNodeData,
  StepNodeData,
  AddStepNodeData,
} from '../utils/flow-converters';
import { addStepNodeId } from '../utils/flow-converters';
import { useAutoLayout } from './useAutoLayout';

// Layout constants (must match computeHandles.ts dimensions)
const NODE_WIDTH = 280;
const NODE_HEIGHT = 80;
const CONDITIONAL_HEIGHT = 100;
const ADD_NODE_WIDTH = 200;
const ADD_NODE_HEIGHT = 40;
const STEP_GAP = 80;       // vertical gap between regular steps
const ADD_STEP_GAP = 60;   // vertical gap between last step and its "+" button

/**
 * When loading saved positions, addStep nodes aren't saved so they default to (0,0).
 * Reposition them relative to their parent node (mirrors auto-layout.ts post-process).
 */
function repositionAddStepNodes(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
  // Build parent map: addStepNodeId -> parentNodeId
  const addStepParents = new Map<string, string>();
  for (const edge of edges) {
    const targetNode = nodes.find((n) => n.id === edge.target);
    if (targetNode?.type === 'addStep') {
      addStepParents.set(edge.target, edge.source);
    }
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  return nodes.map((node) => {
    if (node.type !== 'addStep') return node;
    const parentId = addStepParents.get(node.id);
    if (!parentId) return node;
    const parent = nodeMap.get(parentId);
    if (!parent) return node;

    const parentHeight = parent.type === 'conditional' ? CONDITIONAL_HEIGHT : NODE_HEIGHT;
    const parentWidth = parent.type === 'addStep' ? ADD_NODE_WIDTH : NODE_WIDTH;

    return {
      ...node,
      position: {
        x: parent.position.x + (parentWidth - ADD_NODE_WIDTH) / 2,
        y: parent.position.y + parentHeight + ADD_STEP_GAP,
      },
    };
  });
}

/** Generate a unique step ID by finding the max existing step_N and incrementing */
function nextStepId(nodes: FlowNode[]): string {
  let max = 0;
  for (const n of nodes) {
    if (n.type === 'step' || n.type === 'conditional') {
      const match = n.id.match(/^step_(\d+)$/);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
  }
  return `step_${max + 1}`;
}

/**
 * Defensive edge reconciliation: removes edges referencing non-existent nodes
 * and removes duplicate edges. Called after every mutation to ensure consistency.
 */
function reconcileEdges(nodes: FlowNode[], edges: FlowEdge[]): FlowEdge[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();

  return edges.filter((e) => {
    // Remove edges referencing non-existent nodes
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) return false;

    // Remove duplicate edges (same source+sourceHandle+target)
    const key = `${e.source}|${e.sourceHandle ?? ''}|${e.target}`;
    if (seen.has(key)) return false;
    seen.add(key);

    return true;
  });
}

/** BFS to collect all transitive successor node IDs from a starting node */
function collectDownstreamIds(startId: string, edges: FlowEdge[]): Set<string> {
  const visited = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of edges) {
      if (edge.source === current && !visited.has(edge.target)) {
        visited.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  return visited;
}

export function useFlowState(
  initialNodes: FlowNode[],
  initialEdges: FlowEdge[],
  options?: { hasCustomPositions?: boolean },
) {
  const { applyLayout } = useAutoLayout();

  // Apply initial layout only if no custom positions were saved
  const [layoutedInitialNodes] = useState(() =>
    options?.hasCustomPositions
      ? repositionAddStepNodes(initialNodes, initialEdges)
      : applyLayout(initialNodes, initialEdges),
  );

  const [nodes, setNodes] = useState<FlowNode[]>(layoutedInitialNodes);
  const [edges, setEdges] = useState<FlowEdge[]>(initialEdges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Keep refs to current state for use in callbacks
  const edgesRef = useRef(initialEdges);
  const nodesRef = useRef(layoutedInitialNodes);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || null;

  // Update a node's position (for dragging, no auto-layout)
  const updateNodePosition = useCallback(
    (nodeId: string, position: { x: number; y: number }) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId ? { ...n, position } : n
        ),
      );
    },
    [setNodes],
  );

  // Update a node's data
  const updateNodeData = useCallback(
    (nodeId: string, dataUpdate: Partial<TriggerNodeData | StepNodeData>) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, ...dataUpdate } } : n
        ),
      );
    },
    [setNodes],
  );

  // Add a step after a given node
  const addStep = useCallback(
    (afterNodeId: string, stepType: AutomationStepType = 'run_agent') => {
      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;

      // Find the addStep node to get branch context
      const oldAddNodeId = addStepNodeId(afterNodeId);
      const oldAddNode = currentNodes.find((n) => n.id === oldAddNodeId);
      const addData = oldAddNode?.data as (AddStepNodeData & { conditionalNodeId?: string }) | undefined;
      const branchType = addData?.branchType as 'then' | 'else' | undefined;
      const conditionalNodeId = addData?.conditionalNodeId;

      // Generate unique ID (max-based to avoid collisions after deletions)
      const stepCount = currentNodes.filter(
        (n) => n.type === 'step' || n.type === 'conditional',
      ).length;
      const newStepId = nextStepId(currentNodes);

      const stepAction: AutomationAction = {
        id: newStepId,
        action_type: stepType,
        action_config: {},
      };

      const newNodeData: StepNodeData & Record<string, unknown> = {
        stepIndex: branchType ? -1 : stepCount,
        stepId: newStepId,
        stepType,
        label: STEP_TYPE_LABELS[stepType] || stepType,
        actionConfig: {},
        outputFields: getStepOutputFields(stepAction),
      };

      // Add branch context if inserting into a conditional branch
      if (branchType && conditionalNodeId) {
        newNodeData.branchType = branchType;
        newNodeData.parentConditionalId = conditionalNodeId;
      }

      // Position new step where the old addStep button was (centered for width difference)
      const oldAddPos = oldAddNode?.position ?? { x: 0, y: 0 };
      const newStepX = oldAddPos.x + (ADD_NODE_WIDTH - NODE_WIDTH) / 2;
      const newStepY = oldAddPos.y + (ADD_NODE_HEIGHT - NODE_HEIGHT) / 2;

      const newNode: FlowNode = {
        id: newStepId,
        type: 'step',
        position: { x: newStepX, y: newStepY },
        data: newNodeData,
      };

      // Find the old edge going to the add node (might have sourceHandle for branches)
      const oldEdgeToAdd = currentEdges.find(
        (e) => e.source === afterNodeId && e.target === oldAddNodeId,
      );
      const sourceHandle = oldEdgeToAdd?.sourceHandle;

      // Remove old edge from afterNodeId to old addNode
      let newEdges = currentEdges.filter(
        (e) => !(e.source === afterNodeId && e.target === oldAddNodeId),
      );

      // Add edge: afterNodeId -> newStep (preserve sourceHandle for branches)
      newEdges.push({
        id: `${afterNodeId}->${newStepId}`,
        source: afterNodeId,
        sourceHandle: sourceHandle || undefined,
        target: newStepId,
        type: 'dataFlow',
        data: branchType ? { branchType } : undefined,
      });

      // Create new addStep node directly below the new step with tight spacing
      const newAddNodeId = addStepNodeId(newStepId);
      const newAddNodeX = newStepX + (NODE_WIDTH - ADD_NODE_WIDTH) / 2;
      const newAddNodeY = newStepY + NODE_HEIGHT + ADD_STEP_GAP;
      const newAddNode: FlowNode = {
        id: newAddNodeId,
        type: 'addStep',
        position: { x: newAddNodeX, y: newAddNodeY },
        data: {
          parentNodeId: newStepId,
          insertIndex: stepCount + 1,
          ...(branchType ? { branchType, conditionalNodeId } : {}),
        },
      };

      // Add edge: newStep -> newAddNode
      newEdges.push({
        id: `${newStepId}->${newAddNodeId}`,
        source: newStepId,
        target: newAddNodeId,
        type: 'addStepEdge',
        data: branchType ? { branchType } : undefined,
      });

      // Remove old addNode and its edges
      const updatedNodes = currentNodes.filter((n) => n.id !== oldAddNodeId);
      newEdges = newEdges.filter(
        (e) => e.source !== oldAddNodeId && e.target !== oldAddNodeId,
      );

      const allNodes = [...updatedNodes, newNode, newAddNode];

      setNodes(allNodes);
      setEdges(reconcileEdges(allNodes, newEdges));
      setSelectedNodeId(newStepId);
    },
    [setNodes, setEdges],
  );

  // Delete a step node
  const deleteStep = useCallback(
    (nodeId: string) => {
      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;

      const node = currentNodes.find((n) => n.id === nodeId);
      if (!node || node.type === 'trigger') return;

      // Find incoming and outgoing edges
      const incomingEdge = currentEdges.find((e) => e.target === nodeId);
      const outgoingEdges = currentEdges.filter((e) => e.source === nodeId);
      const sourceId = incomingEdge?.source;

      // Remove all edges connected to this node
      let newEdges = currentEdges.filter(
        (e) => e.source !== nodeId && e.target !== nodeId,
      );

      // Remove the addStep node after this step
      const oldAddNodeId = addStepNodeId(nodeId);
      newEdges = newEdges.filter(
        (e) => e.source !== oldAddNodeId && e.target !== oldAddNodeId,
      );

      let newNodes = currentNodes.filter(
        (n) => n.id !== nodeId && n.id !== oldAddNodeId,
      );

      // Reconnect: source -> first outgoing target (skip addStep nodes)
      // Preserve branch context from the incoming edge
      if (sourceId) {
        const incomingSourceHandle = incomingEdge?.sourceHandle;
        const incomingBranchType = incomingEdge?.data?.branchType as 'then' | 'else' | undefined;

        const nextStepEdge = outgoingEdges.find((e) => {
          const targetNode = currentNodes.find((n) => n.id === e.target);
          return targetNode && targetNode.type !== 'addStep';
        });

        if (nextStepEdge) {
          newEdges.push({
            id: `${sourceId}->${nextStepEdge.target}`,
            source: sourceId,
            sourceHandle: incomingSourceHandle,
            target: nextStepEdge.target,
            type: 'dataFlow',
            data: incomingBranchType ? { branchType: incomingBranchType } : undefined,
          });
        } else {
          // No next step; add a new addStep node at the deleted node's position (centered)
          const deletedPos = node.position;
          const newAddId = addStepNodeId(sourceId);
          const newAddNode: FlowNode = {
            id: newAddId,
            type: 'addStep',
            position: {
              x: deletedPos.x + (NODE_WIDTH - ADD_NODE_WIDTH) / 2,
              y: deletedPos.y + (NODE_HEIGHT - ADD_NODE_HEIGHT) / 2,
            },
            data: {
              parentNodeId: sourceId,
              insertIndex: 0,
              ...(incomingBranchType ? { branchType: incomingBranchType, conditionalNodeId: sourceId } : {}),
            } satisfies AddStepNodeData,
          };
          newEdges.push({
            id: `${sourceId}->${newAddId}`,
            source: sourceId,
            sourceHandle: incomingSourceHandle,
            target: newAddId,
            type: 'addStepEdge',
            data: incomingBranchType ? { branchType: incomingBranchType } : undefined,
          });
          newNodes = [...newNodes, newAddNode];
        }
      }

      setNodes(newNodes);
      setEdges(reconcileEdges(newNodes, newEdges));
      setSelectedNodeId(null);
    },
    [setNodes, setEdges],
  );

  // Connect two nodes via drag
  const connectNodes = useCallback(
    (sourceNodeId: string, sourceHandleId: string, targetNodeId: string, _targetHandleId: string) => {
      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;

      // Validate both nodes exist
      const sourceNode = currentNodes.find((n) => n.id === sourceNodeId);
      const targetNode = currentNodes.find((n) => n.id === targetNodeId);
      if (!sourceNode || !targetNode) {
        return;
      }

      // No duplicate: same source handle -> same target already exists
      const duplicate = currentEdges.find(
        (e) => e.source === sourceNodeId && e.sourceHandle === (sourceHandleId === 'source' ? undefined : sourceHandleId) && e.target === targetNodeId,
      );
      if (duplicate) {
        return;
      }

      // Remove existing edge from the same source handle (one outgoing per handle)
      let newEdges = currentEdges.filter((e) => {
        if (e.source !== sourceNodeId) return true;
        const edgeSH = e.sourceHandle || 'source';
        return edgeSH !== sourceHandleId;
      });

      // Remove existing dataFlow edge to the same target (one incoming per target)
      // Preserve addStepEdge connections to avoid orphaning addStep nodes
      newEdges = newEdges.filter((e) => e.target !== targetNodeId || e.type === 'addStepEdge');

      // Determine branch type from handle
      const branchType = sourceHandleId === 'then' || sourceHandleId === 'else' ? sourceHandleId : undefined;

      newEdges.push({
        id: `${sourceNodeId}->${targetNodeId}`,
        source: sourceNodeId,
        sourceHandle: sourceHandleId === 'source' ? undefined : sourceHandleId,
        target: targetNodeId,
        type: 'dataFlow',
        data: branchType ? { branchType } : undefined,
      });

      setEdges(reconcileEdges(currentNodes, newEdges));
    },
    [],
  );

  // Insert a step between two connected nodes
  const insertStepBetween = useCallback(
    (sourceId: string, targetId: string) => {
      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;

      const sourceNode = currentNodes.find((n) => n.id === sourceId);
      const targetNode = currentNodes.find((n) => n.id === targetId);
      if (!sourceNode || !targetNode) return;

      // Generate unique ID (max-based to avoid collisions after deletions)
      const newStepId = nextStepId(currentNodes);

      // Find the existing edge to get branch context
      const existingEdge = currentEdges.find(
        (e) => e.source === sourceId && e.target === targetId,
      );
      const branchType = existingEdge?.data?.branchType as 'then' | 'else' | undefined;

      const stepAction: AutomationAction = {
        id: newStepId,
        action_type: 'run_agent',
        action_config: {},
      };

      // Position new step between source and target
      const midX = (sourceNode.position.x + targetNode.position.x) / 2;
      const midY = (sourceNode.position.y + targetNode.position.y) / 2;

      const newNodeData: StepNodeData & Record<string, unknown> = {
        stepIndex: branchType ? -1 : currentNodes.filter((n) => n.type === 'step' || n.type === 'conditional').length,
        stepId: newStepId,
        stepType: 'run_agent',
        label: STEP_TYPE_LABELS['run_agent'] || 'run_agent',
        actionConfig: {},
        outputFields: getStepOutputFields(stepAction),
      };

      if (branchType && sourceId) {
        newNodeData.branchType = branchType;
        newNodeData.parentConditionalId = sourceId;
      }

      const newNode: FlowNode = {
        id: newStepId,
        type: 'step',
        position: { x: midX, y: midY },
        data: newNodeData,
      };

      // Shift target and all downstream nodes down to make room
      const shiftAmount = NODE_HEIGHT + STEP_GAP;
      const downstreamIds = collectDownstreamIds(targetId, currentEdges);
      downstreamIds.add(targetId);

      const shiftedNodes = currentNodes.map((n) => {
        if (downstreamIds.has(n.id)) {
          return { ...n, position: { x: n.position.x, y: n.position.y + shiftAmount } };
        }
        return n;
      });

      // Rewire edges: remove source->target, add source->new + new->target
      const newEdges = [
        ...currentEdges.filter(
          (e) => !(e.source === sourceId && e.target === targetId),
        ),
        {
          id: `${sourceId}->${newStepId}`,
          source: sourceId,
          sourceHandle: existingEdge?.sourceHandle,
          target: newStepId,
          type: 'dataFlow' as const,
          data: branchType ? { branchType } : undefined,
        },
        {
          id: `${newStepId}->${targetId}`,
          source: newStepId,
          target: targetId,
          type: 'dataFlow' as const,
          data: branchType ? { branchType } : undefined,
        },
      ];

      const allInsertedNodes = [...shiftedNodes, newNode];
      setNodes(allInsertedNodes);
      setEdges(reconcileEdges(allInsertedNodes, newEdges));
      setSelectedNodeId(newStepId);
    },
    [setNodes, setEdges],
  );

  // Handle node click (selection)
  const onNodeClick = useCallback(
    (nodeId: string, node: FlowNode) => {
      if (node.type === 'addStep') {
        const addData = node.data as AddStepNodeData;
        addStep(addData.parentNodeId);
      } else {
        setSelectedNodeId(node.id);
      }
    },
    [addStep],
  );

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  return {
    nodes,
    edges,
    selectedNodeId,
    selectedNode,
    onNodeClick,
    onPaneClick,
    updateNodeData,
    updateNodePosition,
    addStep,
    deleteStep,
    connectNodes,
    insertStepBetween,
    setSelectedNodeId,
    setNodes,
    setEdges,
  };
}
