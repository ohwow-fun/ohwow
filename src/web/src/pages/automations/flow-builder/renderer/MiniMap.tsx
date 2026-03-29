import { memo, useMemo } from 'react';
import type { FlowNode, ViewportState } from './types';

interface MiniMapProps {
  nodes: FlowNode[];
  viewport: ViewportState;
  containerWidth: number;
  containerHeight: number;
}

const NODE_COLORS: Record<string, string> = {
  trigger: '#60a5fa',
  conditional: '#fb923c',
  addStep: 'rgba(255,255,255,0.1)',
  step: 'rgba(255,255,255,0.2)',
};

const MINIMAP_WIDTH = 160;
const MINIMAP_HEIGHT = 100;

export const MiniMap = memo(function MiniMap({
  nodes,
  viewport,
  containerWidth,
  containerHeight,
}: MiniMapProps) {
  const { rects, viewBox, viewportRect } = useMemo(() => {
    if (nodes.length === 0) {
      return {
        rects: [],
        viewBox: '0 0 100 100',
        viewportRect: { x: 0, y: 0, width: 100, height: 100 },
      };
    }

    // Compute bounds
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of nodes) {
      const w = node.width || 280;
      const h = node.height || 80;
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + w);
      maxY = Math.max(maxY, node.position.y + h);
    }

    const padding = 50;
    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;

    const rects = nodes.map((node) => ({
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      width: node.width || (node.type === 'addStep' ? 40 : 280),
      height: node.height || (node.type === 'addStep' ? 40 : node.type === 'conditional' ? 100 : 80),
      color: NODE_COLORS[node.type || 'step'] || NODE_COLORS.step,
    }));

    // Viewport rectangle in content coordinates
    const vx = -viewport.x / viewport.zoom;
    const vy = -viewport.y / viewport.zoom;
    const vw = containerWidth / viewport.zoom;
    const vh = containerHeight / viewport.zoom;

    return {
      rects,
      viewBox: `${minX} ${minY} ${contentWidth} ${contentHeight}`,
      viewportRect: { x: vx, y: vy, width: vw, height: vh },
    };
  }, [nodes, viewport, containerWidth, containerHeight]);

  return (
    <div
      className="absolute bottom-4 right-4 rounded-lg border border-white/[0.06] bg-black/60 backdrop-blur-sm"
      data-testid="flow-minimap"
      style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }}
    >
      <svg
        width={MINIMAP_WIDTH}
        height={MINIMAP_HEIGHT}
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
      >
        {rects.map((rect) => (
          <rect
            key={rect.id}
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
            fill={rect.color}
            rx={4}
          />
        ))}
        <rect
          x={viewportRect.x}
          y={viewportRect.y}
          width={viewportRect.width}
          height={viewportRect.height}
          fill="rgba(255, 255, 255, 0.05)"
          stroke="rgba(255, 255, 255, 0.2)"
          strokeWidth={2}
          rx={2}
        />
      </svg>
    </div>
  );
});
