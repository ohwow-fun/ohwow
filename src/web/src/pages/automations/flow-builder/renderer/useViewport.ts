import { useState, useCallback, useRef, useEffect } from 'react';
import type { FlowNode, ViewportState } from './types';

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.2;
const ZOOM_SENSITIVITY = 0.002;

interface UseViewportOptions {
  fitViewOnMount?: boolean;
  fitViewPadding?: number;
}

export function useViewport(
  nodes: FlowNode[],
  options: UseViewportOptions = {},
) {
  const { fitViewOnMount = true, fitViewPadding = 0.3 } = options;

  const [viewport, setViewport] = useState<ViewportState>({ x: 0, y: 0, zoom: 1 });
  const [isPanningState, setIsPanningState] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const viewportStart = useRef({ x: 0, y: 0 });
  const hasFitView = useRef(false);

  // Compute bounding box of all nodes
  const computeBounds = useCallback(
    (nodeList: FlowNode[]) => {
      if (nodeList.length === 0) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const node of nodeList) {
        const w = node.width || 280;
        const h = node.height || 80;
        minX = Math.min(minX, node.position.x);
        minY = Math.min(minY, node.position.y);
        maxX = Math.max(maxX, node.position.x + w);
        maxY = Math.max(maxY, node.position.y + h);
      }

      return { minX, minY, maxX, maxY };
    },
    [],
  );

  const fitView = useCallback(
    (nodeList?: FlowNode[]) => {
      const container = containerRef.current;
      if (!container) return;

      const target = nodeList || nodes;
      if (target.length === 0) return;

      const { minX, minY, maxX, maxY } = computeBounds(target);
      const contentWidth = maxX - minX;
      const contentHeight = maxY - minY;

      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;

      if (containerWidth === 0 || containerHeight === 0) return;

      const scaleX = containerWidth / (contentWidth * (1 + fitViewPadding));
      const scaleY = containerHeight / (contentHeight * (1 + fitViewPadding));
      const zoom = Math.min(Math.max(Math.min(scaleX, scaleY), MIN_ZOOM), MAX_ZOOM);

      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;

      setViewport({
        x: containerWidth / 2 - centerX * zoom,
        y: containerHeight / 2 - centerY * zoom,
        zoom,
      });
    },
    [nodes, computeBounds, fitViewPadding],
  );

  // Fit view on mount
  useEffect(() => {
    if (fitViewOnMount && !hasFitView.current && nodes.length > 0) {
      // Small delay to ensure container is measured
      const timer = setTimeout(() => {
        fitView();
        hasFitView.current = true;
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [fitViewOnMount, nodes.length, fitView]);

  // Wheel handler: zoom toward cursor
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      setViewport((prev) => {
        const delta = -e.deltaY * ZOOM_SENSITIVITY;
        const newZoom = Math.min(Math.max(prev.zoom + delta * prev.zoom, MIN_ZOOM), MAX_ZOOM);
        const ratio = newZoom / prev.zoom;

        return {
          x: mouseX - (mouseX - prev.x) * ratio,
          y: mouseY - (mouseY - prev.y) * ratio,
          zoom: newZoom,
        };
      });
    },
    [],
  );

  // Pointer handlers for panning
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only pan on left button and when clicking the background
      if (e.button !== 0) return;
      isPanning.current = true;
      setIsPanningState(true);
      panStart.current = { x: e.clientX, y: e.clientY };
      viewportStart.current = { x: viewport.x, y: viewport.y };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [viewport.x, viewport.y],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isPanning.current) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      setViewport((prev) => ({
        ...prev,
        x: viewportStart.current.x + dx,
        y: viewportStart.current.y + dy,
      }));
    },
    [],
  );

  const onPointerUp = useCallback(() => {
    isPanning.current = false;
    setIsPanningState(false);
  }, []);

  const zoomIn = useCallback(() => {
    setViewport((prev) => {
      const container = containerRef.current;
      if (!container) return prev;
      const cx = container.clientWidth / 2;
      const cy = container.clientHeight / 2;
      const newZoom = Math.min(prev.zoom + ZOOM_STEP, MAX_ZOOM);
      const ratio = newZoom / prev.zoom;
      return {
        x: cx - (cx - prev.x) * ratio,
        y: cy - (cy - prev.y) * ratio,
        zoom: newZoom,
      };
    });
  }, []);

  const zoomOut = useCallback(() => {
    setViewport((prev) => {
      const container = containerRef.current;
      if (!container) return prev;
      const cx = container.clientWidth / 2;
      const cy = container.clientHeight / 2;
      const newZoom = Math.max(prev.zoom - ZOOM_STEP, MIN_ZOOM);
      const ratio = newZoom / prev.zoom;
      return {
        x: cx - (cx - prev.x) * ratio,
        y: cy - (cy - prev.y) * ratio,
        zoom: newZoom,
      };
    });
  }, []);

  return {
    viewport,
    isPanning: isPanningState,
    containerRef,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    fitView,
    zoomIn,
    zoomOut,
  };
}
