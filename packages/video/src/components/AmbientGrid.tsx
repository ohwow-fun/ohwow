/**
 * Ambient background grid with floating particles.
 * Subtle grid lines + drifting dots for visual depth.
 */

import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import { noise2D } from "@remotion/noise";
import { colors } from "./design";

interface AmbientGridProps {
  /** Grid line opacity (0-1, default 0.03) */
  gridOpacity?: number;
  /** Number of floating particles (default 25) */
  particleCount?: number;
  /** Particle color (default accent) */
  particleColor?: string;
  /** Show grid lines (default true) */
  showGrid?: boolean;
}

export const AmbientGrid: React.FC<AmbientGridProps> = ({
  gridOpacity = 0.03,
  particleCount = 25,
  particleColor = colors.accent,
  showGrid = true,
}) => {
  const frame = useCurrentFrame();

  return (
    <>
      {/* Subtle grid */}
      {showGrid && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: gridOpacity,
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.4) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.4) 1px, transparent 1px)
            `,
            backgroundSize: "60px 60px",
            transform: `translateY(${(frame * 0.1) % 60}px)`,
          }}
        />
      )}

      {/* Radial vignette */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse at center, transparent 40%, ${colors.bg} 100%)`,
          pointerEvents: "none",
        }}
      />

      {/* Floating particles */}
      {Array.from({ length: particleCount }, (_, i) => {
        const baseX = ((i * 137.5) % 1280);
        const baseY = ((i * 89.3) % 720);
        const driftX = noise2D(`gx-${i}`, frame * 0.003, i * 0.7) * 40;
        const driftY = noise2D(`gy-${i}`, frame * 0.004, i * 0.3) * 30;
        const pulse = 0.15 + Math.sin(frame * 0.02 + i * 1.2) * 0.1;
        const size = 2 + (i % 3);

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: baseX + driftX,
              top: baseY + driftY,
              width: size,
              height: size,
              borderRadius: "50%",
              background: i % 3 === 0 ? particleColor : `rgba(255,255,255,${pulse * 0.5})`,
              opacity: pulse,
              boxShadow: i % 3 === 0
                ? `0 0 ${size * 4}px ${particleColor}30`
                : "none",
              pointerEvents: "none",
            }}
          />
        );
      })}
    </>
  );
};
