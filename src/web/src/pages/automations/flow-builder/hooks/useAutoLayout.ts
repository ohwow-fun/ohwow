import { useCallback } from 'react';
import type { FlowNode, FlowEdge } from '../renderer/types';
import { layoutNodes } from '../utils/auto-layout';

/**
 * Hook that provides auto-layout functionality.
 * Wraps dagre layout and returns a function to apply layout to nodes.
 */
export function useAutoLayout() {
  const applyLayout = useCallback(
    (nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] => {
      if (nodes.length === 0) return nodes;
      return layoutNodes(nodes, edges);
    },
    [],
  );

  return { applyLayout };
}
