import { memo, useMemo, useCallback, useState, useEffect, useRef } from 'react';
import type { FlowNode, FlowEdge, NodeTypes, EdgeTypes, FlowNodeProps } from './types';
import { computeHandlePositions, resolveEdgeEndpoints } from './computeHandles';
import { smoothStepPath } from './smoothStepPath';
import { useViewport } from './useViewport';
import { useConnectionDrag } from './useConnectionDrag';
import { useNodeDrag } from './useNodeDrag';
import { EdgeRenderer } from './EdgeRenderer';
import type { ComputedEdge } from './EdgeRenderer';
import { DotBackground } from './DotBackground';
import { Controls } from './Controls';
import { MiniMap } from './MiniMap';

interface FlowRendererProps {
  nodes: FlowNode[];
  edges: FlowEdge[];
  selectedNodeId?: string | null;
  nodeTypes: NodeTypes;
  edgeTypes: EdgeTypes;
  onNodeClick?: (nodeId: string, node: FlowNode) => void;
  onPaneClick?: () => void;
  onConnect?: (sourceNodeId: string, sourceHandleId: string, targetNodeId: string, targetHandleId: string) => void;
  onNodeDrag?: (nodeId: string, position: { x: number; y: number }) => void;
  onInsertStep?: (sourceId: string, targetId: string) => void;
  fitViewOnMount?: boolean;
}

export const FlowRenderer = memo(function FlowRenderer({
  nodes,
  edges,
  selectedNodeId,
  nodeTypes,
  edgeTypes,
  onNodeClick,
  onPaneClick,
  onConnect,
  onNodeDrag,
  onInsertStep,
  fitViewOnMount = true,
}: FlowRendererProps) {
  const {
    viewport,
    isPanning,
    containerRef,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    fitView,
    zoomIn,
    zoomOut,
  } = useViewport(nodes, { fitViewOnMount });

  // Track container dimensions for minimap
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef]);

  // Compute handle positions from nodes
  const handleMap = useMemo(
    () => computeHandlePositions(nodes),
    [nodes],
  );

  // Connection drag (handle-to-handle)
  const {
    connectionDrag,
    handleInteractionProps,
    onDragPointerMove,
    onDragPointerUp,
    isDragging: isConnectionDragging,
  } = useConnectionDrag({ containerRef, viewport, handleMap, onConnect });

  // Node drag
  const {
    onNodePointerDown,
    onNodeDragMove,
    onNodeDragUp,
    isDragging: isNodeDragging,
  } = useNodeDrag({ containerRef, viewport });

  // Compute edge paths
  const computedEdges = useMemo(() => {
    return edges
      .map((edge) => {
        const endpoints = resolveEdgeEndpoints(edge, handleMap);
        if (!endpoints) return null;
        const path = smoothStepPath(
          endpoints.sourceX,
          endpoints.sourceY,
          endpoints.targetX,
          endpoints.targetY,
        );
        return {
          edge,
          path,
          sourceX: endpoints.sourceX,
          sourceY: endpoints.sourceY,
          targetX: endpoints.targetX,
          targetY: endpoints.targetY,
        } satisfies ComputedEdge;
      })
      .filter((e): e is ComputedEdge => e !== null);
  }, [edges, handleMap]);

  // Combined pointer move: all handlers guard internally via refs
  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const dragPos = onNodeDragMove(e);
      if (dragPos) {
        onNodeDrag?.(dragPos.nodeId, { x: dragPos.x, y: dragPos.y });
        return; // Don't pan while dragging a node
      }
      onDragPointerMove(e);
      onPointerMove(e);
    },
    [onNodeDragMove, onNodeDrag, onDragPointerMove, onPointerMove],
  );

  // Combined pointer up: all handlers guard internally via refs
  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const wasDragging = onNodeDragUp();
      if (wasDragging) {
        justDraggedRef.current = true;
      }
      onDragPointerUp(e);
      onPointerUp();
    },
    [onNodeDragUp, onDragPointerUp, onPointerUp],
  );

  // Track whether we're dragging (to distinguish click from pan)
  const handlePanePointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only process if clicking the container/background itself
      if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.paneTarget) {
        onPointerDown(e);
      }
    },
    [onPointerDown],
  );

  const handlePaneClick = useCallback(
    (e: React.MouseEvent) => {
      // Only fire pane click if the click was on the container/background
      if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.paneTarget) {
        onPaneClick?.();
      }
    },
    [onPaneClick],
  );

  // Track if a node drag just ended to suppress the click
  const justDraggedRef = useRef(false);

  const handleNodeClick = useCallback(
    (e: React.MouseEvent, nodeId: string, node: FlowNode) => {
      if (justDraggedRef.current) {
        queueMicrotask(() => { justDraggedRef.current = false; });
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      onNodeClick?.(nodeId, node);
    },
    [onNodeClick],
  );

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden"
      onWheel={onWheel}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerDown={handlePanePointerDown}
      onClick={handlePaneClick}
      style={{ touchAction: 'none', cursor: isNodeDragging() ? 'grabbing' : isConnectionDragging ? 'crosshair' : isPanning ? 'grabbing' : 'default' }}
      data-testid="flow-canvas"
    >
      {/* Dot background */}
      <DotBackground viewport={viewport} />

      {/* Transformed content layer */}
      <div
        className="absolute origin-top-left"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          willChange: 'transform',
        }}
        data-pane-target="true"
      >
        {/* SVG edge layer */}
        <EdgeRenderer edges={computedEdges} edgeTypes={edgeTypes} onInsertStep={onInsertStep} />

        {/* Temporary connection drag edge */}
        {connectionDrag && (() => {
          const sourceKey = `${connectionDrag.sourceNodeId}:${connectionDrag.sourceHandleId}`;
          const sourceHandle = handleMap.get(sourceKey);
          if (!sourceHandle) return null;
          const path = smoothStepPath(
            sourceHandle.x,
            sourceHandle.y,
            connectionDrag.cursorX,
            connectionDrag.cursorY,
          );
          return (
            <svg
              className="pointer-events-none absolute left-0 top-0 overflow-visible"
              style={{ width: 1, height: 1 }}
            >
              <path
                d={path}
                fill="none"
                stroke="rgba(255,255,255,0.4)"
                strokeWidth={2}
                strokeDasharray="6 4"
              />
            </svg>
          );
        })()}

        {/* HTML node layer */}
        {nodes.map((node) => {
          const NodeComponent = nodeTypes[node.type || 'step'] as
            | React.ComponentType<FlowNodeProps<Record<string, unknown>>>
            | undefined;
          if (!NodeComponent) return null;

          const isDraggable = node.type !== 'addStep';

          return (
            <div
              key={node.id}
              className="absolute"
              style={{
                left: node.position.x,
                top: node.position.y,
                cursor: isNodeDragging() ? 'grabbing' : 'pointer',
              }}
              data-testid={`flow-node-${node.id}`}
              onClick={(e) => handleNodeClick(e, node.id, node)}
              onPointerDown={isDraggable
                ? (e) => onNodePointerDown(e, node.id, node.position)
                : undefined}
            >
              <NodeComponent
                id={node.id}
                data={node.data}
                selected={node.id === selectedNodeId}
                handleProps={handleInteractionProps}
              />
            </div>
          );
        })}
      </div>

      {/* Controls overlay */}
      <Controls onZoomIn={zoomIn} onZoomOut={zoomOut} onFitView={fitView} />

      {/* MiniMap overlay */}
      <MiniMap
        nodes={nodes}
        viewport={viewport}
        containerWidth={containerSize.width}
        containerHeight={containerSize.height}
      />
    </div>
  );
});
