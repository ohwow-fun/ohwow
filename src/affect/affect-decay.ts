import type { AffectReading, AffectState } from './types.js';

const INTENSITY_FLOOR = 0.05;

/** Apply exponential decay to all affect readings, remove those below floor */
export function decayAffects(readings: AffectReading[], now: number): AffectReading[] {
  return readings
    .map(r => {
      const elapsedSec = (now - r.timestamp) / 1000;
      const decayedIntensity = r.intensity * Math.exp(-r.decayRate * elapsedSec);
      return { ...r, intensity: decayedIntensity };
    })
    .filter(r => r.intensity >= INTENSITY_FLOOR);
}

/** Compute aggregate affect state from active readings */
export function computeAffectState(readings: AffectReading[], now: number): AffectState {
  const active = decayAffects(readings, now);

  if (active.length === 0) {
    return {
      dominant: 'satisfaction',  // neutral default
      valence: 0,
      arousal: 0.2,
      affects: [],
      timestamp: now,
    };
  }

  // Weighted average by intensity
  let totalWeight = 0;
  let weightedValence = 0;
  let weightedArousal = 0;

  for (const a of active) {
    totalWeight += a.intensity;
    weightedValence += a.valence * a.intensity;
    weightedArousal += a.arousal * a.intensity;
  }

  const dominant = active.reduce((best, curr) =>
    curr.intensity > best.intensity ? curr : best
  );

  return {
    dominant: dominant.type,
    valence: totalWeight > 0 ? weightedValence / totalWeight : 0,
    arousal: totalWeight > 0 ? weightedArousal / totalWeight : 0.2,
    affects: active,
    timestamp: now,
  };
}
