/**
 * Animated mouse cursor that moves between waypoints with realistic easing.
 * Shows click ripple animation at each stop.
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";

export interface CursorWaypoint {
  x: number;
  y: number;
  frame: number; // absolute frame to arrive at this point
  click?: boolean; // show click ripple
}

interface CursorProps {
  waypoints: CursorWaypoint[];
  color?: string;
  size?: number;
}

export const Cursor: React.FC<CursorProps> = ({
  waypoints,
  color = "#ffffff",
  size = 18,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (waypoints.length === 0) return null;

  // Find current segment
  let currentX = waypoints[0].x;
  let currentY = waypoints[0].y;
  let isClicking = false;
  let clickFrame = -100;

  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    if (frame < wp.frame) {
      if (i === 0) {
        currentX = wp.x;
        currentY = wp.y;
      } else {
        const prev = waypoints[i - 1];
        const travelDuration = wp.frame - prev.frame;
        const t = spring({
          fps,
          frame: frame - prev.frame,
          config: { damping: 28, stiffness: 120 },
          durationInFrames: Math.min(travelDuration, 20),
        });
        currentX = interpolate(t, [0, 1], [prev.x, wp.x]);
        currentY = interpolate(t, [0, 1], [prev.y, wp.y]);
      }
      break;
    } else {
      currentX = wp.x;
      currentY = wp.y;
      if (wp.click) {
        clickFrame = wp.frame;
      }
    }
  }

  // Check if we just clicked
  const timeSinceClick = frame - clickFrame;
  isClicking = timeSinceClick >= 0 && timeSinceClick < 15;

  // Cursor visibility (fade in)
  const firstFrame = waypoints[0].frame;
  const cursorOpacity = interpolate(frame, [firstFrame - 5, firstFrame], [0, 0.9], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Subtle idle wobble
  const wobbleX = Math.sin(frame * 0.03) * 0.5;
  const wobbleY = Math.cos(frame * 0.04) * 0.5;

  return (
    <>
      {/* Click ripple */}
      {isClicking && (
        <div
          style={{
            position: "absolute",
            left: currentX,
            top: currentY,
            transform: "translate(-50%, -50%)",
            pointerEvents: "none",
            zIndex: 1000,
          }}
        >
          {[0, 4, 8].map((delay) => {
            const rippleFrame = timeSinceClick - delay;
            if (rippleFrame < 0) return null;
            const rippleSize = interpolate(rippleFrame, [0, 12], [0, 40], {
              extrapolateRight: "clamp",
            });
            const rippleOpacity = interpolate(rippleFrame, [0, 12], [0.5, 0], {
              extrapolateRight: "clamp",
            });
            return (
              <div
                key={delay}
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  transform: "translate(-50%, -50%)",
                  width: rippleSize,
                  height: rippleSize,
                  borderRadius: "50%",
                  border: `1.5px solid ${color}`,
                  opacity: rippleOpacity,
                }}
              />
            );
          })}
        </div>
      )}

      {/* Cursor arrow */}
      <div
        style={{
          position: "absolute",
          left: currentX + wobbleX,
          top: currentY + wobbleY,
          opacity: cursorOpacity,
          transform: `scale(${isClicking ? 0.85 : 1})`,
          transition: "transform 0.05s",
          pointerEvents: "none",
          zIndex: 1001,
          filter: `drop-shadow(0 2px 4px rgba(0,0,0,0.5))`,
        }}
      >
        <svg width={size} height={size * 1.3} viewBox="0 0 16 20" fill="none">
          <path
            d="M1 1L1 15L5.5 11L10 18L13 16.5L8.5 9.5L14 8.5L1 1Z"
            fill={color}
            stroke="rgba(0,0,0,0.4)"
            strokeWidth="1"
          />
        </svg>
      </div>
    </>
  );
};
