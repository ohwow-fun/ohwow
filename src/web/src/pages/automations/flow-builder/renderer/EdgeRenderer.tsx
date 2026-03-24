import { memo } from 'react';
import type { FlowEdge, FlowEdgeProps, EdgeTypes } from './types';

export interface ComputedEdge {
  edge: FlowEdge;
  path: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
}

interface EdgeRendererProps {
  edges: ComputedEdge[];
  edgeTypes: EdgeTypes;
  onInsertStep?: (sourceId: string, targetId: string) => void;
}

export const EdgeRenderer = memo(function EdgeRenderer({
  edges,
  edgeTypes,
  onInsertStep,
}: EdgeRendererProps) {
  return (
    <svg
      className="absolute left-0 top-0 overflow-visible"
      style={{ width: 1, height: 1, pointerEvents: 'none' }}
    >
      {edges.map(({ edge, path, sourceX, sourceY, targetX, targetY }) => {
        const EdgeComponent = edgeTypes[edge.type || 'dataFlow'];
        if (!EdgeComponent) return null;

        const props: FlowEdgeProps = {
          id: edge.id,
          path,
          source: edge.source,
          target: edge.target,
          data: edge.data,
          sourceX,
          sourceY,
          targetX,
          targetY,
          onInsertStep: edge.type === 'dataFlow' ? onInsertStep : undefined,
        };

        return <EdgeComponent key={edge.id} {...props} />;
      })}
    </svg>
  );
});
