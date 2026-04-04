/**
 * Dagre-based layout for the org topology graph.
 * Positions organ systems above their member agents in a top-to-bottom DAG.
 */

import dagre from 'dagre';
import type { FlowNode, FlowEdge } from '../automations/flow-builder/renderer/types';

export function layoutOrgNodes(
  nodes: FlowNode[],
  edges: FlowEdge[],
): FlowNode[] {
  if (nodes.length === 0) return nodes;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: 'TB',
    nodesep: 60,
    ranksep: 80,
    marginx: 40,
    marginy: 40,
  });

  for (const node of nodes) {
    const w = node.width || (node.type === 'organSystem' ? 240 : 220);
    const h = node.height || (node.type === 'organSystem' ? 60 : 70);
    g.setNode(node.id, { width: w, height: h });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    if (!pos) return node;
    const w = node.width || 220;
    const h = node.height || 70;
    return {
      ...node,
      position: { x: pos.x - w / 2, y: pos.y - h / 2 },
    };
  });
}
