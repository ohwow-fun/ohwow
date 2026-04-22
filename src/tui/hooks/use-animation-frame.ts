/**
 * Animation tick hook for TUI living animations.
 * Returns a monotonically-increasing counter that increments every `intervalMs`.
 * Use multiple calls with different intervals for different animation speeds.
 */
import { useState, useEffect } from 'react';

export function useAnimationTick(intervalMs: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return tick;
}
