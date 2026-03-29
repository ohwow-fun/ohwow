import { useCallback, useRef, useEffect } from 'react';
import type { ViewportState } from './types';

const DRAG_THRESHOLD = 5;

interface NodeDragState {
  nodeId: string;
  startPointerX: number;
  startPointerY: number;
  startNodeX: number;
  startNodeY: number;
  isDragging: boolean;
}

interface UseNodeDragOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  viewport: ViewportState;
}

export function useNodeDrag({ containerRef, viewport }: UseNodeDragOptions) {
  const dragRef = useRef<NodeDragState | null>(null);
  const viewportRef = useRef(viewport);
  useEffect(() => { viewportRef.current = viewport; }, [viewport]);

  const onNodePointerDown = useCallback(
    (e: React.PointerEvent, nodeId: string, nodePosition: { x: number; y: number }) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('[data-handle]')) return;

      e.stopPropagation();

      dragRef.current = {
        nodeId,
        startPointerX: e.clientX,
        startPointerY: e.clientY,
        startNodeX: nodePosition.x,
        startNodeY: nodePosition.y,
        isDragging: false,
      };

    },
    [],
  );

  /** Returns new position if dragging, null otherwise */
  const onNodeDragMove = useCallback(
    (e: React.PointerEvent): { nodeId: string; x: number; y: number } | null => {
      const drag = dragRef.current;
      if (!drag) return null;

      const dx = e.clientX - drag.startPointerX;
      const dy = e.clientY - drag.startPointerY;

      if (!drag.isDragging) {
        if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return null;
        drag.isDragging = true;
        // Capture pointer only once drag threshold is exceeded, so clicks aren't swallowed
        containerRef.current?.setPointerCapture(e.pointerId);
      }

      const vp = viewportRef.current;
      return {
        nodeId: drag.nodeId,
        x: drag.startNodeX + dx / vp.zoom,
        y: drag.startNodeY + dy / vp.zoom,
      };
    },
    [containerRef],
  );

  /** Returns true if a drag actually happened (vs. a click) */
  const onNodeDragUp = useCallback((): boolean => {
    const drag = dragRef.current;
    if (!drag) return false;
    const wasDragging = drag.isDragging;
    dragRef.current = null;
    return wasDragging;
  }, []);

  return {
    onNodePointerDown,
    onNodeDragMove,
    onNodeDragUp,
    isDragging: () => dragRef.current?.isDragging ?? false,
  };
}
