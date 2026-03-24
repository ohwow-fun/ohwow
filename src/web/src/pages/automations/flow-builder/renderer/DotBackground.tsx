import { memo } from 'react';
import type { ViewportState } from './types';

interface DotBackgroundProps {
  viewport: ViewportState;
  gap?: number;
  size?: number;
  color?: string;
}

export const DotBackground = memo(function DotBackground({
  viewport,
  gap = 20,
  size = 1,
  color = 'rgba(255, 255, 255, 0.03)',
}: DotBackgroundProps) {
  const scaledGap = gap * viewport.zoom;

  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage: `radial-gradient(circle, ${color} ${size}px, transparent ${size}px)`,
        backgroundSize: `${scaledGap}px ${scaledGap}px`,
        backgroundPosition: `${viewport.x % scaledGap}px ${viewport.y % scaledGap}px`,
      }}
    />
  );
});
