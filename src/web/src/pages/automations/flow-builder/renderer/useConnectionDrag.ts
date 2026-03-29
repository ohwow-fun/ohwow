import { useState, useCallback, useRef } from 'react';
import type { ViewportState, HandleInfo, HandleInteractionProps, ConnectionDragState } from './types';

const HIT_RADIUS = 20;

interface UseConnectionDragOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  viewport: ViewportState;
  handleMap: Map<string, HandleInfo>;
  onConnect?: (sourceNodeId: string, sourceHandleId: string, targetNodeId: string, targetHandleId: string) => void;
}

export function useConnectionDrag({
  containerRef,
  viewport,
  handleMap,
  onConnect,
}: UseConnectionDragOptions) {
  const [connectionDrag, setConnectionDrag] = useState<ConnectionDragState | null>(null);
  const [activeDropTarget, setActiveDropTarget] = useState<{ nodeId: string; handleId: string } | null>(null);
  const dragRef = useRef<ConnectionDragState | null>(null);
  const dropTargetRef = useRef<{ nodeId: string; handleId: string } | null>(null);
  const capturedPointerIdRef = useRef<number | null>(null);

  /** Convert screen coordinates to flow-space coordinates */
  const screenToFlow = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: clientX, y: clientY };
      return {
        x: (clientX - rect.left - viewport.x) / viewport.zoom,
        y: (clientY - rect.top - viewport.y) / viewport.zoom,
      };
    },
    [containerRef, viewport],
  );

  /** Find the nearest valid drop target handle within HIT_RADIUS */
  const findDropTarget = useCallback(
    (flowX: number, flowY: number, drag: ConnectionDragState): { nodeId: string; handleId: string } | null => {
      const oppositeType = drag.sourceType === 'source' ? 'target' : 'source';
      let bestDist = HIT_RADIUS;
      let best: { nodeId: string; handleId: string } | null = null;

      for (const handle of handleMap.values()) {
        // Must be opposite type
        if (handle.type !== oppositeType) continue;
        // No self-connections
        if (handle.nodeId === drag.sourceNodeId) continue;

        const dx = handle.x - flowX;
        const dy = handle.y - flowY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestDist) {
          bestDist = dist;
          best = { nodeId: handle.nodeId, handleId: handle.handleId };
        }
      }

      return best;
    },
    [handleMap],
  );

  /** Called when user presses down on a handle */
  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent, nodeId: string, handleId: string, type: 'source' | 'target') => {
      e.stopPropagation();
      e.preventDefault();

      const flow = screenToFlow(e.clientX, e.clientY);
      const drag: ConnectionDragState = {
        sourceNodeId: nodeId,
        sourceHandleId: handleId,
        sourceType: type,
        cursorX: flow.x,
        cursorY: flow.y,
      };
      dragRef.current = drag;
      setConnectionDrag(drag);

      // Capture pointer so we receive pointerup even if cursor leaves the container
      containerRef.current?.setPointerCapture(e.pointerId);
      capturedPointerIdRef.current = e.pointerId;
    },
    [screenToFlow, containerRef],
  );

  /** Called on container pointer move (combined with viewport panning) */
  const onDragPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;

      const flow = screenToFlow(e.clientX, e.clientY);
      const updated: ConnectionDragState = {
        ...dragRef.current,
        cursorX: flow.x,
        cursorY: flow.y,
      };
      dragRef.current = updated;
      setConnectionDrag(updated);

      const target = findDropTarget(flow.x, flow.y, updated);
      dropTargetRef.current = target;
      setActiveDropTarget(target);
    },
    [screenToFlow, findDropTarget],
  );

  /** Called on container pointer up */
  const onDragPointerUp = useCallback((e?: React.PointerEvent) => {
    const drag = dragRef.current;
    let target = dropTargetRef.current;

    // Fallback: re-check drop target at final pointer position
    if (drag && !target && e) {
      const flow = screenToFlow(e.clientX, e.clientY);
      target = findDropTarget(flow.x, flow.y, drag);
    }

    if (drag && target && onConnect) {
      // Ensure source->target direction regardless of which end the user started from
      if (drag.sourceType === 'source') {
        onConnect(drag.sourceNodeId, drag.sourceHandleId, target.nodeId, target.handleId);
      } else {
        onConnect(target.nodeId, target.handleId, drag.sourceNodeId, drag.sourceHandleId);
      }
    }

    // Release pointer capture
    if (capturedPointerIdRef.current !== null) {
      containerRef.current?.releasePointerCapture(capturedPointerIdRef.current);
      capturedPointerIdRef.current = null;
    }

    dragRef.current = null;
    dropTargetRef.current = null;
    setConnectionDrag(null);
    setActiveDropTarget(null);
  }, [onConnect, containerRef, screenToFlow, findDropTarget]);

  const handleInteractionProps: HandleInteractionProps = {
    onPointerDown: onHandlePointerDown,
    activeDropTarget,
  };

  return {
    connectionDrag,
    handleInteractionProps,
    onDragPointerMove,
    onDragPointerUp,
    isDragging: connectionDrag !== null,
  };
}
