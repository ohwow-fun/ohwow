import { memo } from 'react';
import { Plus, Minus, Crosshair } from '@phosphor-icons/react';

interface ControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitView: () => void;
}

export const Controls = memo(function Controls({
  onZoomIn,
  onZoomOut,
  onFitView,
}: ControlsProps) {
  return (
    <div
      className="absolute bottom-4 left-4 flex flex-col rounded-lg border border-white/[0.06] bg-black/60 shadow-lg backdrop-blur-sm"
      data-testid="flow-controls"
    >
      <button
        onClick={onZoomIn}
        className="flex h-8 w-8 items-center justify-center border-b border-white/[0.06] text-neutral-400 transition-colors hover:bg-white/[0.05] hover:text-white"
        aria-label="Zoom in"
      >
        <Plus size={14} weight="bold" />
      </button>
      <button
        onClick={onZoomOut}
        className="flex h-8 w-8 items-center justify-center border-b border-white/[0.06] text-neutral-400 transition-colors hover:bg-white/[0.05] hover:text-white"
        aria-label="Zoom out"
      >
        <Minus size={14} weight="bold" />
      </button>
      <button
        onClick={onFitView}
        className="flex h-8 w-8 items-center justify-center text-neutral-400 transition-colors hover:bg-white/[0.05] hover:text-white"
        aria-label="Fit view"
      >
        <Crosshair size={14} weight="bold" />
      </button>
    </div>
  );
});
