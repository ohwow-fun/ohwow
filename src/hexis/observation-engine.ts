/**
 * Observation Engine — Local Runtime
 *
 * Mines existing data sources to build a continuously updated Work Pattern
 * Map per person. Detects communication patterns, task engagement, time
 * allocation, automation adoption, knowledge consumption, and operational
 * health. Generates insights and feeds the Transition Engine + Growth Engine.
 *
 * Integration-only approach: no browser extension or desktop agent.
 * Phase 5 of Center of Operations.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommunicationPatterns {
  dailyMessageVolume: number;
  primaryChannel: string;
  avgResponseMinutes: number;
  activeHours: number[];
  channelBreakdown: Record<string, number>;
}

export interface TaskEngagementPatterns {
  tasksPerWeek: number;
  approvalLatencyMinutes: number;
  rejectionRate: number;
  agentDependencyRatio: number;
  topTaskTypes: string[];
}

export interface TimeAllocation {
  deepWorkHours: number;
  communicationHours: number;
  meetingHours: number;
  approvalHours: number;
  operationsHours: number;
  totalTrackedHours: number;
}

export interface AutomationAdoption {
  patternsTracked: number;
  patternsAtAutopilot: number;
  automationCoverage: number;
  activeWorkflows: number;
  activeTriggers: number;
}

export interface KnowledgePatterns {
  docsAccessedThisWeek: number;
  skillChangesThisMonth: number;
  newTopics: string[];
}

export interface OperationalHealth {
  anomalyCountWeek: number;
  recoveryRate: number;
  costTrend: 'increasing' | 'stable' | 'decreasing';
  connectorHealth: number;
}

export interface ObservationInsight {
  type: 'time_sink' | 'automation_opportunity' | 'communication_overload' | 'deep_work_deficit' | 'approval_bottleneck' | 'knowledge_gap' | 'workload_imbalance';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  suggestion: string;
}

export interface WorkPatternMap {
  computedAt: string;
  communication: CommunicationPatterns;
  taskEngagement: TaskEngagementPatterns;
  timeAllocation: TimeAllocation;
  automationAdoption: AutomationAdoption;
  knowledge: KnowledgePatterns;
  operationalHealth: OperationalHealth;
  insights: ObservationInsight[];
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

function monthAgo(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Observation Engine
// ---------------------------------------------------------------------------

export class ObservationEngine {
  constructor(private db: DatabaseAdapter, private workspaceId: string) {}

  /**
   * Compute the full Work Pattern Map for a person.
   */
  async computeWorkPatternMap(personModelId: string): Promise<WorkPatternMap | null> {
    const { data: person } = await this.db
      .from('agent_workforce_person_models')
      .select('id, name, energy_patterns, friction_points, flow_triggers')
      .eq('id', personModelId)
      .single();

    if (!person) return null;

    const [communication, taskEngagement, timeAllocation, automationAdoption, knowledge, operationalHealth] = await Promise.all([
      this.computeCommunication(personModelId),
      this.computeTaskEngagement(personModelId),
      this.computeTimeAllocation(personModelId),
      this.computeAutomationAdoption(),
      this.computeKnowledge(personModelId),
      this.computeOperationalHealth(),
    ]);

    const patternMap: WorkPatternMap = {
      computedAt: new Date().toISOString(),
      communication,
      taskEngagement,
      timeAllocation,
      automationAdoption,
      knowledge,
      operationalHealth,
      insights: [],
    };

    // Generate insights
    patternMap.insights = this.generateInsights(patternMap, person);

    // Store on person model
    await this.db.from('agent_workforce_person_models').update({
      work_pattern_map: JSON.stringify(patternMap),
      updated_at: new Date().toISOString(),
    }).eq('id', personModelId);

    // Store behavioral observations for refinement pipeline
    await this.storeObservation(personModelId, 'time_allocation', timeAllocation as unknown as Record<string, unknown>);
    await this.storeObservation(personModelId, 'communication', communication as unknown as Record<string, unknown>);

    logger.info({ personModelId, insights: patternMap.insights.length }, 'Work pattern map computed');
    return patternMap;
  }

  // -----------------------------------------------------------------------
  // Dimension: Communication
  // -----------------------------------------------------------------------

  private async computeCommunication(personModelId: string): Promise<CommunicationPatterns> {
    const since = weekAgo();
    const channelCounts: Record<string, number> = {};
    let totalMessages = 0;

    // Orchestrator conversations (TUI/voice)
    const { data: conversations } = await this.db
      .from('orchestrator_conversations')
      .select('channel, message_count')
      .eq('workspace_id', this.workspaceId)
      .gte('last_message_at', since);

    for (const c of (conversations || [])) {
      const channel = (c.channel as string) || 'tui';
      const count = (c.message_count as number) || 0;
      channelCounts[channel] = (channelCounts[channel] || 0) + count;
      totalMessages += count;
    }

    // WhatsApp messages
    const { data: waMessages } = await this.db
      .from('whatsapp_chat_messages')
      .select('created_at')
      .eq('role', 'user')
      .gte('created_at', since);

    const waCount = waMessages?.length || 0;
    channelCounts['whatsapp'] = (channelCounts['whatsapp'] || 0) + waCount;
    totalMessages += waCount;

    // Telegram messages
    const { data: tgMessages } = await this.db
      .from('telegram_chat_messages')
      .select('created_at')
      .eq('role', 'user')
      .gte('created_at', since);

    const tgCount = tgMessages?.length || 0;
    channelCounts['telegram'] = (channelCounts['telegram'] || 0) + tgCount;
    totalMessages += tgCount;

    // Active hours from message timestamps
    const allTimestamps: string[] = [
      ...(waMessages || []).map((m) => m.created_at as string),
      ...(tgMessages || []).map((m) => m.created_at as string),
    ];

    const hourCounts: Record<number, number> = {};
    for (const ts of allTimestamps) {
      const hour = new Date(ts).getHours();
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    }
    const activeHours = Object.entries(hourCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([h]) => Number(h))
      .sort((a, b) => a - b);

    // Primary channel
    const primaryChannel = Object.entries(channelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'tui';

    return {
      dailyMessageVolume: Math.round(totalMessages / 7),
      primaryChannel,
      avgResponseMinutes: 0, // would need paired request/response analysis
      activeHours,
      channelBreakdown: channelCounts,
    };
  }

  // -----------------------------------------------------------------------
  // Dimension: Task Engagement
  // -----------------------------------------------------------------------

  private async computeTaskEngagement(personModelId: string): Promise<TaskEngagementPatterns> {
    const since = weekAgo();

    // Routing decisions for this person
    const { data: decisions } = await this.db
      .from('work_routing_decisions')
      .select('outcome, required_skills, assignment_method, created_at')
      .eq('assigned_to_id', personModelId)
      .eq('assigned_to_type', 'person')
      .gte('created_at', since);

    const allDecisions = decisions || [];
    const completed = allDecisions.filter((d) => d.outcome === 'completed');
    const rejected = allDecisions.filter((d) => d.outcome === 'rejected');

    // Tasks with approval data
    const { data: approvalTasks } = await this.db
      .from('agent_workforce_tasks')
      .select('approved_at, completed_at, status')
      .eq('workspace_id', this.workspaceId)
      .in('status', ['approved', 'rejected'])
      .gte('completed_at', since);

    let totalApprovalMinutes = 0;
    let approvalCount = 0;
    for (const t of (approvalTasks || [])) {
      if (t.approved_at && t.completed_at) {
        const diff = (new Date(t.approved_at as string).getTime() - new Date(t.completed_at as string).getTime()) / 60000;
        if (diff > 0 && diff < 1440) { // under 24h
          totalApprovalMinutes += diff;
          approvalCount++;
        }
      }
    }

    // Task type distribution from required_skills
    const skillCounts: Record<string, number> = {};
    for (const d of allDecisions) {
      const skills = parseJson<string[]>(d.required_skills, []);
      for (const s of skills) skillCounts[s] = (skillCounts[s] || 0) + 1;
    }
    const topTaskTypes = Object.entries(skillCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([s]) => s);

    // Agent dependency: what fraction of all tasks are done by agents?
    const { data: allTasks } = await this.db
      .from('agent_workforce_tasks')
      .select('status')
      .eq('workspace_id', this.workspaceId)
      .eq('status', 'completed')
      .gte('completed_at', since);

    const totalTasksCompleted = allTasks?.length || 0;
    const agentDependencyRatio = totalTasksCompleted > 0
      ? (totalTasksCompleted - completed.length) / totalTasksCompleted
      : 0;

    return {
      tasksPerWeek: allDecisions.length,
      approvalLatencyMinutes: approvalCount > 0 ? Math.round(totalApprovalMinutes / approvalCount) : 0,
      rejectionRate: allDecisions.length > 0 ? rejected.length / allDecisions.length : 0,
      agentDependencyRatio: Math.round(agentDependencyRatio * 100) / 100,
      topTaskTypes,
    };
  }

  // -----------------------------------------------------------------------
  // Dimension: Time Allocation
  // -----------------------------------------------------------------------

  async computeTimeAllocation(personModelId: string): Promise<TimeAllocation> {
    const since = weekAgo();

    // Deep work: tasks with duration > 30min
    const { data: longTasks } = await this.db
      .from('work_routing_decisions')
      .select('actual_effort_minutes')
      .eq('assigned_to_id', personModelId)
      .eq('assigned_to_type', 'person')
      .eq('outcome', 'completed')
      .gte('created_at', since);

    let deepWorkMinutes = 0;
    for (const t of (longTasks || [])) {
      const minutes = (t.actual_effort_minutes as number) || 0;
      if (minutes > 30) deepWorkMinutes += minutes;
    }

    // Communication: estimate from message volume
    const comm = await this.computeCommunication(personModelId);
    const communicationMinutes = comm.dailyMessageVolume * 7 * 2; // ~2 min per message exchange

    // Meetings
    const { data: meetings } = await this.db
      .from('meeting_sessions')
      .select('started_at, ended_at')
      .eq('workspace_id', this.workspaceId)
      .gte('started_at', since);

    let meetingMinutes = 0;
    for (const m of (meetings || [])) {
      if (m.started_at && m.ended_at) {
        const diff = (new Date(m.ended_at as string).getTime() - new Date(m.started_at as string).getTime()) / 60000;
        if (diff > 0 && diff < 480) meetingMinutes += diff;
      }
    }

    // Approvals
    const { data: approvals } = await this.db
      .from('agent_workforce_tasks')
      .select('approved_at, completed_at')
      .eq('workspace_id', this.workspaceId)
      .eq('status', 'approved')
      .gte('approved_at', since);

    let approvalMinutes = 0;
    for (const a of (approvals || [])) {
      approvalMinutes += 5; // estimate 5 min per approval review
    }

    // Operations: workflow runs + trigger fires
    const { data: workflowRuns } = await this.db
      .from('agent_workforce_workflow_runs')
      .select('status')
      .eq('status', 'completed')
      .gte('started_at', since);

    const opsMinutes = (workflowRuns?.length || 0) * 3; // estimate 3 min attention per workflow run

    const totalMinutes = deepWorkMinutes + communicationMinutes + meetingMinutes + approvalMinutes + opsMinutes;

    return {
      deepWorkHours: Math.round(deepWorkMinutes / 60 * 10) / 10,
      communicationHours: Math.round(communicationMinutes / 60 * 10) / 10,
      meetingHours: Math.round(meetingMinutes / 60 * 10) / 10,
      approvalHours: Math.round(approvalMinutes / 60 * 10) / 10,
      operationsHours: Math.round(opsMinutes / 60 * 10) / 10,
      totalTrackedHours: Math.round(totalMinutes / 60 * 10) / 10,
    };
  }

  // -----------------------------------------------------------------------
  // Dimension: Automation Adoption
  // -----------------------------------------------------------------------

  private async computeAutomationAdoption(): Promise<AutomationAdoption> {
    const { data: transitions } = await this.db
      .from('task_transitions')
      .select('current_stage')
      .eq('workspace_id', this.workspaceId)
      .eq('active', 1);

    const all = transitions || [];
    const atAutopilot = all.filter((t) => (t.current_stage as number) >= 4).length;

    const { data: workflows } = await this.db
      .from('agent_workforce_workflows')
      .select('status')
      .eq('workspace_id', this.workspaceId)
      .eq('status', 'active');

    const { data: triggers } = await this.db
      .from('local_triggers')
      .select('enabled')
      .eq('workspace_id', this.workspaceId)
      .eq('enabled', 1);

    return {
      patternsTracked: all.length,
      patternsAtAutopilot: atAutopilot,
      automationCoverage: all.length > 0 ? atAutopilot / all.length : 0,
      activeWorkflows: workflows?.length || 0,
      activeTriggers: triggers?.length || 0,
    };
  }

  // -----------------------------------------------------------------------
  // Dimension: Knowledge & Learning
  // -----------------------------------------------------------------------

  private async computeKnowledge(personModelId: string): Promise<KnowledgePatterns> {
    const since = weekAgo();
    const monthSince = monthAgo();

    // Knowledge docs accessed
    const { data: docs } = await this.db
      .from('agent_workforce_knowledge_documents')
      .select('id')
      .eq('workspace_id', this.workspaceId)
      .gte('last_used_at', since);

    // Skill progression events this month
    const { data: progressions } = await this.db
      .from('skill_progression')
      .select('skill_name')
      .eq('person_model_id', personModelId)
      .gte('created_at', monthSince);

    // New topics from consciousness items
    const { data: items } = await this.db
      .from('consciousness_items')
      .select('content, category')
      .eq('workspace_id', this.workspaceId)
      .eq('category', 'insight')
      .gte('created_at', since)
      .limit(10);

    const newTopics = (items || [])
      .map((i) => (i.content as string || '').slice(0, 50))
      .slice(0, 5);

    return {
      docsAccessedThisWeek: docs?.length || 0,
      skillChangesThisMonth: progressions?.length || 0,
      newTopics,
    };
  }

  // -----------------------------------------------------------------------
  // Dimension: Operational Health
  // -----------------------------------------------------------------------

  private async computeOperationalHealth(): Promise<OperationalHealth> {
    const since = weekAgo();

    const { data: anomalies } = await this.db
      .from('agent_workforce_anomaly_alerts')
      .select('severity')
      .gte('created_at', since);

    const { data: recoveries } = await this.db
      .from('recovery_audit_log')
      .select('recovered')
      .eq('workspace_id', this.workspaceId)
      .gte('created_at', since);

    const totalRecoveries = recoveries?.length || 0;
    const successfulRecoveries = (recoveries || []).filter((r) => r.recovered === 1).length;

    // Cost trend: compare this week to last week
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    const { data: usage } = await this.db
      .from('resource_usage_daily')
      .select('total_cost_cents, date')
      .eq('workspace_id', this.workspaceId)
      .gte('date', twoWeeksAgo.toISOString().slice(0, 10));

    let costTrend: 'increasing' | 'stable' | 'decreasing' = 'stable';
    if (usage && usage.length >= 10) {
      const mid = Math.floor(usage.length / 2);
      const firstHalf = usage.slice(0, mid).reduce((s, u) => s + ((u.total_cost_cents as number) || 0), 0);
      const secondHalf = usage.slice(mid).reduce((s, u) => s + ((u.total_cost_cents as number) || 0), 0);
      if (secondHalf > firstHalf * 1.2) costTrend = 'increasing';
      else if (secondHalf < firstHalf * 0.8) costTrend = 'decreasing';
    }

    // Connector health
    const { data: connectors } = await this.db
      .from('data_source_connectors')
      .select('last_sync_status, enabled')
      .eq('workspace_id', this.workspaceId)
      .eq('enabled', 1);

    const healthyConnectors = (connectors || []).filter((c) => c.last_sync_status === 'success').length;
    const totalConnectors = connectors?.length || 0;

    return {
      anomalyCountWeek: anomalies?.length || 0,
      recoveryRate: totalRecoveries > 0 ? successfulRecoveries / totalRecoveries : 1,
      costTrend,
      connectorHealth: totalConnectors > 0 ? healthyConnectors / totalConnectors : 1,
    };
  }

  // -----------------------------------------------------------------------
  // Insight Generation
  // -----------------------------------------------------------------------

  private generateInsights(
    map: WorkPatternMap,
    person: Record<string, unknown>,
  ): ObservationInsight[] {
    const insights: ObservationInsight[] = [];
    const energyPatterns = parseJson<Record<string, unknown>>(person.energy_patterns, {});
    const frictionPoints = parseJson<string[]>(person.friction_points, []);

    // Approval bottleneck
    if (map.taskEngagement.approvalLatencyMinutes > 30) {
      insights.push({
        type: 'approval_bottleneck',
        severity: map.taskEngagement.approvalLatencyMinutes > 120 ? 'warning' : 'info',
        message: `Approvals take an average of ${map.taskEngagement.approvalLatencyMinutes} minutes. ${map.taskEngagement.rejectionRate < 0.1 ? 'Most are rubber-stamped.' : ''}`,
        suggestion: map.taskEngagement.rejectionRate < 0.1
          ? 'Consider promoting high-confidence patterns to Autopilot to skip the review step.'
          : 'Review rejection reasons to identify training opportunities.',
      });
    }

    // Communication overload
    const commShare = map.timeAllocation.totalTrackedHours > 0
      ? map.timeAllocation.communicationHours / map.timeAllocation.totalTrackedHours
      : 0;
    if (commShare > 0.3) {
      insights.push({
        type: 'communication_overload',
        severity: commShare > 0.5 ? 'warning' : 'info',
        message: `Communication takes ${Math.round(commShare * 100)}% of tracked time (${map.timeAllocation.communicationHours}h/week).`,
        suggestion: 'Consider delegating routine communication to agents, or batching responses to specific time windows.',
      });
    }

    // Deep work deficit
    if (map.timeAllocation.deepWorkHours < map.timeAllocation.communicationHours) {
      insights.push({
        type: 'deep_work_deficit',
        severity: 'warning',
        message: `Deep work (${map.timeAllocation.deepWorkHours}h) is less than communication time (${map.timeAllocation.communicationHours}h).`,
        suggestion: 'Block dedicated deep work windows and have agents buffer non-urgent notifications during those times.',
      });
    }

    // Low automation adoption
    if (map.automationAdoption.patternsTracked > 5 && map.automationAdoption.automationCoverage < 0.2) {
      insights.push({
        type: 'automation_opportunity',
        severity: 'info',
        message: `${map.automationAdoption.patternsTracked} task patterns tracked but only ${Math.round(map.automationAdoption.automationCoverage * 100)}% at Autopilot or above.`,
        suggestion: 'Review patterns at Shadow/Suggest stage and promote the ones with high confidence scores.',
      });
    }

    // High agent dependency
    if (map.taskEngagement.agentDependencyRatio > 0.8) {
      insights.push({
        type: 'workload_imbalance',
        severity: 'info',
        message: `Agents handle ${Math.round(map.taskEngagement.agentDependencyRatio * 100)}% of completed tasks. The team is highly automated.`,
        suggestion: 'Good. Focus human time on strategic decisions, creative work, and relationship building.',
      });
    }

    // Knowledge gap
    if (map.knowledge.docsAccessedThisWeek === 0 && map.knowledge.skillChangesThisMonth === 0) {
      insights.push({
        type: 'knowledge_gap',
        severity: 'info',
        message: 'No knowledge docs accessed and no skill changes recorded this period.',
        suggestion: 'Consider adding relevant knowledge to the base, or starting a skill development path.',
      });
    }

    // Friction point alignment
    for (const friction of frictionPoints) {
      const frictionLower = (friction as string).toLowerCase();
      if (frictionLower.includes('approv') && map.taskEngagement.approvalLatencyMinutes > 15) {
        insights.push({
          type: 'time_sink',
          severity: 'warning',
          message: `"${friction}" is listed as a friction point, and approvals are averaging ${map.taskEngagement.approvalLatencyMinutes} min.`,
          suggestion: 'This friction point is confirmed by the data. Prioritize automating the approval flow.',
        });
        break;
      }
    }

    return insights;
  }

  // -----------------------------------------------------------------------
  // Automation Opportunity Detection
  // -----------------------------------------------------------------------

  async detectAutomationOpportunities(): Promise<Array<{ taskTitle: string; frequency: number; suggestion: string }>> {
    const since = monthAgo();

    // Get completed tasks not linked to any transition pattern
    const { data: tasks } = await this.db
      .from('agent_workforce_tasks')
      .select('title, agent_id')
      .eq('workspace_id', this.workspaceId)
      .eq('status', 'completed')
      .gte('completed_at', since);

    if (!tasks || tasks.length < 5) return [];

    // Simple title clustering
    const clusters = new Map<string, number>();
    for (const t of tasks) {
      const key = (t.title as string || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .slice(0, 3)
        .sort()
        .join(' ');
      if (key) clusters.set(key, (clusters.get(key) || 0) + 1);
    }

    // Filter to clusters of 3+ not already in task_patterns
    const opportunities: Array<{ taskTitle: string; frequency: number; suggestion: string }> = [];

    for (const [key, count] of clusters) {
      if (count < 3) continue;

      const { data: existing } = await this.db
        .from('task_patterns')
        .select('id')
        .eq('workspace_id', this.workspaceId)
        .eq('name', key)
        .limit(1);

      if (existing && existing.length > 0) continue;

      opportunities.push({
        taskTitle: key,
        frequency: count,
        suggestion: `"${key}" appears ${count} times this month. Run detect_task_patterns to start tracking it.`,
      });
    }

    return opportunities.sort((a, b) => b.frequency - a.frequency).slice(0, 10);
  }

  // -----------------------------------------------------------------------
  // Observation Storage
  // -----------------------------------------------------------------------

  private async storeObservation(
    personModelId: string,
    dimension: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.db.from('agent_workforce_person_observations').insert({
      id: crypto.randomUUID(),
      person_model_id: personModelId,
      workspace_id: this.workspaceId,
      dimension,
      observation_type: 'behavioral',
      content: `Work pattern observation: ${dimension}`,
      data: JSON.stringify(data),
      confidence: 0.8,
      processed: 0,
      source_type: 'observation_engine',
      created_at: new Date().toISOString(),
    });
  }
}
