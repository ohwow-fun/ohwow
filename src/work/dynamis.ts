/**
 * Dynamis — Capacity Modeling (Aristotle)
 *
 * "For that which is potentially may either be or not be."
 * — Aristotle, Metaphysics
 *
 * Dynamis (potential) and energeia (actuality) are Aristotle's
 * fundamental categories. Every agent and team member has potential
 * capacity (dynamis) and actual utilization (energeia). The gap
 * between them is the growth opportunity.
 */

import type { DynamisProfile, DynamisInput, CapacityState, GrowthTrajectory } from './types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Utilization thresholds for capacity state classification. */
const THRESHOLDS: Record<CapacityState, [number, number]> = {
  overloaded: [0.9, Infinity],
  stretched: [0.75, 0.9],
  balanced: [0.4, 0.75],
  underutilized: [0.15, 0.4],
  idle: [0, 0.15],
};

/** Default capacity for agents (tasks per week). */
const DEFAULT_AGENT_CAPACITY = 20;

// ============================================================================
// DYNAMIS COMPUTATION
// ============================================================================

/**
 * Compute capacity profiles for all agents and team members.
 *
 * Pure function, no DB access. Takes pre-fetched data.
 */
export function computeDynamis(input: DynamisInput): DynamisProfile[] {
  const profiles: DynamisProfile[] = [];

  // Agent profiles
  for (const agent of input.agents) {
    const capacity = DEFAULT_AGENT_CAPACITY;
    const utilization = capacity > 0 ? agent.recentTaskCount / capacity : 0;
    const state = classifyCapacity(utilization);
    const trajectory = computeTrajectory(agent.recentTaskCount, agent.previousTaskCount);

    profiles.push({
      entityId: agent.id,
      entityName: agent.name,
      entityType: 'agent',
      skills: agent.skills,
      capacity: 1, // normalized
      currentUtilization: Math.min(1, utilization),
      state,
      potentialGap: Math.max(0, 1 - utilization),
      growthTrajectory: trajectory,
    });
  }

  // Human team member profiles
  for (const member of input.teamMembers) {
    const capacity = member.capacity || 1;
    const utilization = capacity > 0 ? member.recentTaskCount / (capacity * 7) : 0; // tasks per capacity-day
    const state = classifyCapacity(Math.min(1, utilization));

    profiles.push({
      entityId: member.id,
      entityName: member.name,
      entityType: 'human',
      skills: member.skills,
      capacity,
      currentUtilization: Math.min(1, utilization),
      state,
      potentialGap: Math.max(0, 1 - utilization),
      growthTrajectory: 'stable', // humans need more data for trajectory
    });
  }

  return profiles;
}

/**
 * Get a summary of workspace capacity.
 */
export function summarizeCapacity(profiles: DynamisProfile[]): {
  totalEntities: number;
  overloaded: number;
  balanced: number;
  idle: number;
  avgUtilization: number;
} {
  const totalEntities = profiles.length;
  const overloaded = profiles.filter(p => p.state === 'overloaded' || p.state === 'stretched').length;
  const balanced = profiles.filter(p => p.state === 'balanced').length;
  const idle = profiles.filter(p => p.state === 'idle' || p.state === 'underutilized').length;
  const avgUtilization = totalEntities > 0
    ? profiles.reduce((sum, p) => sum + p.currentUtilization, 0) / totalEntities
    : 0;

  return { totalEntities, overloaded, balanced, idle, avgUtilization };
}

// ============================================================================
// INTERNAL
// ============================================================================

function classifyCapacity(utilization: number): CapacityState {
  for (const [state, [min, max]] of Object.entries(THRESHOLDS) as [CapacityState, [number, number]][]) {
    if (utilization >= min && utilization < max) return state;
  }
  return 'balanced';
}

function computeTrajectory(recent: number, previous: number): GrowthTrajectory {
  if (previous === 0) return recent > 0 ? 'improving' : 'stable';
  const change = (recent - previous) / previous;
  if (change > 0.2) return 'improving';
  if (change < -0.2) return 'declining';
  return 'stable';
}
