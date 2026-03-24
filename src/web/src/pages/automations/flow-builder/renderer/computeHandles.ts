/**
 * Pure functions to compute handle positions from node positions and dimensions.
 * Replaces xyflow's internal handle measurement system.
 *
 * Node dimensions are known constants (set in flow-converters.ts),
 * so no DOM measurement is needed.
 */

import type { FlowNode, FlowEdge, HandleInfo } from './types';

// Known node dimensions (must match flow-converters.ts NODE_DIMENSIONS)
const DIMENSIONS: Record<string, { width: number; height: number }> = {
  trigger: { width: 280, height: 80 },
  step: { width: 280, height: 80 },
  conditional: { width: 280, height: 100 },
  addStep: { width: 200, height: 40 },
};

function getDimensions(node: FlowNode): { width: number; height: number } {
  if (node.width && node.height) return { width: node.width, height: node.height };
  return DIMENSIONS[node.type || 'step'] || { width: 280, height: 80 };
}

/**
 * Compute all handle positions for a set of nodes.
 * Returns a Map from "nodeId:handleId" to HandleInfo.
 */
export function computeHandlePositions(
  nodes: FlowNode[],
): Map<string, HandleInfo> {
  const handles = new Map<string, HandleInfo>();

  for (const node of nodes) {
    const { width, height } = getDimensions(node);
    const cx = node.position.x + width / 2;

    switch (node.type) {
      case 'trigger':
        // Source at bottom-center
        handles.set(`${node.id}:source`, {
          nodeId: node.id,
          handleId: 'source',
          type: 'source',
          x: cx,
          y: node.position.y + height,
        });
        break;

      case 'step':
        // Target at top-center
        handles.set(`${node.id}:target`, {
          nodeId: node.id,
          handleId: 'target',
          type: 'target',
          x: cx,
          y: node.position.y,
        });
        // Source at bottom-center
        handles.set(`${node.id}:source`, {
          nodeId: node.id,
          handleId: 'source',
          type: 'source',
          x: cx,
          y: node.position.y + height,
        });
        break;

      case 'conditional':
        // Target at top-center
        handles.set(`${node.id}:target`, {
          nodeId: node.id,
          handleId: 'target',
          type: 'target',
          x: cx,
          y: node.position.y,
        });
        // "then" handle at 35% bottom
        handles.set(`${node.id}:then`, {
          nodeId: node.id,
          handleId: 'then',
          type: 'source',
          x: node.position.x + width * 0.35,
          y: node.position.y + height,
        });
        // "else" handle at 65% bottom
        handles.set(`${node.id}:else`, {
          nodeId: node.id,
          handleId: 'else',
          type: 'source',
          x: node.position.x + width * 0.65,
          y: node.position.y + height,
        });
        // Default source at bottom-center (for main-chain successors)
        handles.set(`${node.id}:source`, {
          nodeId: node.id,
          handleId: 'source',
          type: 'source',
          x: cx,
          y: node.position.y + height,
        });
        break;

      case 'addStep':
        // Target at top-center only
        handles.set(`${node.id}:target`, {
          nodeId: node.id,
          handleId: 'target',
          type: 'target',
          x: cx,
          y: node.position.y,
        });
        break;

      default:
        // Fallback: target top, source bottom
        handles.set(`${node.id}:target`, {
          nodeId: node.id,
          handleId: 'target',
          type: 'target',
          x: cx,
          y: node.position.y,
        });
        handles.set(`${node.id}:source`, {
          nodeId: node.id,
          handleId: 'source',
          type: 'source',
          x: cx,
          y: node.position.y + height,
        });
        break;
    }
  }

  return handles;
}

/**
 * Resolve the source and target coordinates for an edge.
 */
export function resolveEdgeEndpoints(
  edge: FlowEdge,
  handleMap: Map<string, HandleInfo>,
): { sourceX: number; sourceY: number; targetX: number; targetY: number } | null {
  // Source handle: use sourceHandle if specified, otherwise default to "source"
  const sourceHandleId = edge.sourceHandle || 'source';
  const sourceKey = `${edge.source}:${sourceHandleId}`;
  const sourceHandle = handleMap.get(sourceKey);

  // Target handle: use targetHandle if specified, otherwise default to "target"
  const targetHandleId = edge.targetHandle || 'target';
  const targetKey = `${edge.target}:${targetHandleId}`;
  const targetHandle = handleMap.get(targetKey);

  if (!sourceHandle || !targetHandle) return null;

  return {
    sourceX: sourceHandle.x,
    sourceY: sourceHandle.y,
    targetX: targetHandle.x,
    targetY: targetHandle.y,
  };
}
