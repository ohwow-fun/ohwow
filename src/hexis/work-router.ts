/**
 * Work Router — Local Runtime
 *
 * Intelligent task routing: scores candidates (people + agents) against 7
 * routing factors and recommends or auto-assigns the best match.
 *
 * Also manages pre/co/post work augmentation for human-assigned tasks
 * and energy-aware smart notifications.
 *
 * Phase 3 of Center of Operations.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Urgency = 'low' | 'normal' | 'high' | 'critical';
export type AssigneeType = 'person' | 'agent';
export type AssignmentMethod = 'auto' | 'recommended' | 'manual' | 'fallback';
export type AugmentationPhase = 'pre' | 'co' | 'post';

export interface RoutingRequest {
  taskTitle: string;
  taskId?: string;
  urgency?: Urgency;
  requiredSkills?: string[];
  estimatedEffortMinutes?: number;
  preferredAssigneeId?: string;
  departmentId?: string;
}

export interface RoutingCandidate {
  id: string;
  type: AssigneeType;
  name: string;
  scores: RoutingScores;
  totalScore: number;
}

export interface RoutingScores {
  skill: number;
  capacity: number;
  energy: number;
  growth: number;
  transition: number;
  cost: number;
  balance: number;
}

export interface RoutingDecision {
  decisionId: string;
  assignee: RoutingCandidate;
  runnerUp: RoutingCandidate | null;
  method: AssignmentMethod;
  confidence: number;
}

export interface WorkloadSummary {
  id: string;
  name: string;
  type: AssigneeType;
  activeTasks: number;
  completedThisWeek: number;
  avgQualityScore: number;
  routingDecisions: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Weights for each routing factor (sum = 1.0) */
const ROUTING_WEIGHTS: Record<keyof RoutingScores, number> = {
  skill: 0.25,
  capacity: 0.20,
  energy: 0.10,
  growth: 0.10,
  transition: 0.15,
  cost: 0.10,
  balance: 0.10,
};

/** Confidence threshold for auto-assignment */
const AUTO_ASSIGN_THRESHOLD = 0.75;

/** Hours threshold to consider a person at capacity */
const CAPACITY_HOURS_THRESHOLD = 40;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson<T>(raw: unknown, fallback: T): T {
  if (!raw) return fallback;
  if (typeof raw === 'string') { try { return JSON.parse(raw) as T; } catch { return fallback; } }
  return raw as T;
}

function currentHour(): number {
  return new Date().getHours();
}

function isWithinWindow(hour: number, start: string | null, end: string | null): boolean {
  if (!start || !end) return false;
  const [sh] = start.split(':').map(Number);
  const [eh] = end.split(':').map(Number);
  if (sh <= eh) return hour >= sh && hour < eh;
  return hour >= sh || hour < eh;
}

// ---------------------------------------------------------------------------
// Work Router
// ---------------------------------------------------------------------------

export class LocalWorkRouter {
  constructor(private db: DatabaseAdapter, private workspaceId: string) {}

  // -----------------------------------------------------------------------
  // Core: route a task
  // -----------------------------------------------------------------------

  async routeTask(request: RoutingRequest): Promise<RoutingDecision> {
    const candidates = await this.scoreCandidates(request);

    if (candidates.length === 0) {
      // Fallback: create decision with no assignment
      const decisionId = crypto.randomUUID();
      const now = new Date().toISOString();
      await this.db.from('work_routing_decisions').insert({
        id: decisionId,
        workspace_id: this.workspaceId,
        task_id: request.taskId || null,
        task_title: request.taskTitle,
        task_urgency: request.urgency || 'normal',
        required_skills: JSON.stringify(request.requiredSkills || []),
        estimated_effort_minutes: request.estimatedEffortMinutes || null,
        assigned_to_type: 'agent',
        assigned_to_id: 'unassigned',
        assignment_method: 'fallback',
        confidence_score: 0,
        score_breakdown: '{}',
        created_at: now,
        updated_at: now,
      });
      logger.warn({ taskTitle: request.taskTitle }, 'Work Router: no candidates found');
      return {
        decisionId,
        assignee: { id: 'unassigned', type: 'agent', name: 'Unassigned', scores: { skill: 0, capacity: 0, energy: 0, growth: 0, transition: 0, cost: 0, balance: 0 }, totalScore: 0 },
        runnerUp: null,
        method: 'fallback',
        confidence: 0,
      };
    }

    const best = candidates[0];
    const runnerUp = candidates.length > 1 ? candidates[1] : null;
    const method: AssignmentMethod = best.totalScore >= AUTO_ASSIGN_THRESHOLD ? 'auto' : 'recommended';

    const decisionId = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db.from('work_routing_decisions').insert({
      id: decisionId,
      workspace_id: this.workspaceId,
      task_id: request.taskId || null,
      task_title: request.taskTitle,
      task_urgency: request.urgency || 'normal',
      required_skills: JSON.stringify(request.requiredSkills || []),
      estimated_effort_minutes: request.estimatedEffortMinutes || null,
      assigned_to_type: best.type,
      assigned_to_id: best.id,
      assignment_method: method,
      confidence_score: best.totalScore,
      score_breakdown: JSON.stringify(best.scores),
      runner_up_id: runnerUp?.id || null,
      runner_up_type: runnerUp?.type || null,
      runner_up_score: runnerUp?.totalScore || null,
      created_at: now,
      updated_at: now,
    });

    logger.info({
      decisionId, assignee: best.name, type: best.type,
      score: best.totalScore, method,
    }, 'Work Router: task routed');

    return { decisionId, assignee: best, runnerUp, method, confidence: best.totalScore };
  }

  // -----------------------------------------------------------------------
  // Scoring
  // -----------------------------------------------------------------------

  private async scoreCandidates(request: RoutingRequest): Promise<RoutingCandidate[]> {
    const people = await this.loadPeople();
    const agents = await this.loadAgents(request.departmentId);
    const recentDecisions = await this.loadRecentDecisions();

    const candidates: RoutingCandidate[] = [];

    for (const person of people) {
      const scores = this.scorePersonCandidate(person, request, recentDecisions);
      const totalScore = this.weightedTotal(scores);
      candidates.push({ id: person.id, type: 'person', name: person.name, scores, totalScore });
    }

    for (const agent of agents) {
      const scores = this.scoreAgentCandidate(agent, request, recentDecisions);
      const totalScore = this.weightedTotal(scores);
      candidates.push({ id: agent.id, type: 'agent', name: agent.name, scores, totalScore });
    }

    // Preferred assignee gets a small boost
    if (request.preferredAssigneeId) {
      const pref = candidates.find((c) => c.id === request.preferredAssigneeId);
      if (pref) pref.totalScore = Math.min(1, pref.totalScore + 0.05);
    }

    candidates.sort((a, b) => b.totalScore - a.totalScore);
    return candidates;
  }

  private scorePersonCandidate(
    person: PersonRecord,
    request: RoutingRequest,
    recentDecisions: DecisionRecord[],
  ): RoutingScores {
    const requiredSkills = request.requiredSkills || [];
    const personSkills = parseJson<Record<string, number>>(person.skills_map, {});
    const energyPatterns = parseJson<Record<string, unknown>>(person.energy_patterns, {});

    // Skill match
    let skill = 0;
    if (requiredSkills.length > 0) {
      const matches = requiredSkills.filter((s) => (personSkills[s] || 0) >= 0.3).length;
      skill = matches / requiredSkills.length;
    } else {
      skill = 0.5; // neutral when no skills specified
    }

    // Capacity: how busy are they?
    const personDecisions = recentDecisions.filter((d) => d.assigned_to_id === person.id && !d.outcome);
    const activeTasks = personDecisions.length;
    const capacity = Math.max(0, 1 - activeTasks / 10); // linear drop

    // Energy alignment
    const hour = currentHour();
    const deepWorkStart = energyPatterns.deep_work_start as string | undefined;
    const deepWorkEnd = energyPatterns.deep_work_end as string | undefined;
    const effortHigh = (request.estimatedEffortMinutes || 30) > 60;
    const inDeepWork = isWithinWindow(hour, deepWorkStart || null, deepWorkEnd || null);
    const energy = effortHigh ? (inDeepWork ? 1.0 : 0.4) : (inDeepWork ? 0.5 : 0.8);

    // Growth value: does this build skills they want?
    const skillGaps = parseJson<string[]>(person.skill_gaps_to_close, []);
    const growth = requiredSkills.some((s) => skillGaps.includes(s)) ? 0.9 : 0.3;

    // Transition stage: is an agent already handling this for them?
    const transition = 0.5; // neutral by default (will check in next iteration)

    // Cost: humans are expensive
    const cost = 0.3;

    // Team balance: distribute work evenly
    const totalDecisions = recentDecisions.filter((d) => d.assigned_to_type === 'person').length;
    const myShare = totalDecisions > 0 ? personDecisions.length / totalDecisions : 0;
    const balance = Math.max(0, 1 - myShare * 2);

    return { skill, capacity, energy, growth, transition, cost, balance };
  }

  private scoreAgentCandidate(
    agent: AgentRecord,
    request: RoutingRequest,
    recentDecisions: DecisionRecord[],
  ): RoutingScores {
    const requiredSkills = request.requiredSkills || [];
    const agentTools = parseJson<string[]>(agent.tool_ids, []);

    // Skill match: check agent role + tools overlap
    let skill = 0;
    if (requiredSkills.length > 0) {
      const agentRole = (agent.role || '').toLowerCase();
      const matches = requiredSkills.filter(
        (s) => agentRole.includes(s.toLowerCase()) || agentTools.some((t) => t.toLowerCase().includes(s.toLowerCase())),
      ).length;
      skill = matches / requiredSkills.length;
    } else {
      skill = 0.5;
    }

    // Capacity: agents have near-unlimited capacity (unless queue is backed up)
    const agentDecisions = recentDecisions.filter((d) => d.assigned_to_id === agent.id && !d.outcome);
    const capacity = Math.max(0, 1 - agentDecisions.length / 20);

    // Energy: agents don't have energy patterns
    const energy = 0.7;

    // Growth: no growth value for agents
    const growth = 0;

    // Transition stage: higher stages mean the agent is more trusted
    const transition = 0.7; // default trust level

    // Cost: agents are cheap
    const cost = 0.9;

    // Balance: distribute across agents
    const totalAgentDecisions = recentDecisions.filter((d) => d.assigned_to_type === 'agent').length;
    const myShare = totalAgentDecisions > 0 ? agentDecisions.length / totalAgentDecisions : 0;
    const balance = Math.max(0, 1 - myShare * 2);

    return { skill, capacity, energy, growth, transition, cost, balance };
  }

  private weightedTotal(scores: RoutingScores): number {
    let total = 0;
    for (const [key, weight] of Object.entries(ROUTING_WEIGHTS)) {
      total += (scores[key as keyof RoutingScores] || 0) * weight;
    }
    return Math.round(total * 1000) / 1000;
  }

  // -----------------------------------------------------------------------
  // Work Augmentation
  // -----------------------------------------------------------------------

  async createAugmentation(
    routingDecisionId: string,
    phase: AugmentationPhase,
    augmentationType: string,
    description: string,
    agentId?: string,
  ): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db.from('work_augmentations').insert({
      id,
      workspace_id: this.workspaceId,
      routing_decision_id: routingDecisionId,
      phase,
      status: 'pending',
      augmentation_type: augmentationType,
      description,
      agent_id: agentId || null,
      created_at: now,
    });

    return id;
  }

  async completeAugmentation(id: string, output: Record<string, unknown>, wasUseful?: boolean): Promise<void> {
    await this.db.from('work_augmentations').update({
      status: 'completed',
      output: JSON.stringify(output),
      was_useful: wasUseful != null ? (wasUseful ? 1 : 0) : null,
      completed_at: new Date().toISOString(),
    }).eq('id', id);
  }

  async getAugmentationsForDecision(routingDecisionId: string): Promise<Array<Record<string, unknown>>> {
    const { data } = await this.db
      .from('work_augmentations')
      .select('*')
      .eq('routing_decision_id', routingDecisionId)
      .order('created_at', { ascending: true });
    return (data || []) as Array<Record<string, unknown>>;
  }

  // -----------------------------------------------------------------------
  // Smart Notifications
  // -----------------------------------------------------------------------

  async shouldNotifyNow(personModelId: string, urgency: Urgency): Promise<{
    shouldNotify: boolean;
    channel: string;
    reason?: string;
  }> {
    const { data: prefs } = await this.db
      .from('notification_preferences')
      .select('*')
      .eq('person_model_id', personModelId)
      .single();

    if (!prefs) {
      return { shouldNotify: true, channel: 'in_app' };
    }

    const hour = currentHour();
    const urgencyOrder: Record<Urgency, number> = { low: 0, normal: 1, high: 2, critical: 3 };
    const minUrgency = (prefs.min_urgency_for_interrupt as string) || 'high';
    const channel = (prefs.preferred_channel as string) || 'in_app';

    // Deep work window: buffer non-critical
    if (prefs.buffer_during_deep_work) {
      const inDeepWork = isWithinWindow(hour, prefs.deep_work_start as string, prefs.deep_work_end as string);
      if (inDeepWork && urgencyOrder[urgency] < urgencyOrder[minUrgency as Urgency]) {
        return { shouldNotify: false, channel, reason: 'Deep work window active. Buffered.' };
      }
    }

    // Low energy period: suppress complex decisions
    if (prefs.suppress_complex_during_low_energy) {
      const inLowEnergy = isWithinWindow(hour, prefs.low_energy_start as string, prefs.low_energy_end as string);
      if (inLowEnergy && urgency === 'low') {
        return { shouldNotify: false, channel, reason: 'Low energy period. Deferred.' };
      }
    }

    return { shouldNotify: true, channel };
  }

  // -----------------------------------------------------------------------
  // Workload Balance
  // -----------------------------------------------------------------------

  async getWorkloadBalance(): Promise<WorkloadSummary[]> {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString();

    const { data: decisions } = await this.db
      .from('work_routing_decisions')
      .select('*')
      .eq('workspace_id', this.workspaceId)
      .gte('created_at', weekAgoStr);

    if (!decisions || decisions.length === 0) return [];

    const summaryMap = new Map<string, WorkloadSummary>();

    for (const d of decisions) {
      const key = `${d.assigned_to_type}:${d.assigned_to_id}`;
      const existing = summaryMap.get(key) || {
        id: d.assigned_to_id as string,
        name: '', // will be filled
        type: d.assigned_to_type as AssigneeType,
        activeTasks: 0,
        completedThisWeek: 0,
        avgQualityScore: 0,
        routingDecisions: 0,
      };

      existing.routingDecisions++;
      if (!d.outcome) existing.activeTasks++;
      if (d.outcome === 'completed') {
        existing.completedThisWeek++;
        if (d.outcome_quality_score) {
          existing.avgQualityScore = (existing.avgQualityScore * (existing.completedThisWeek - 1) + (d.outcome_quality_score as number)) / existing.completedThisWeek;
        }
      }

      summaryMap.set(key, existing);
    }

    // Fill names
    for (const [key, summary] of summaryMap) {
      if (summary.type === 'person') {
        const { data: person } = await this.db.from('agent_workforce_person_models').select('name').eq('id', summary.id).single();
        summary.name = (person?.name as string) || summary.id;
      } else {
        const { data: agent } = await this.db.from('agent_workforce_agents').select('name').eq('id', summary.id).single();
        summary.name = (agent?.name as string) || summary.id;
      }
    }

    return Array.from(summaryMap.values()).sort((a, b) => b.activeTasks - a.activeTasks);
  }

  // -----------------------------------------------------------------------
  // Outcome Recording
  // -----------------------------------------------------------------------

  async recordOutcome(
    decisionId: string,
    outcome: 'completed' | 'reassigned' | 'rejected' | 'timed_out',
    qualityScore?: number,
    actualEffortMinutes?: number,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.from('work_routing_decisions').update({
      outcome,
      outcome_quality_score: qualityScore ?? null,
      actual_effort_minutes: actualEffortMinutes ?? null,
      completed_at: now,
      updated_at: now,
    }).eq('id', decisionId);

    logger.info({ decisionId, outcome, qualityScore }, 'Work Router: outcome recorded');
  }

  // -----------------------------------------------------------------------
  // Data Loading
  // -----------------------------------------------------------------------

  private async loadPeople(): Promise<PersonRecord[]> {
    const { data } = await this.db
      .from('agent_workforce_person_models')
      .select('id, name, skills_map, domain_expertise, energy_patterns, skill_gaps_to_close, growth_direction')
      .eq('workspace_id', this.workspaceId)
      .eq('ingestion_status', 'initial_complete');

    return (data || []) as unknown as PersonRecord[];
  }

  private async loadAgents(departmentId?: string): Promise<AgentRecord[]> {
    let query = this.db
      .from('agent_workforce_agents')
      .select('id, name, role, tool_ids, status')
      .eq('workspace_id', this.workspaceId)
      .in('status', ['active', 'idle']);

    if (departmentId) {
      query = query.eq('department_id', departmentId);
    }

    const { data } = await query;
    return (data || []) as unknown as AgentRecord[];
  }

  private async loadRecentDecisions(): Promise<DecisionRecord[]> {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const { data } = await this.db
      .from('work_routing_decisions')
      .select('assigned_to_id, assigned_to_type, outcome')
      .eq('workspace_id', this.workspaceId)
      .gte('created_at', weekAgo.toISOString());

    return (data || []) as unknown as DecisionRecord[];
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PersonRecord {
  id: string;
  name: string;
  skills_map: unknown;
  domain_expertise: unknown;
  energy_patterns: unknown;
  skill_gaps_to_close: unknown;
  growth_direction: string;
}

interface AgentRecord {
  id: string;
  name: string;
  role: string;
  tool_ids: unknown;
  status: string;
}

interface DecisionRecord {
  assigned_to_id: string;
  assigned_to_type: string;
  outcome: string | null;
}
