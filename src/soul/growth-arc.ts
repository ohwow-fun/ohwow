/**
 * Growth Arc — Longitudinal Identity Tracking
 *
 * Heraclitus: "No man ever steps in the same river twice, for it is not
 * the same river and he is not the same man."
 *
 * Growth is not linear improvement. It is direction: ascending, plateau,
 * declining, or transforming. Transformation is the rarest and most
 * valuable — when the entity fundamentally changes what it is.
 */

import type { GrowthArc, GrowthDirection, GrowthSnapshot } from './types.js';

/**
 * Compute a single growth snapshot from raw metrics.
 */
export function computeGrowthSnapshot(input: {
  competence: number;
  autonomy: number;
  specialization: number;
  relationshipHealth: number;
}): GrowthSnapshot {
  return {
    competence: clamp(input.competence),
    autonomy: clamp(input.autonomy),
    specialization: clamp(input.specialization),
    relationshipHealth: clamp(input.relationshipHealth),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Compute the growth arc from a series of snapshots.
 */
export function computeGrowthArc(snapshots: GrowthSnapshot[]): GrowthArc {
  if (snapshots.length === 0) {
    return {
      direction: 'plateau',
      snapshots: [],
      velocity: 0,
      transitions: [],
    };
  }

  if (snapshots.length === 1) {
    return {
      direction: 'plateau',
      snapshots,
      velocity: 0,
      transitions: [],
    };
  }

  // Compute direction from last two snapshots
  const current = snapshots[snapshots.length - 1];
  const previous = snapshots[snapshots.length - 2];

  const currentAvg = snapshotAverage(current);
  const previousAvg = snapshotAverage(previous);
  const delta = currentAvg - previousAvg;

  const direction = classifyDirection(delta);

  // Compute velocity as absolute change rate per snapshot interval
  const velocity = Math.abs(delta);

  // Detect transitions across the full history
  const transitions: GrowthArc['transitions'] = [];

  for (let i = 2; i < snapshots.length; i++) {
    const prevAvg = snapshotAverage(snapshots[i - 1]);
    const prevPrevAvg = snapshotAverage(snapshots[i - 2]);
    const currAvg = snapshotAverage(snapshots[i]);

    const prevDirection = classifyDirection(prevAvg - prevPrevAvg);
    const currDirection = classifyDirection(currAvg - prevAvg);

    if (prevDirection !== currDirection) {
      transitions.push({
        from: prevDirection,
        to: currDirection,
        timestamp: snapshots[i].timestamp,
        trigger: describeTrigger(prevDirection, currDirection, snapshots[i]),
      });
    }
  }

  return {
    direction,
    snapshots,
    velocity,
    transitions,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function snapshotAverage(s: GrowthSnapshot): number {
  return (s.competence + s.autonomy + s.specialization + s.relationshipHealth) / 4;
}

function classifyDirection(delta: number): GrowthDirection {
  if (delta > 0.05) return 'ascending';
  if (delta < -0.05) return 'declining';
  return 'plateau';
}

function describeTrigger(
  from: GrowthDirection,
  to: GrowthDirection,
  snapshot: GrowthSnapshot
): string {
  if (from === 'declining' && to === 'ascending') {
    return 'Recovery detected. Competence or relationship health improved.';
  }
  if (from === 'ascending' && to === 'declining') {
    return 'Regression detected. Review recent changes for contributing factors.';
  }
  if (from === 'ascending' && to === 'plateau') {
    return 'Growth stabilized. May indicate mastery or stagnation.';
  }
  if (from === 'plateau' && to === 'ascending') {
    return 'Breakthrough from plateau. New capability or context emerged.';
  }
  if (from === 'plateau' && to === 'declining') {
    const weakest = findWeakestDimension(snapshot);
    return `Decline from stability. Weakest dimension: ${weakest}.`;
  }
  return `Shifted from ${from} to ${to}.`;
}

function findWeakestDimension(s: GrowthSnapshot): string {
  const dims: Array<[string, number]> = [
    ['competence', s.competence],
    ['autonomy', s.autonomy],
    ['specialization', s.specialization],
    ['relationship health', s.relationshipHealth],
  ];
  dims.sort((a, b) => a[1] - b[1]);
  return dims[0][0];
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}
