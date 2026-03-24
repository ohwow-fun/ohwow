import { memo, useState, useCallback } from 'react';
import type { FlowEdgeProps } from '../renderer/types';
import { useRunOverlay } from '../context/RunOverlayContext';

export const DataFlowEdge = memo(function DataFlowEdge(props: FlowEdgeProps) {
  const { path, source, target, data, sourceX, sourceY, targetX, targetY, onInsertStep } = props;
  const [hovered, setHovered] = useState(false);

  const { overlayRun, getStepResult } = useRunOverlay();
  const branchType = data?.branchType as string | undefined;

  let strokeColor: string;
  if (overlayRun) {
    const targetResult = getStepResult(target);
    if (targetResult?.status === 'completed') {
      strokeColor = 'rgba(52, 211, 153, 0.5)';
    } else if (targetResult?.status === 'failed') {
      strokeColor = 'rgba(248, 113, 113, 0.5)';
    } else if (targetResult?.status === 'running') {
      strokeColor = 'rgba(96, 165, 250, 0.5)';
    } else {
      strokeColor = 'rgba(255, 255, 255, 0.12)';
    }
  } else {
    strokeColor = branchType === 'then'
      ? 'rgba(52, 211, 153, 0.3)'
      : branchType === 'else'
        ? 'rgba(251, 191, 36, 0.3)'
        : 'rgba(255, 255, 255, 0.2)';
  }

  const handleInsert = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onInsertStep?.(source, target);
    },
    [onInsertStep, source, target],
  );

  // Compute midpoint for the insert button
  const hasMidpoint =
    onInsertStep &&
    sourceX != null &&
    sourceY != null &&
    targetX != null &&
    targetY != null;
  const midX = hasMidpoint ? (sourceX! + targetX!) / 2 : 0;
  const midY = hasMidpoint ? (sourceY! + targetY!) / 2 : 0;
  const btnSize = 24;

  return (
    <g
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Invisible wide stroke for easier hover detection */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        style={{ pointerEvents: 'stroke' }}
      />

      {/* Visible edge */}
      <path
        d={path}
        fill="none"
        stroke={strokeColor}
        strokeWidth={2}
        style={{ pointerEvents: 'none' }}
      />

      {/* Insert button at midpoint on hover */}
      {hasMidpoint && hovered && (
        <foreignObject
          x={midX - btnSize / 2}
          y={midY - btnSize / 2}
          width={btnSize}
          height={btnSize}
          style={{ overflow: 'visible', pointerEvents: 'all' }}
        >
          <button
            type="button"
            onClick={handleInsert}
            className="flex h-6 w-6 items-center justify-center rounded-full border border-white/20 bg-zinc-800 text-xs text-white/70 shadow-lg transition-all hover:border-white/40 hover:bg-zinc-700 hover:text-white"
            title="Insert step"
          >
            +
          </button>
        </foreignObject>
      )}
    </g>
  );
});
