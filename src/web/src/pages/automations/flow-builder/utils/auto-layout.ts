/**
 * Dagre-based auto-layout for the automation flow canvas.
 * Computes node positions in a top-to-bottom DAG layout.
 */

import dagre from 'dagre';
import type { FlowNode, FlowEdge } from '../renderer/types';

const NODE_WIDTH = 280;
const NODE_HEIGHT = 80;
const ADD_NODE_WIDTH = 200;
const ADD_NODE_HEIGHT = 40;
const HORIZONTAL_SPACING = 80;
const VERTICAL_SPACING = 100;
const ADD_STEP_GAP = 60; // spacing for addStep nodes

export function layoutNodes(
  nodes: FlowNode[],
  edges: FlowEdge[],
): FlowNode[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: 'TB',
    nodesep: HORIZONTAL_SPACING,
    ranksep: VERTICAL_SPACING,
    marginx: 40,
    marginy: 40,
  });

  for (const node of nodes) {
    const isAddNode = node.type === 'addStep';
    g.setNode(node.id, {
      width: isAddNode ? ADD_NODE_WIDTH : NODE_WIDTH,
      height: isAddNode ? ADD_NODE_HEIGHT : NODE_HEIGHT,
    });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  // Build a map of parent node IDs for each addStep node
  const addStepParents = new Map<string, string>();
  for (const edge of edges) {
    const targetNode = nodes.find((n) => n.id === edge.target);
    if (targetNode?.type === 'addStep') {
      addStepParents.set(edge.target, edge.source);
    }
  }

  const layoutedNodes = nodes.map((node) => {
    const pos = g.node(node.id);
    if (!pos) return node;

    const isAddNode = node.type === 'addStep';
    const width = isAddNode ? ADD_NODE_WIDTH : NODE_WIDTH;
    const height = isAddNode ? ADD_NODE_HEIGHT : NODE_HEIGHT;

    return {
      ...node,
      position: {
        x: pos.x - width / 2,
        y: pos.y - height / 2,
      },
    };
  });

  // Post-process: pull addStep nodes closer to their parent (ADD_STEP_GAP instead of Dagre's VERTICAL_SPACING)
  const nodeMap = new Map(layoutedNodes.map((n) => [n.id, n]));
  for (const node of layoutedNodes) {
    if (node.type !== 'addStep') continue;
    const parentId = addStepParents.get(node.id);
    if (!parentId) continue;
    const parent = nodeMap.get(parentId);
    if (!parent) continue;

    const parentDims = parent.type === 'conditional'
      ? { width: 280, height: 100 }
      : { width: NODE_WIDTH, height: NODE_HEIGHT };

    node.position = {
      x: parent.position.x + (parentDims.width - ADD_NODE_WIDTH) / 2,
      y: parent.position.y + parentDims.height + ADD_STEP_GAP,
    };
  }

  return layoutedNodes;
}
