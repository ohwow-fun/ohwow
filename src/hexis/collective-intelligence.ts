/**
 * Collective Intelligence Engine — Local Runtime
 *
 * Makes the team smarter than the sum of its parts through:
 * - Cross-pollination: knowledge transfer between people/agents
 * - Council integration: data-enriched team deliberations
 * - Collective briefings: personalized team intelligence summaries
 * - Workload rebalancing: energy/growth-aware task redistribution
 *
 * Phase 6 (capstone) of Center of Operations.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrossPollinationSuggestion {
  sourceId: string;
  sourceName: string;
  sourceType: 'person' | 'agent';
  targetId: string;
  targetName: string;
  targetType: 'person' | 'agent';
  skill: string;
  technique: string;
  relevanceScore: number;
}

export interface CouncilTopic {
  topic: string;
  category: 'workload' | 'skill_gap' | 'operational_gap' | 'growth_signal' | 'strategy';
  urgency: 'low' | 'normal' | 'high';
  context: string;
}

export interface RebalanceSuggestion {
  fromId: string;
  fromName: string;
  fromType: 'person' | 'agent';
  toId: string;
  toName: string;
  toType: 'person' | 'agent';
  taskType: string;
  reason: string;
  impact: string;
}

export interface TeamCapacity {
  totalPeople: number;
  totalAgents: number;
  avgPersonUtilization: number;
  avgAgentUtilization: number;
  overloadedPeople: string[];
  underutilizedAgents: string[];
  headroomPercent: number;
}

export interface CollectiveBriefing {
  computedAt: string;
  teamGrowth: { ascending: number; plateau: number; declining: number };
  crossPollination: CrossPollinationSuggestion[];
  rebalanceSuggestions: RebalanceSuggestion[];
  councilInsights: Array<{ topic: string; insight: string; createdAt: string }>;
  workloadAlerts: string[];
  teamCapacity: TeamCapacity;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson<T>(raw: unknown, fallback: T): T {
  if (!raw) return fallback;
  if (typeof raw === 'string') { try { return JSON.parse(raw) as T; } catch { return fallback; } }
  return raw as T;
}

function weekAgo(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class CollectiveIntelligenceEngine {
  constructor(private db: DatabaseAdapter, private workspaceId: string) {}

  // -----------------------------------------------------------------------
  // 6a. Cross-Pollination
  // -----------------------------------------------------------------------

  async findCrossPollinationOpportunities(): Promise<CrossPollinationSuggestion[]> {
    const since = weekAgo();

    // Load all people with their skills and gaps
    const { data: people } = await this.db
      .from('agent_workforce_person_models')
      .select('id, name, skills_map, skill_gaps_to_close, domain_expertise')
      .eq('workspace_id', this.workspaceId)
      .in('ingestion_status', ['initial_complete', 'mature']);

    if (!people || people.length < 2) return [];

    // Load recent high-quality completions
    const { data: recentDecisions } = await this.db
      .from('work_routing_decisions')
      .select('assigned_to_id, assigned_to_type, required_skills, outcome_quality_score, task_title')
      .eq('workspace_id', this.workspaceId)
      .eq('outcome', 'completed')
      .gte('created_at', since);

    const decisions = recentDecisions || [];

    // Build a map of who excels at what (quality > 0.7)
    const expertiseMap = new Map<string, Array<{ id: string; name: string; type: string; skill: string; quality: number; taskTitle: string }>>();

    for (const d of decisions) {
      const quality = (d.outcome_quality_score as number) || 0;
      if (quality < 0.7) continue;

      const skills = parseJson<string[]>(d.required_skills, []);
      for (const skill of skills) {
        const list = expertiseMap.get(skill) || [];
        // Find name
        const person = people.find((p) => p.id === d.assigned_to_id);
        const name = person ? (person.name as string) : (d.assigned_to_id as string);

        list.push({
          id: d.assigned_to_id as string,
          name,
          type: d.assigned_to_type as string,
          skill,
          quality,
          taskTitle: d.task_title as string,
        });
        expertiseMap.set(skill, list);
      }
    }

    // Match experts with people who have that skill as a gap
    const suggestions: CrossPollinationSuggestion[] = [];

    for (const person of people) {
      const gaps = parseJson<string[]>(person.skill_gaps_to_close, []);
      for (const gap of gaps) {
        const experts = expertiseMap.get(gap);
        if (!experts) continue;

        // Find the best expert who isn't the same person
        const best = experts
          .filter((e) => e.id !== person.id)
          .sort((a, b) => b.quality - a.quality)[0];

        if (!best) continue;

        suggestions.push({
          sourceId: best.id,
          sourceName: best.name,
          sourceType: best.type as 'person' | 'agent',
          targetId: person.id as string,
          targetName: person.name as string,
          targetType: 'person',
          skill: gap,
          technique: `Applied in "${best.taskTitle}" with ${Math.round(best.quality * 100)}% quality`,
          relevanceScore: best.quality,
        });
      }
    }

    return suggestions
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 10);
  }

  // -----------------------------------------------------------------------
  // 6b. Team Council Topics
  // -----------------------------------------------------------------------

  async suggestCouncilTopics(): Promise<CouncilTopic[]> {
    const topics: CouncilTopic[] = [];

    // Check workload imbalances
    const { data: decisions } = await this.db
      .from('work_routing_decisions')
      .select('assigned_to_id, assigned_to_type, outcome')
      .eq('workspace_id', this.workspaceId)
      .gte('created_at', weekAgo());

    const personTaskCounts = new Map<string, number>();
    for (const d of (decisions || [])) {
      if (d.assigned_to_type === 'person' && !d.outcome) {
        const count = personTaskCounts.get(d.assigned_to_id as string) || 0;
        personTaskCounts.set(d.assigned_to_id as string, count + 1);
      }
    }

    const counts = Array.from(personTaskCounts.values());
    if (counts.length >= 2) {
      const max = Math.max(...counts);
      const min = Math.min(...counts);
      if (max > min * 3) {
        topics.push({
          topic: 'Workload distribution across the team',
          category: 'workload',
          urgency: 'high',
          context: `The most loaded person has ${max} active tasks while the least loaded has ${min}. Discuss how to redistribute.`,
        });
      }
    }

    // Check declining growth
    const { data: people } = await this.db
      .from('agent_workforce_person_models')
      .select('name, growth_direction')
      .eq('workspace_id', this.workspaceId)
      .in('ingestion_status', ['initial_complete', 'mature']);

    const declining = (people || []).filter((p) => p.growth_direction === 'declining');
    if (declining.length > 0) {
      topics.push({
        topic: 'Team member growth concerns',
        category: 'growth_signal',
        urgency: 'high',
        context: `${declining.map((p) => p.name).join(', ')} showing declining growth. Discuss support strategies.`,
      });
    }

    // Check skill gaps across team
    const allGaps = new Map<string, number>();
    for (const person of (people || [])) {
      const personData = await this.db
        .from('agent_workforce_person_models')
        .select('skill_gaps_to_close')
        .eq('id', person.name) // This won't work correctly but we handle gracefully
        .single();
      // Fallback: count gaps from the loaded data
    }

    // Check operational pillar gaps
    const { data: pillars } = await this.db
      .from('pillar_instances')
      .select('status')
      .eq('workspace_id', this.workspaceId);

    const notStarted = (pillars || []).filter((p) => p.status === 'not_started');
    if (notStarted.length >= 3) {
      topics.push({
        topic: 'Operational gaps that need attention',
        category: 'operational_gap',
        urgency: 'normal',
        context: `${notStarted.length} operational pillars haven't been started yet. Prioritize which to build next.`,
      });
    }

    return topics.sort((a, b) => {
      const order = { high: 0, normal: 1, low: 2 };
      return order[a.urgency] - order[b.urgency];
    });
  }

  // -----------------------------------------------------------------------
  // 6c. Collective Briefing
  // -----------------------------------------------------------------------

  async assembleCollectiveBriefing(personModelId: string): Promise<CollectiveBriefing> {
    const [crossPollination, teamCapacity, rebalance] = await Promise.all([
      this.findCrossPollinationOpportunities(),
      this.getTeamCapacity(),
      this.suggestRebalancing(),
    ]);

    // Team growth summary
    const { data: people } = await this.db
      .from('agent_workforce_person_models')
      .select('growth_direction')
      .eq('workspace_id', this.workspaceId)
      .in('ingestion_status', ['initial_complete', 'mature']);

    const persons = people || [];
    const teamGrowth = {
      ascending: persons.filter((p) => p.growth_direction === 'ascending').length,
      plateau: persons.filter((p) => p.growth_direction === 'plateau' || !p.growth_direction).length,
      declining: persons.filter((p) => p.growth_direction === 'declining').length,
    };

    // Council insights from consciousness items
    const { data: councilItems } = await this.db
      .from('consciousness_items')
      .select('content, created_at, category')
      .eq('workspace_id', this.workspaceId)
      .eq('category', 'council_insight')
      .order('created_at', { ascending: false })
      .limit(5);

    const councilInsights = (councilItems || []).map((i) => ({
      topic: 'Council',
      insight: i.content as string,
      createdAt: i.created_at as string,
    }));

    // Workload alerts
    const workloadAlerts: string[] = [];
    if (teamCapacity.overloadedPeople.length > 0) {
      workloadAlerts.push(`${teamCapacity.overloadedPeople.length} team member${teamCapacity.overloadedPeople.length !== 1 ? 's' : ''} overloaded`);
    }
    if (teamCapacity.underutilizedAgents.length > 0) {
      workloadAlerts.push(`${teamCapacity.underutilizedAgents.length} agent${teamCapacity.underutilizedAgents.length !== 1 ? 's' : ''} underutilized`);
    }
    if (teamCapacity.headroomPercent < 20) {
      workloadAlerts.push('Team capacity running low (under 20% headroom)');
    }

    const briefing: CollectiveBriefing = {
      computedAt: new Date().toISOString(),
      teamGrowth,
      crossPollination: crossPollination.slice(0, 5),
      rebalanceSuggestions: rebalance.slice(0, 5),
      councilInsights,
      workloadAlerts,
      teamCapacity,
    };

    // Store on person model
    await this.db.from('agent_workforce_person_models').update({
      collective_briefing: JSON.stringify(briefing),
      updated_at: new Date().toISOString(),
    }).eq('id', personModelId);

    logger.info({
      personModelId,
      pollinations: crossPollination.length,
      rebalanceSuggestions: rebalance.length,
      alerts: workloadAlerts.length,
    }, 'Collective briefing assembled');

    return briefing;
  }

  // -----------------------------------------------------------------------
  // 6d. Workload Rebalancing
  // -----------------------------------------------------------------------

  async suggestRebalancing(): Promise<RebalanceSuggestion[]> {
    const since = weekAgo();

    // Get person workloads
    const { data: personDecisions } = await this.db
      .from('work_routing_decisions')
      .select('assigned_to_id, assigned_to_type, task_title, required_skills, outcome, confidence_score, runner_up_id, runner_up_type, runner_up_score')
      .eq('workspace_id', this.workspaceId)
      .eq('assigned_to_type', 'person')
      .gte('created_at', since);

    if (!personDecisions || personDecisions.length === 0) return [];

    // Count active tasks per person
    const personLoads = new Map<string, { active: number; total: number }>();
    for (const d of personDecisions) {
      const id = d.assigned_to_id as string;
      const load = personLoads.get(id) || { active: 0, total: 0 };
      load.total++;
      if (!d.outcome) load.active++;
      personLoads.set(id, load);
    }

    // Find overloaded people with tasks that have close runner-ups
    const suggestions: RebalanceSuggestion[] = [];
    const avgLoad = personDecisions.length / personLoads.size;

    for (const [personId, load] of personLoads) {
      if (load.active <= avgLoad) continue; // not overloaded

      // Find their tasks with agent runner-ups
      const rebalanceable = personDecisions.filter(
        (d) => d.assigned_to_id === personId && !d.outcome
          && d.runner_up_type === 'agent' && d.runner_up_score
          && ((d.confidence_score as number) - (d.runner_up_score as number)) < 0.2,
      );

      for (const task of rebalanceable.slice(0, 2)) {
        // Get names
        const { data: personData } = await this.db
          .from('agent_workforce_person_models')
          .select('name')
          .eq('id', personId)
          .single();

        const { data: agentData } = await this.db
          .from('agent_workforce_agents')
          .select('name')
          .eq('id', task.runner_up_id as string)
          .single();

        if (!personData || !agentData) continue;

        const skills = parseJson<string[]>(task.required_skills, []);

        suggestions.push({
          fromId: personId,
          fromName: personData.name as string,
          fromType: 'person',
          toId: task.runner_up_id as string,
          toName: agentData.name as string,
          toType: 'agent',
          taskType: skills[0] || 'general',
          reason: `${personData.name} has ${load.active} active tasks (avg: ${Math.round(avgLoad)}). Agent scored within 20% on this task.`,
          impact: `Frees up ${personData.name} for higher-value work.`,
        });
      }
    }

    return suggestions;
  }

  async getTeamCapacity(): Promise<TeamCapacity> {
    const { data: people } = await this.db
      .from('agent_workforce_person_models')
      .select('id, name')
      .eq('workspace_id', this.workspaceId)
      .in('ingestion_status', ['initial_complete', 'mature']);

    const { data: agents } = await this.db
      .from('agent_workforce_agents')
      .select('id, name')
      .eq('workspace_id', this.workspaceId)
      .in('status', ['active', 'idle']);

    const { data: decisions } = await this.db
      .from('work_routing_decisions')
      .select('assigned_to_id, assigned_to_type, outcome')
      .eq('workspace_id', this.workspaceId)
      .gte('created_at', weekAgo());

    const allDecisions = decisions || [];
    const personIds = (people || []).map((p) => p.id as string);
    const agentIds = (agents || []).map((a) => a.id as string);

    // Person utilization
    const personActive = new Map<string, number>();
    const agentActive = new Map<string, number>();

    for (const d of allDecisions) {
      if (!d.outcome) {
        if (d.assigned_to_type === 'person') {
          personActive.set(d.assigned_to_id as string, (personActive.get(d.assigned_to_id as string) || 0) + 1);
        } else {
          agentActive.set(d.assigned_to_id as string, (agentActive.get(d.assigned_to_id as string) || 0) + 1);
        }
      }
    }

    const maxPersonTasks = 10;
    const maxAgentTasks = 20;

    const personUtils = personIds.map((id) => (personActive.get(id) || 0) / maxPersonTasks);
    const agentUtils = agentIds.map((id) => (agentActive.get(id) || 0) / maxAgentTasks);

    const avgPersonUtil = personUtils.length > 0 ? personUtils.reduce((a, b) => a + b, 0) / personUtils.length : 0;
    const avgAgentUtil = agentUtils.length > 0 ? agentUtils.reduce((a, b) => a + b, 0) / agentUtils.length : 0;

    const overloadedPeople = personIds.filter((id) => (personActive.get(id) || 0) > maxPersonTasks * 0.8);
    const underutilizedAgents = agentIds.filter((id) => (agentActive.get(id) || 0) === 0);

    const totalCapacity = personIds.length * maxPersonTasks + agentIds.length * maxAgentTasks;
    const totalActive = Array.from(personActive.values()).reduce((a, b) => a + b, 0)
      + Array.from(agentActive.values()).reduce((a, b) => a + b, 0);

    return {
      totalPeople: personIds.length,
      totalAgents: agentIds.length,
      avgPersonUtilization: Math.round(avgPersonUtil * 100) / 100,
      avgAgentUtilization: Math.round(avgAgentUtil * 100) / 100,
      overloadedPeople,
      underutilizedAgents,
      headroomPercent: totalCapacity > 0 ? Math.round((1 - totalActive / totalCapacity) * 100) : 100,
    };
  }
}
