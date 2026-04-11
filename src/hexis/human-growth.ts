/**
 * Human Growth Engine — Local Runtime
 *
 * Computes growth snapshots for humans using the same 4D model as agents
 * (competence, autonomy, specialization, relationship health). Detects
 * growth signals (plateau, burnout, transformation), monitors team health,
 * tracks role evolution, and manages delegation patterns.
 *
 * Phase 4 of Center of Operations.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { GrowthSnapshot, GrowthArc, GrowthDirection } from '../soul/types.js';
import { computeGrowthSnapshot, computeGrowthArc } from '../soul/growth-arc.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GrowthSignalType = 'burnout_risk' | 'plateau' | 'breakthrough' | 'transformation' | 'motivation_drift';
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface GrowthSignal {
  type: GrowthSignalType;
  severity: AlertSeverity;
  personModelId: string;
  personName: string;
  message: string;
  suggestion: string;
}

export interface TeamHealthReport {
  workspaceId: string;
  totalPeople: number;
  ascending: number;
  plateau: number;
  declining: number;
  alerts: GrowthSignal[];
  computedAt: string;
}

export interface RoleEvolutionInsight {
  personModelId: string;
  personName: string;
  currentRole: string;
  actualDomain: string;
  actualDomainShare: number;
  insight: string;
}

export interface DelegationMetrics {
  totalDecisions: number;
  delegatedCount: number;
  delegationRate: number;
  successfulDelegations: number;
  revertedDelegations: number;
  pendingDelegations: number;
  trendDirection: 'increasing' | 'stable' | 'decreasing';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson<T>(raw: unknown, fallback: T): T {
  if (!raw) return fallback;
  if (typeof raw === 'string') { try { return JSON.parse(raw) as T; } catch { return fallback; } }
  return raw as T;
}

// ---------------------------------------------------------------------------
// Human Growth Engine
// ---------------------------------------------------------------------------

export class HumanGrowthEngine {
  constructor(private db: DatabaseAdapter, private workspaceId: string) {}

  // -----------------------------------------------------------------------
  // 4a. Growth Snapshot Computation
  // -----------------------------------------------------------------------

  async computeAndStoreSnapshot(personModelId: string): Promise<GrowthSnapshot | null> {
    const { data: person } = await this.db
      .from('agent_workforce_person_models')
      .select('id, name, skills_map, domain_expertise, growth_snapshots, growth_arc, growth_velocity, growth_direction')
      .eq('id', personModelId)
      .single();

    if (!person) return null;

    // Gather signals from routing decisions (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: routingDecisions } = await this.db
      .from('work_routing_decisions')
      .select('outcome, outcome_quality_score, assigned_to_type, assignment_method')
      .eq('assigned_to_id', personModelId)
      .eq('assigned_to_type', 'person')
      .gte('created_at', thirtyDaysAgo.toISOString());

    const decisions = routingDecisions || [];

    // Gather augmentation data
    const { data: augmentations } = await this.db
      .from('work_augmentations')
      .select('was_useful, phase')
      .eq('person_model_id', personModelId)
      .gte('created_at', thirtyDaysAgo.toISOString());

    const augs = augmentations || [];

    // Gather observations
    const { data: observations } = await this.db
      .from('agent_workforce_person_observations')
      .select('observation_type, dimension, confidence')
      .eq('person_model_id', personModelId)
      .gte('created_at', thirtyDaysAgo.toISOString());

    const obs = observations || [];

    // --- Compute 4 dimensions ---

    // Competence: quality scores + completion rate
    const completedDecisions = decisions.filter((d) => d.outcome === 'completed');
    const qualityScores = completedDecisions
      .map((d) => d.outcome_quality_score as number)
      .filter((s) => s != null && s > 0);
    const avgQuality = qualityScores.length > 0
      ? qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length
      : 0.5;
    const completionRate = decisions.length > 0
      ? completedDecisions.length / decisions.length
      : 0.5;
    const competence = 0.6 * avgQuality + 0.4 * completionRate;

    // Autonomy: inverse of augmentation dependency
    const usefulAugs = augs.filter((a) => a.was_useful === 1);
    const augDependency = augs.length > 0 ? usefulAugs.length / augs.length : 0;
    const autoAssigned = decisions.filter((d) => d.assignment_method === 'auto').length;
    const autoRate = decisions.length > 0 ? autoAssigned / decisions.length : 0;
    const autonomy = 0.5 * (1 - augDependency * 0.5) + 0.5 * Math.min(1, autoRate + 0.3);

    // Specialization: Herfindahl index of domain expertise
    const expertise = parseJson<Record<string, number>>(person.domain_expertise, {});
    const expertiseValues = Object.values(expertise).filter((v) => v > 0);
    let specialization = 0.3; // default
    if (expertiseValues.length > 0) {
      const total = expertiseValues.reduce((a, b) => a + b, 0);
      const shares = expertiseValues.map((v) => v / total);
      const hhi = shares.reduce((a, s) => a + s * s, 0);
      specialization = Math.min(1, hhi * 2); // scale HHI (max 1.0 for single domain)
    }

    // Relationship health: peer observations + collaboration signals
    const peerObs = obs.filter((o) => o.observation_type === 'peer_observation' || o.observation_type === 'feedback');
    const peerConfidence = peerObs.length > 0
      ? peerObs.reduce((a, o) => a + (o.confidence as number || 0.5), 0) / peerObs.length
      : 0.5;
    const relationshipHealth = peerConfidence;

    const snapshot = computeGrowthSnapshot({
      competence, autonomy, specialization, relationshipHealth,
    });

    // Append to snapshots and recompute arc
    const existingSnapshots = parseJson<GrowthSnapshot[]>(person.growth_snapshots, []);
    const allSnapshots = [...existingSnapshots.slice(-19), snapshot]; // keep last 20
    const arc = computeGrowthArc(allSnapshots);

    // Store
    await this.db.from('agent_workforce_person_models').update({
      growth_snapshots: JSON.stringify(allSnapshots),
      growth_arc: JSON.stringify(arc),
      growth_velocity: Math.round(arc.velocity * 1000) / 1000,
      growth_direction: arc.direction,
      updated_at: new Date().toISOString(),
    }).eq('id', personModelId);

    logger.info({
      personModelId,
      direction: arc.direction,
      velocity: arc.velocity,
      competence: Math.round(competence * 100),
      autonomy: Math.round(autonomy * 100),
    }, 'Human growth snapshot computed');

    return snapshot;
  }

  // -----------------------------------------------------------------------
  // Growth Signal Detection
  // -----------------------------------------------------------------------

  async detectGrowthSignals(personModelId: string): Promise<GrowthSignal[]> {
    const { data: person } = await this.db
      .from('agent_workforce_person_models')
      .select('id, name, growth_direction, growth_velocity, growth_snapshots, skill_gaps_to_close')
      .eq('id', personModelId)
      .single();

    if (!person) return [];

    const signals: GrowthSignal[] = [];
    const name = person.name as string;
    const direction = person.growth_direction as GrowthDirection;
    const velocity = (person.growth_velocity as number) || 0;
    const snapshots = parseJson<GrowthSnapshot[]>(person.growth_snapshots, []);

    // Burnout risk: declining + low velocity persisting
    if (direction === 'declining') {
      signals.push({
        type: 'burnout_risk',
        severity: velocity > 0.1 ? 'critical' : 'warning',
        personModelId,
        personName: name,
        message: `${name}'s growth is declining. Competence or output quality has dropped.`,
        suggestion: 'Consider reducing workload, reassigning complex tasks, or checking in directly.',
      });
    }

    // Plateau: stagnation for multiple snapshots
    if (direction === 'plateau' && snapshots.length >= 4) {
      const recentVelocities = snapshots.slice(-4).map((s, i, arr) => {
        if (i === 0) return 0;
        const prev = arr[i - 1];
        return Math.abs(((s.competence + s.autonomy) / 2) - ((prev.competence + prev.autonomy) / 2));
      });
      const avgVelocity = recentVelocities.reduce((a, b) => a + b, 0) / recentVelocities.length;
      if (avgVelocity < 0.02) {
        signals.push({
          type: 'plateau',
          severity: 'info',
          personModelId,
          personName: name,
          message: `${name} has plateaued. Growth has stalled across multiple dimensions.`,
          suggestion: 'Assign a stretch task in their skill gap area, or suggest a new skill path.',
        });
      }
    }

    // Motivation drift: skill gaps don't match actual work
    const skillGaps = parseJson<string[]>(person.skill_gaps_to_close, []);
    if (skillGaps.length > 0) {
      const { data: recentDecisions } = await this.db
        .from('work_routing_decisions')
        .select('required_skills')
        .eq('assigned_to_id', personModelId)
        .eq('assigned_to_type', 'person')
        .eq('outcome', 'completed')
        .limit(20);

      if (recentDecisions && recentDecisions.length >= 5) {
        const actualSkills = new Set<string>();
        for (const d of recentDecisions) {
          const skills = parseJson<string[]>(d.required_skills, []);
          skills.forEach((s) => actualSkills.add(s));
        }
        const gapOverlap = skillGaps.filter((g) => actualSkills.has(g));
        if (gapOverlap.length === 0) {
          signals.push({
            type: 'motivation_drift',
            severity: 'warning',
            personModelId,
            personName: name,
            message: `${name} wants to grow in ${skillGaps.slice(0, 3).join(', ')} but their recent work doesn't involve those skills.`,
            suggestion: 'Route some tasks in their target skill areas, even if another assignee scores slightly higher.',
          });
        }
      }
    }

    return signals;
  }

  // -----------------------------------------------------------------------
  // 4c. Role Evolution Detection
  // -----------------------------------------------------------------------

  async detectRoleEvolution(personModelId: string): Promise<RoleEvolutionInsight | null> {
    const { data: person } = await this.db
      .from('agent_workforce_person_models')
      .select('id, name, role_title')
      .eq('id', personModelId)
      .single();

    if (!person || !person.role_title) return null;

    // Get completed routing decisions with skills
    const { data: decisions } = await this.db
      .from('work_routing_decisions')
      .select('required_skills')
      .eq('assigned_to_id', personModelId)
      .eq('assigned_to_type', 'person')
      .eq('outcome', 'completed')
      .limit(50);

    if (!decisions || decisions.length < 10) return null;

    // Count skill domains
    const domainCounts: Record<string, number> = {};
    for (const d of decisions) {
      const skills = parseJson<string[]>(d.required_skills, []);
      for (const skill of skills) {
        const domain = skill.toLowerCase();
        domainCounts[domain] = (domainCounts[domain] || 0) + 1;
      }
    }

    if (Object.keys(domainCounts).length === 0) return null;

    // Find dominant domain
    const sorted = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]);
    const totalTasks = decisions.length;
    const [topDomain, topCount] = sorted[0];
    const topShare = topCount / totalTasks;

    const roleTitle = (person.role_title as string).toLowerCase();

    // If dominant work domain doesn't match role title
    if (topShare >= 0.4 && !roleTitle.includes(topDomain)) {
      return {
        personModelId,
        personName: person.name as string,
        currentRole: person.role_title as string,
        actualDomain: topDomain,
        actualDomainShare: Math.round(topShare * 100),
        insight: `${person.name}'s highest-impact work is ${topDomain} (${Math.round(topShare * 100)}% of tasks), but their role is "${person.role_title}." They may be operating beyond their title.`,
      };
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // 4d. Team Health Monitoring
  // -----------------------------------------------------------------------

  async assessTeamHealth(): Promise<TeamHealthReport> {
    const { data: people } = await this.db
      .from('agent_workforce_person_models')
      .select('id, name, growth_direction, growth_velocity, growth_snapshots, skill_gaps_to_close')
      .eq('workspace_id', this.workspaceId)
      .in('ingestion_status', ['initial_complete', 'mature']);

    const persons = people || [];
    const alerts: GrowthSignal[] = [];

    let ascending = 0;
    let plateau = 0;
    let declining = 0;

    for (const person of persons) {
      const direction = person.growth_direction as GrowthDirection;
      if (direction === 'ascending') ascending++;
      else if (direction === 'declining') declining++;
      else plateau++;

      const personSignals = await this.detectGrowthSignals(person.id as string);
      alerts.push(...personSignals);
    }

    return {
      workspaceId: this.workspaceId,
      totalPeople: persons.length,
      ascending,
      plateau,
      declining,
      alerts: alerts.sort((a, b) => {
        const order: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
        return order[a.severity] - order[b.severity];
      }),
      computedAt: new Date().toISOString(),
    };
  }

  // -----------------------------------------------------------------------
  // 4e. Delegation Tracking
  // -----------------------------------------------------------------------

  async trackDelegation(
    personModelId: string,
    decisionType: string,
    description: string,
    delegatedToType?: 'agent' | 'person',
    delegatedToId?: string,
    routingDecisionId?: string,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.from('delegation_decisions').insert({
      id,
      workspace_id: this.workspaceId,
      person_model_id: personModelId,
      decision_type: decisionType,
      description,
      delegated_to_type: delegatedToType || null,
      delegated_to_id: delegatedToId || null,
      routing_decision_id: routingDecisionId || null,
      outcome: 'pending',
      founder_review_needed: delegatedToType ? 0 : 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return id;
  }

  async getDelegationMetrics(personModelId: string): Promise<DelegationMetrics> {
    const { data: decisions } = await this.db
      .from('delegation_decisions')
      .select('outcome, delegated_to_type, created_at')
      .eq('person_model_id', personModelId);

    const all = decisions || [];
    const delegated = all.filter((d) => d.delegated_to_type);
    const successful = delegated.filter((d) => d.outcome === 'successful');
    const reverted = delegated.filter((d) => d.outcome === 'reverted');
    const pending = delegated.filter((d) => d.outcome === 'pending');

    // Trend: compare first half vs second half delegation rates
    let trendDirection: 'increasing' | 'stable' | 'decreasing' = 'stable';
    if (all.length >= 10) {
      const mid = Math.floor(all.length / 2);
      const firstHalf = all.slice(0, mid);
      const secondHalf = all.slice(mid);
      const firstRate = firstHalf.filter((d) => d.delegated_to_type).length / firstHalf.length;
      const secondRate = secondHalf.filter((d) => d.delegated_to_type).length / secondHalf.length;
      if (secondRate - firstRate > 0.1) trendDirection = 'increasing';
      else if (firstRate - secondRate > 0.1) trendDirection = 'decreasing';
    }

    return {
      totalDecisions: all.length,
      delegatedCount: delegated.length,
      delegationRate: all.length > 0 ? delegated.length / all.length : 0,
      successfulDelegations: successful.length,
      revertedDelegations: reverted.length,
      pendingDelegations: pending.length,
      trendDirection,
    };
  }

  async suggestDelegationOpportunities(personModelId: string): Promise<string[]> {
    // Find routing decisions where this person is assigned but an agent scored close
    const { data: decisions } = await this.db
      .from('work_routing_decisions')
      .select('task_title, runner_up_type, runner_up_score, confidence_score')
      .eq('assigned_to_id', personModelId)
      .eq('assigned_to_type', 'person')
      .eq('outcome', 'completed');

    if (!decisions) return [];

    const suggestions: string[] = [];
    for (const d of decisions) {
      if (d.runner_up_type === 'agent' && d.runner_up_score) {
        const scoreDiff = (d.confidence_score as number) - (d.runner_up_score as number);
        if (scoreDiff < 0.15) {
          suggestions.push(d.task_title as string);
        }
      }
    }

    return suggestions.slice(0, 5);
  }
}
