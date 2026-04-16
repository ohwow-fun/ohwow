/**
 * Generative art primitives for deterministic motion graphics.
 *
 * All functions take `frame` and optional seeds — same inputs always produce
 * the same output. This is the creative foundation layer that scene components
 * compose to produce visually rich, unique-feeling video without randomness.
 *
 * Core concepts:
 * - Noise fields: continuous, organic motion via @remotion/noise
 * - Flow fields: directional particle systems driven by noise
 * - Parametric curves: Lissajous, spirals, orbits for path animation
 * - Wave interference: overlapping sine waves for shimmer, breath, pulse
 * - Color palettes: HSL-derived harmonies from a seed hue
 * - Particle emitters: deterministic particle bursts and trails
 */

import React from "react";
import { useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { noise2D, noise3D } from "@remotion/noise";

// ─── Noise utilities ──────────────────────────────────────────────────────────

export function drift2D(seed: string, frame: number, scale = 0.003, amp = 8): { x: number; y: number } {
  return {
    x: noise2D(seed, frame * scale, 0) * amp,
    y: noise2D(seed, 0, frame * scale) * amp,
  };
}

export function breathe(frame: number, speed = 0.06, depth = 0.04): number {
  return 1 + Math.sin(frame * speed) * depth;
}

export function shimmer(frame: number, index: number, speed = 0.04, offset = 0.3): number {
  const phase = ((frame * speed) - index * offset) % (Math.PI * 2);
  return Math.max(0, Math.sin(phase));
}

// ─── Wave interference ────────────────────────────────────────────────────────

export function waveInterference(
  frame: number,
  waves: Array<{ freq: number; amp: number; phase: number }>,
): number {
  let val = 0;
  for (const w of waves) {
    val += Math.sin(frame * w.freq + w.phase) * w.amp;
  }
  return val;
}

// ─── Parametric curves ────────────────────────────────────────────────────────

export function lissajous(t: number, a: number, b: number, delta: number, scale = 100): { x: number; y: number } {
  return {
    x: Math.sin(a * t + delta) * scale,
    y: Math.sin(b * t) * scale,
  };
}

export function spiral(t: number, growth = 0.5, scale = 1): { x: number; y: number } {
  const r = growth * t * scale;
  return { x: Math.cos(t) * r, y: Math.sin(t) * r };
}

export function orbit(frame: number, speed: number, radius: number, yRatio = 0.4, phaseOffset = 0): { x: number; y: number; depth: number } {
  const angle = phaseOffset + frame * speed;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius * yRatio,
    depth: (Math.sin(angle) + 1) / 2,
  };
}

// ─── Color palettes (HSL-based, deterministic) ────────────────────────────────

export interface PaletteColor {
  hsl: string;
  hex: string;
  r: number;
  g: number;
  b: number;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

export function palette(seedHue: number, count: number, harmony: 'analogous' | 'complementary' | 'triadic' | 'split' = 'analogous'): PaletteColor[] {
  const hues: number[] = [];
  const step = harmony === 'analogous' ? 30 : harmony === 'complementary' ? 180 : harmony === 'triadic' ? 120 : 150;
  for (let i = 0; i < count; i++) {
    hues.push((seedHue + (step / count) * i) % 360);
  }
  return hues.map((h, i) => {
    const s = 0.7 - i * 0.05;
    const l = 0.55 + i * 0.03;
    const [r, g, b] = hslToRgb(h, s, l);
    return { hsl: `hsl(${h}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`, hex: rgbToHex(r, g, b), r, g, b };
  });
}

// ─── Flow field particles ─────────────────────────────────────────────────────

export interface FlowParticle {
  x: number;
  y: number;
  opacity: number;
  size: number;
  color: string;
}

export function flowField(params: {
  frame: number;
  count: number;
  width: number;
  height: number;
  seed: string;
  speed?: number;
  colors?: string[];
}): FlowParticle[] {
  const { frame, count, width, height, seed, speed = 1, colors = ['#f97316', '#3b82f6', '#22c55e'] } = params;
  const particles: FlowParticle[] = [];
  for (let i = 0; i < count; i++) {
    const progress = ((frame * speed * (0.8 + (i % 5) * 0.2) + i * 40) % 500) / 500;
    const baseX = noise2D(`${seed}-x-${i}`, progress * 3, i * 0.1) * width * 0.8;
    const baseY = noise2D(`${seed}-y-${i}`, i * 0.1, progress * 3) * height * 0.6;
    const opacity = Math.sin(progress * Math.PI) * 0.6;
    const size = 2 + (i % 4);
    particles.push({
      x: width / 2 + baseX,
      y: height / 2 + baseY,
      opacity: Math.max(0, opacity),
      size,
      color: colors[i % colors.length],
    });
  }
  return particles;
}

// ─── React components ─────────────────────────────────────────────────────────

export const FlowFieldLayer: React.FC<{
  count?: number;
  seed?: string;
  speed?: number;
  colors?: string[];
  width?: number;
  height?: number;
}> = ({ count = 30, seed = 'flow', speed = 1, colors, width = 1280, height = 720 }) => {
  const frame = useCurrentFrame();
  const particles = flowField({ frame, count, width, height, seed, speed, colors });
  return (
    <>
      {particles.map((p, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: p.x,
            top: p.y,
            width: p.size,
            height: p.size,
            borderRadius: '50%',
            background: p.color,
            opacity: p.opacity,
            boxShadow: `0 0 ${p.size * 3}px ${p.color}60`,
            pointerEvents: 'none',
          }}
        />
      ))}
    </>
  );
};

export const PulseRing: React.FC<{
  cx?: string;
  cy?: string;
  radius: number;
  color?: string;
  speed?: number;
  thickness?: number;
}> = ({ cx = '50%', cy = '50%', radius, color = '#f97316', speed = 0.08, thickness = 1 }) => {
  const frame = useCurrentFrame();
  const scale = breathe(frame, speed, 0.1);
  const opacity = 0.15 + shimmer(frame, 0, speed * 1.5) * 0.2;
  return (
    <div
      style={{
        position: 'absolute',
        left: cx,
        top: cy,
        width: radius * 2,
        height: radius * 2,
        marginLeft: -radius,
        marginTop: -radius,
        border: `${thickness}px solid ${color}`,
        borderRadius: '50%',
        transform: `scale(${scale})`,
        opacity,
        pointerEvents: 'none',
      }}
    />
  );
};

export const GlowOrb: React.FC<{
  cx?: string;
  cy?: string;
  size?: number;
  color?: string;
  pulseSpeed?: number;
}> = ({ cx = '50%', cy = '50%', size = 60, color = '#f97316', pulseSpeed = 0.08 }) => {
  const frame = useCurrentFrame();
  const scale = breathe(frame, pulseSpeed, 0.1);
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <div
      style={{
        position: 'absolute',
        left: cx,
        top: cy,
        width: size,
        height: size,
        marginLeft: -size / 2,
        marginTop: -size / 2,
        borderRadius: '50%',
        background: `radial-gradient(circle, ${color}60 0%, ${color}10 50%, transparent 70%)`,
        transform: `scale(${scale})`,
        opacity,
        boxShadow: `0 0 ${size}px ${color}40`,
        pointerEvents: 'none',
      }}
    />
  );
};

export const NoiseGrid: React.FC<{
  cols?: number;
  rows?: number;
  cellSize?: number;
  seed?: string;
  color?: string;
  speed?: number;
}> = ({ cols = 16, rows = 9, cellSize = 80, seed = 'grid', color = '#f97316', speed = 0.005 }) => {
  const frame = useCurrentFrame();
  const cells: React.ReactElement[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const n = noise2D(seed, x * 0.3 + frame * speed, y * 0.3);
      const opacity = Math.max(0, n * 0.15 + 0.02);
      cells.push(
        <div
          key={`${x}-${y}`}
          style={{
            position: 'absolute',
            left: x * cellSize,
            top: y * cellSize,
            width: cellSize - 1,
            height: cellSize - 1,
            background: color,
            opacity,
            borderRadius: 2,
          }}
        />,
      );
    }
  }
  return <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>{cells}</div>;
};
