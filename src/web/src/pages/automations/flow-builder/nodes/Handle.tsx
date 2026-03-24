import { memo, useCallback } from 'react';
import type { HandleInteractionProps } from '../renderer/types';

interface HandleProps {
  nodeId: string;
  handleId: string;
  type: 'source' | 'target';
  position: 'top' | 'bottom';
  left?: string;
  colorClass?: string;
  handleProps?: HandleInteractionProps;
}

export const Handle = memo(function Handle({
  nodeId,
  handleId,
  type,
  position,
  left,
  colorClass = 'bg-white/30',
  handleProps,
}: HandleProps) {
  const isDropTarget =
    handleProps?.activeDropTarget?.nodeId === nodeId &&
    handleProps?.activeDropTarget?.handleId === handleId;

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      handleProps?.onPointerDown(e, nodeId, handleId, type);
    },
    [handleProps, nodeId, handleId, type],
  );

  const positionClasses = position === 'top' ? '-top-1.5' : '-bottom-1.5';
  const leftStyle = left ?? '50%';

  return (
    <div
      className={`
        absolute ${positionClasses} h-3 w-3 -translate-x-1/2 rounded-full border-2 border-[#0a0a0a]
        ${colorClass}
        transition-transform duration-100
        ${isDropTarget ? 'scale-150 ring-2 ring-white/40' : ''}
        ${handleProps ? 'cursor-crosshair' : ''}
      `}
      style={{ left: leftStyle }}
      onPointerDown={handleProps ? onPointerDown : undefined}
      data-handle
      data-handle-node={nodeId}
      data-handle-id={handleId}
      data-handle-type={type}
    />
  );
});
