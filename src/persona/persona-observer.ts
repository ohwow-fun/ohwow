/**
 * Persona Observer — Behavioral Observation Engine
 *
 * "Know thyself" — inscribed at the Temple of Apollo at Delphi
 * (but here: "Know thy human")
 *
 * The core module. Listens to system events and builds the
 * PersonaModel over time. All inference from observation, no questions.
 */

import crypto from 'crypto';
import type {
  PersonaModel,
  BehavioralEvent,
  ChronoBioProfile,
  CognitiveLoadState,
  CommunicationProfile,
  AgentTrustMap,
  AgentTrustEntry,
  EnergyState,
  WorkIntensity,
  TrustTrend,
} from './types.js';
import { computeChronoBio, estimateEnergyState } from './chrono-bio.js';
import { computeCognitiveLoad } from './cognitive-load.js';
import { computeCommunicationProfile } from './communication.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Maximum events to keep in memory for computation. */
const MAX_EVENTS_IN_MEMORY = 500;

/** Window for "recent decisions" (ms). */
const RECENT_DECISIONS_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** Window for trust trend computation (ms). */
const TRUST_TREND_RECENT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TRUST_TREND_PRIOR_MS = 23 * 24 * 60 * 60 * 1000; // 23 days (prior to recent)

/** Days of consecutive high activity before sprint detection. */
const SPRINT_THRESHOLD_DAYS = 5;

// ============================================================================
// PERSONA OBSERVER
// ============================================================================

/**
 * Persistence adapter for the observer (SQLite or Supabase).
 */
export interface PersonaPersistence {
  saveEvent(event: BehavioralEvent & { id: string }): Promise<void>;
  loadEvents(since: number, limit?: number): Promise<BehavioralEvent[]>;
  saveModel(model: PersonaModel): Promise<void>;
  loadModel(): Promise<PersonaModel | null>;
}

export class PersonaObserver {
  private events: BehavioralEvent[] = [];
  private cachedModel: PersonaModel | null = null;
  private persistence: PersonaPersistence | null;

  constructor(persistence?: PersonaPersistence) {
    this.persistence = persistence ?? null;
  }

  // --------------------------------------------------------------------------
  // OBSERVE — Record a behavioral event
  // --------------------------------------------------------------------------

  /**
   * Record a behavioral event. Call this from approval handlers,
   * chat handlers, task creation, briefing reads, etc.
   */
  observe(event: BehavioralEvent): void {
    this.events.push(event);

    // Memory guard
    if (this.events.length > MAX_EVENTS_IN_MEMORY) {
      this.events = this.events.slice(-MAX_EVENTS_IN_MEMORY);
    }

    // Persist (fire-and-forget)
    if (this.persistence) {
      this.persistence.saveEvent({ ...event, id: crypto.randomUUID() }).catch(() => {});
    }

    // Invalidate cached model
    this.cachedModel = null;
  }

  // --------------------------------------------------------------------------
  // COMPUTE — Build the persona model
  // --------------------------------------------------------------------------

  /**
   * Compute the full persona model from accumulated observations.
   * Returns cached model if no new events since last computation.
   */
  computePersona(
    liveData?: { openApprovals: number; openTasks: number },
  ): PersonaModel {
    if (this.cachedModel && !liveData) return this.cachedModel;

    const now = Date.now();
    const allEvents = this.events;

    // ChronoBio
    const actionTimestamps = allEvents.map(e => e.timestamp);
    const chronoBio = computeChronoBio({ actionTimestamps });

    // Cognitive load (needs live data)
    const recentDecisions = allEvents.filter(
      e => (e.type === 'approval' || e.type === 'rejection') && (now - e.timestamp) < RECENT_DECISIONS_WINDOW_MS,
    ).length;
    const cognitiveLoad = computeCognitiveLoad({
      openApprovals: liveData?.openApprovals ?? 0,
      openTasks: liveData?.openTasks ?? 0,
      recentDecisionsCount: recentDecisions,
    });

    // Communication
    const messageEvents = allEvents.filter(e => e.type === 'message_sent');
    const messages = messageEvents.map(e => ({
      wordCount: (e.metadata.wordCount as number) ?? 20,
      timestamp: e.timestamp,
    }));
    const approvalEvents = allEvents.filter(e => e.type === 'approval');
    const approvals = approvalEvents.map(e => ({
      taskCompletedAt: (e.metadata.taskCompletedAt as number) ?? e.timestamp - 60000,
      approvedAt: e.timestamp,
    }));
    const communication = computeCommunicationProfile({ messages, approvals });

    // Agent trust
    const agentTrust = this.computeAgentTrust(allEvents, now);

    // Energy state
    const currentHour = new Date(now).getHours();
    const energyState = estimateEnergyState(chronoBio, currentHour);

    // Work intensity
    const workIntensity = this.computeWorkIntensity(allEvents, now);

    const model: PersonaModel = {
      userId: 'default',
      chronoBio,
      cognitiveLoad,
      communication,
      agentTrust,
      energyState,
      workIntensity,
      lastUpdated: new Date(now).toISOString(),
      dataPoints: allEvents.length,
    };

    this.cachedModel = model;

    // Persist (fire-and-forget)
    if (this.persistence) {
      this.persistence.saveModel(model).catch(() => {});
    }

    return model;
  }

  // --------------------------------------------------------------------------
  // CONVENIENCE ACCESSORS
  // --------------------------------------------------------------------------

  getCurrentLoad(openApprovals: number, openTasks: number): CognitiveLoadState {
    const now = Date.now();
    const recentDecisions = this.events.filter(
      e => (e.type === 'approval' || e.type === 'rejection') && (now - e.timestamp) < RECENT_DECISIONS_WINDOW_MS,
    ).length;
    return computeCognitiveLoad({ openApprovals, openTasks, recentDecisionsCount: recentDecisions });
  }

  shouldAddWork(openApprovals: number, openTasks: number): boolean {
    return this.getCurrentLoad(openApprovals, openTasks).recommendation === 'add_work';
  }

  getEnergyState(): EnergyState {
    const model = this.cachedModel ?? this.computePersona();
    return model.energyState;
  }

  /** Hydrate from persistence on startup. */
  async hydrate(): Promise<number> {
    if (!this.persistence) return 0;
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const events = await this.persistence.loadEvents(thirtyDaysAgo, MAX_EVENTS_IN_MEMORY);
    this.events = events;
    const model = await this.persistence.loadModel();
    if (model) this.cachedModel = model;
    return events.length;
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  private computeAgentTrust(events: BehavioralEvent[], now: number): AgentTrustMap {
    const trust: AgentTrustMap = {};

    // Group approval/rejection events by agentId
    const agentEvents = new Map<string, BehavioralEvent[]>();
    for (const event of events) {
      if (event.type !== 'approval' && event.type !== 'rejection') continue;
      const agentId = event.metadata.agentId as string | undefined;
      if (!agentId) continue;
      if (!agentEvents.has(agentId)) agentEvents.set(agentId, []);
      agentEvents.get(agentId)!.push(event);
    }

    for (const [agentId, agentEvts] of agentEvents) {
      const approvals = agentEvts.filter(e => e.type === 'approval');
      const total = agentEvts.length;
      const approvalRate = total > 0 ? approvals.length / total : 0.5;

      // Approval timing
      const times = approvals.map(e => {
        const taskCompleted = (e.metadata.taskCompletedAt as number) ?? e.timestamp - 30000;
        return e.timestamp - taskCompleted;
      }).filter(t => t > 0);
      const avgTime = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 30000;

      // Trend: last 7 days vs prior 23 days
      const recentBoundary = now - TRUST_TREND_RECENT_MS;
      const priorBoundary = now - TRUST_TREND_RECENT_MS - TRUST_TREND_PRIOR_MS;

      const recentApprovals = agentEvts.filter(e => e.timestamp >= recentBoundary);
      const priorApprovals = agentEvts.filter(e => e.timestamp >= priorBoundary && e.timestamp < recentBoundary);

      const recentRate = recentApprovals.length > 0
        ? recentApprovals.filter(e => e.type === 'approval').length / recentApprovals.length
        : approvalRate;
      const priorRate = priorApprovals.length > 0
        ? priorApprovals.filter(e => e.type === 'approval').length / priorApprovals.length
        : approvalRate;

      let trend: TrustTrend = 'stable';
      if (recentRate > priorRate + 0.1) trend = 'rising';
      else if (recentRate < priorRate - 0.1) trend = 'declining';

      trust[agentId] = {
        trustScore: approvalRate,
        totalInteractions: total,
        approvalRate,
        avgTimeToApproveMs: avgTime,
        lastInteraction: agentEvts.length > 0
          ? new Date(agentEvts[agentEvts.length - 1].timestamp).toISOString()
          : new Date().toISOString(),
        trend,
      };
    }

    return trust;
  }

  private computeWorkIntensity(events: BehavioralEvent[], now: number): WorkIntensity {
    // Count active days in the last 7 days
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const recentEvents = events.filter(e => e.timestamp >= sevenDaysAgo);
    const activeDays = new Set(
      recentEvents.map(e => new Date(e.timestamp).toISOString().split('T')[0]),
    ).size;

    // Count events per day (average)
    const eventsPerDay = recentEvents.length / Math.max(activeDays, 1);

    if (activeDays >= SPRINT_THRESHOLD_DAYS && eventsPerDay > 15) return 'sprint';
    if (activeDays >= 3 && eventsPerDay > 5) return 'steady';
    if (activeDays <= 1 || eventsPerDay < 3) return 'recovery';
    return 'light';
  }
}
