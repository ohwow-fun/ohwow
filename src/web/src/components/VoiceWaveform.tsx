/**
 * VoiceWaveform (Runtime Web UI)
 * Canvas-based animated waveform visualization.
 */

import { useRef, useEffect } from 'react';
import type { VoiceCallState } from '../lib/voice-types';

interface VoiceWaveformProps {
  state: VoiceCallState;
  className?: string;
}

const BAR_COUNT = 24;
const BAR_WIDTH = 3;
const BAR_GAP = 2;
const MIN_HEIGHT = 2;
const MAX_HEIGHT = 32;

export function VoiceWaveform({ state, className = '' }: VoiceWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = BAR_COUNT * (BAR_WIDTH + BAR_GAP) - BAR_GAP;
    canvas.width = width * 2;
    canvas.height = MAX_HEIGHT * 2;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${MAX_HEIGHT}px`;
    ctx.scale(2, 2);

    const bars = new Float32Array(BAR_COUNT).fill(0);

    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, width, MAX_HEIGHT);

      for (let i = 0; i < BAR_COUNT; i++) {
        const target = getTargetHeight(state, i, Date.now());
        bars[i] += (target - bars[i]) * 0.15;
        const h = Math.max(MIN_HEIGHT, bars[i]);

        const x = i * (BAR_WIDTH + BAR_GAP);
        const y = (MAX_HEIGHT - h) / 2;

        ctx.fillStyle = getBarColor(state);
        ctx.beginPath();
        ctx.roundRect(x, y, BAR_WIDTH, h, 1.5);
        ctx.fill();
      }

      animRef.current = requestAnimationFrame(draw);
    }

    draw();
    return () => cancelAnimationFrame(animRef.current);
  }, [state]);

  return <canvas ref={canvasRef} className={className} />;
}

function getTargetHeight(state: VoiceCallState, barIndex: number, time: number): number {
  switch (state) {
    case 'listening': {
      const wave = Math.sin(time / 200 + barIndex * 0.5) * 0.5 + 0.5;
      return MIN_HEIGHT + wave * (MAX_HEIGHT * 0.6 - MIN_HEIGHT);
    }
    case 'processing': {
      const center = BAR_COUNT / 2;
      const dist = Math.abs(barIndex - center) / center;
      const pulse = Math.sin(time / 300) * 0.5 + 0.5;
      return MIN_HEIGHT + (1 - dist) * pulse * MAX_HEIGHT * 0.4;
    }
    case 'speaking': {
      const wave1 = Math.sin(time / 150 + barIndex * 0.4) * 0.5 + 0.5;
      const wave2 = Math.sin(time / 250 + barIndex * 0.7) * 0.3 + 0.3;
      return MIN_HEIGHT + (wave1 + wave2) * (MAX_HEIGHT * 0.45);
    }
    default:
      return MIN_HEIGHT;
  }
}

function getBarColor(state: VoiceCallState): string {
  switch (state) {
    case 'listening':
      return 'rgba(59, 130, 246, 0.8)';
    case 'processing':
      return 'rgba(168, 85, 247, 0.6)';
    case 'speaking':
      return 'rgba(34, 197, 94, 0.8)';
    default:
      return 'rgba(255, 255, 255, 0.2)';
  }
}
