/**
 * r3f.grid-background — port of ohwow.fun's canvas GridBackground into
 * R3F so the video's intro/outro use the exact same visual language as
 * the landing page. A grid of small rounded cells across a black
 * backdrop, each flickering with variable alpha, plus periodic row/
 * column "line sweeps" that ripple across the grid, plus ambient
 * twinkling of a subset of cells.
 *
 * We paint the grid into a canvas texture once per frame and map it
 * onto a full-screen plane. That's much cheaper than instantiating
 * one mesh per cell (thousands on a 1920×1080 grid) and matches the
 * landing page's rendering approach exactly (both are canvas 2D).
 *
 * Palette (derived from the landing page): white cells with low alpha
 * against pure black, accented by a faint neon lime/cyan glow that
 * echoes the landing hero gradient.
 *
 * Params:
 *   cellSize?:     number — px of each grid cell (default 22)
 *   cellFill?:     number — px of the inner fill (default 20)
 *   cellRadius?:   number — rounded corner radius (default 4)
 *   accentColor?:  string — neon accent for twinkles (default "#4de0ff")
 *   accentWarm?:   string — second accent for line sweeps (default "#4dff7a")
 *   twinkleCount?: number — how many cells can flicker at once (default 60)
 *   sweepEveryFrames?: number — frames between random sweeps (default 90)
 *   width?:        number — world-units width of the backing plane (default 18)
 *   height?:       number — world-units height of the backing plane (default 10)
 */
import React, { useMemo, useRef, useEffect } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import * as THREE from "three";

interface GridBackgroundProps {
  cellSize?: number;
  cellFill?: number;
  cellRadius?: number;
  accentColor?: string;
  accentWarm?: string;
  twinkleCount?: number;
  sweepEveryFrames?: number;
  width?: number;
  height?: number;
  motionProfile?: string;
}

// Canvas resolution — the texture is drawn at this size then uv-mapped
// onto the quad. 1080p native so the grid matches on-screen pixel scale.
const TEX_W = 1920;
const TEX_H = 1080;

interface Sweep {
  axis: "row" | "col";
  index: number;
  startFrame: number;
  direction: 1 | -1;
  color: string;
}

interface Twinkle {
  col: number;
  row: number;
  seed: number;
  bright: boolean;
}

export const GridBackground: React.FC<GridBackgroundProps> = ({
  cellSize = 22,
  cellFill = 20,
  cellRadius = 4,
  accentColor = "#4de0ff",
  accentWarm = "#4dff7a",
  twinkleCount = 60,
  sweepEveryFrames = 90,
  width = 18,
  height = 10,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Deterministic RNG seeded by index so every render of the same frame
  // produces identical output (important for remotion's parallel frames).
  const rng = useMemo(() => {
    let s = 1337 >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
  }, []);

  // Precompute the grid dimensions + a bank of twinkle cells.
  const cols = Math.floor(TEX_W / cellSize);
  const rows = Math.floor(TEX_H / cellSize);

  const twinkles: Twinkle[] = useMemo(() => {
    const arr: Twinkle[] = [];
    for (let i = 0; i < twinkleCount; i++) {
      arr.push({
        col: Math.floor(rng() * cols),
        row: Math.floor(rng() * rows),
        seed: rng(),
        bright: rng() < 0.2,
      });
    }
    return arr;
  }, [twinkleCount, cols, rows, rng]);

  // Precompute a schedule of sweeps across the full composition. Each
  // sweep is 45 frames of line animation; we kick off a new one every
  // sweepEveryFrames with random axis/index/direction.
  const sweeps: Sweep[] = useMemo(() => {
    const arr: Sweep[] = [];
    const totalFrames = 3600; // more than enough for a 2-min video
    for (let startFrame = 0; startFrame < totalFrames; startFrame += sweepEveryFrames) {
      const axis: "row" | "col" = rng() < 0.5 ? "row" : "col";
      const indexMax = axis === "row" ? rows : cols;
      arr.push({
        axis,
        index: Math.floor(rng() * indexMax),
        startFrame,
        direction: rng() < 0.5 ? 1 : -1,
        color: rng() < 0.5 ? accentColor : accentWarm,
      });
    }
    return arr;
  }, [sweepEveryFrames, rng, rows, cols, accentColor, accentWarm]);

  // Canvas texture generated per frame.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textureRef = useRef<THREE.CanvasTexture | null>(null);

  if (!canvasRef.current && typeof document !== "undefined") {
    canvasRef.current = document.createElement("canvas");
    canvasRef.current.width = TEX_W;
    canvasRef.current.height = TEX_H;
    textureRef.current = new THREE.CanvasTexture(canvasRef.current);
    textureRef.current.colorSpace = THREE.SRGBColorSpace;
  }

  // Paint the grid for this frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Fully clear with black (pure black background).
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, TEX_W, TEX_H);

    // Pass 1 — subtle border grid at very low alpha so the grid itself
    // is visible but dim. Mirrors landing's black hairline outlines.
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    for (let c = 0; c < cols; c++) {
      const x = c * cellSize + (cellSize - cellFill) / 2;
      for (let r = 0; r < rows; r++) {
        const y = r * cellSize + (cellSize - cellFill) / 2;
        roundedRect(ctx, x, y, cellFill, cellFill, cellRadius);
        ctx.stroke();
      }
    }

    // Pass 2 — ambient twinkles (the landing's per-cell flicker pulse).
    // Each twinkle has its own period derived from its seed; use the
    // seeded RNG to get an organic staggered feel.
    const t = frame / fps;
    for (const tw of twinkles) {
      const period = 1.5 + tw.seed * 2.5; // 1.5..4s
      const offset = tw.seed * period;
      const phase = ((t + offset) / period) % 1;
      // Bell curve: bright in the middle of the phase, dark at edges.
      const bell = Math.sin(phase * Math.PI);
      const peak = tw.bright ? 0.18 : 0.06;
      const alpha = Math.pow(bell, 1.5) * peak;
      if (alpha < 0.005) continue;
      const x = tw.col * cellSize + (cellSize - cellFill) / 2;
      const y = tw.row * cellSize + (cellSize - cellFill) / 2;
      ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
      roundedRect(ctx, x, y, cellFill, cellFill, cellRadius);
      ctx.fill();
    }

    // Pass 3 — line sweeps. Each active sweep illuminates a sliding
    // window of cells along its row/col with a fade-in/out pulse.
    const SWEEP_DURATION = 45; // frames
    for (const sw of sweeps) {
      const local = frame - sw.startFrame;
      if (local < 0 || local > SWEEP_DURATION) continue;
      const progress = local / SWEEP_DURATION;
      const head = progress * (sw.axis === "row" ? cols : rows);
      const tailLength = 8;
      const axisLen = sw.axis === "row" ? cols : rows;
      for (let offset = -tailLength; offset <= 0; offset++) {
        const rawPos = sw.direction > 0 ? head + offset : axisLen - head - offset;
        const pos = Math.floor(rawPos);
        if (pos < 0 || pos >= axisLen) continue;
        // Fade along the trail: head (offset=0) brightest, tail dim.
        const trailAlpha = (1 + offset / tailLength) * 0.22;
        if (trailAlpha < 0.01) continue;
        const col = sw.axis === "row" ? pos : sw.index;
        const row = sw.axis === "row" ? sw.index : pos;
        const x = col * cellSize + (cellSize - cellFill) / 2;
        const y = row * cellSize + (cellSize - cellFill) / 2;
        const rgb = hexToRgb(sw.color);
        ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${trailAlpha.toFixed(3)})`;
        roundedRect(ctx, x, y, cellFill, cellFill, cellRadius);
        ctx.fill();
      }
    }

    if (textureRef.current) textureRef.current.needsUpdate = true;
  }, [frame, fps, cellSize, cellFill, cellRadius, cols, rows, twinkles, sweeps]);

  if (!textureRef.current) return null;

  return (
    <mesh position={[0, 0, -5]}>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial map={textureRef.current} toneMapped={false} />
    </mesh>
  );
};

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const bigint = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255,
  };
}
