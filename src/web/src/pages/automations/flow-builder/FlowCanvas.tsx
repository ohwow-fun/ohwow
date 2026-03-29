import { memo, useMemo } from 'react';
import type { FlowNode, FlowEdge, NodeTypes, EdgeTypes } from './renderer/types';
import { FlowRenderer } from './renderer/FlowRenderer';
import { TriggerNode } from './nodes/TriggerNode';
import { StepNode } from './nodes/StepNode';
import { ConditionalNode } from './nodes/ConditionalNode';
import { AddStepNode } from './nodes/AddStepNode';
import { DataFlowEdge } from './edges/DataFlowEdge';
import { AddStepEdge } from './edges/AddStepEdge';

interface FlowCanvasProps {
  nodes: FlowNode[];
  edges: FlowEdge[];
  selectedNodeId?: string | null;
  onNodeClick: (nodeId: string, node: FlowNode) => void;
  onPaneClick: () => void;
  onConnect?: (sourceNodeId: string, sourceHandleId: string, targetNodeId: string, targetHandleId: string) => void;
  onNodeDrag?: (nodeId: string, position: { x: number; y: number }) => void;
  onInsertStep?: (sourceId: string, targetId: string) => void;
}

export const FlowCanvas = memo(function FlowCanvas({
  nodes,
  edges,
  selectedNodeId,
  onNodeClick,
  onPaneClick,
  onConnect,
  onNodeDrag,
  onInsertStep,
}: FlowCanvasProps) {
  const nodeTypes: NodeTypes = useMemo(
    () => ({
      trigger: TriggerNode,
      step: StepNode,
      conditional: ConditionalNode,
      addStep: AddStepNode,
    }),
    [],
  );

  const edgeTypes: EdgeTypes = useMemo(
    () => ({
      dataFlow: DataFlowEdge,
      addStepEdge: AddStepEdge,
    }),
    [],
  );

  return (
    <div className="h-full w-full" data-testid="flow-canvas-wrapper">
      <FlowRenderer
        nodes={nodes}
        edges={edges}
        selectedNodeId={selectedNodeId}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onConnect={onConnect}
        onNodeDrag={onNodeDrag}
        onInsertStep={onInsertStep}
        fitViewOnMount
      />
    </div>
  );
});
