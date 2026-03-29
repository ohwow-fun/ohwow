/**
 * Digital Nervous System — Background Monitoring (Cybernetics)
 *
 * "The behavior of a system is controlled by its feedback loops."
 * — Norbert Wiener, Cybernetics
 *
 * The digital nervous system runs background monitoring loops for all
 * digital organs. It detects health changes, fires reflexes, and
 * produces NervousSignals that flow to the Brain's ExperienceStream.
 *
 * Timescale: 100ms-60s (slower than physical reflexes, faster than Brain).
 *
 * It formalizes monitoring patterns that already exist scattered across
 * the codebase (PeerMonitor health checks, desktop kill file watcher,
 * channel connection heartbeats) into a unified feedback system.
 */

import crypto from 'crypto';
import type {
  BodyPart,
  NervousSignal,
  NervousSignalType,
  ReflexRule,
  OrganHealth,
} from './types.js';
import type { DigitalBody } from './digital-body.js';
import type { ExperienceStream } from '../brain/experience-stream.js';
import type { GlobalWorkspace } from '../brain/global-workspace.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default monitoring interval per organ type. */
const DEFAULT_INTERVALS: Record<string, number> = {
  browser: 5000,
  desktop: 500,
  channels: 10000,
  mcp: 15000,
  peers: 30000,
  filesystem: 60000,
};

/** Salience scores for different signal types. */
const SIGNAL_SALIENCE: Record<NervousSignalType, number> = {
  sensation: 0.1,
  reflex_triggered: 0.8,
  health_change: 0.7,
  affordance_change: 0.3,
  pain: 0.9,
  proprioceptive: 0.2,
};

// ============================================================================
// DIGITAL NERVOUS SYSTEM
// ============================================================================

export interface DigitalNervousSystemOptions {
  /** The digital body to monitor. */
  body: DigitalBody;
  /** Brain's experience stream for logging body events. */
  experienceStream?: ExperienceStream;
  /** Brain's global workspace for broadcasting salient events. */
  workspace?: GlobalWorkspace;
  /** Override monitoring intervals per organ ID. */
  intervals?: Record<string, number>;
}

export class DigitalNervousSystem {
  private body: DigitalBody;
  private experienceStream: ExperienceStream | null;
  private workspace: GlobalWorkspace | null;
  private intervals: Record<string, number>;

  private loops: Map<string, ReturnType<typeof setInterval>> = new Map();
  private reflexes: ReflexRule[] = [];
  private listeners: Array<(signal: NervousSignal) => void> = [];
  private lastHealthState: Map<string, OrganHealth> = new Map();
  private lastAffordanceCount: Map<string, number> = new Map();
  private running = false;

  constructor(options: DigitalNervousSystemOptions) {
    this.body = options.body;
    this.experienceStream = options.experienceStream ?? null;
    this.workspace = options.workspace ?? null;
    this.intervals = { ...DEFAULT_INTERVALS, ...options.intervals };
  }

  // --------------------------------------------------------------------------
  // LIFECYCLE
  // --------------------------------------------------------------------------

  /** Start all monitoring loops for active organs. */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Initialize baseline health state
    for (const organ of this.body.getOrgans()) {
      this.lastHealthState.set(organ.id, organ.getHealth());
      this.lastAffordanceCount.set(organ.id, organ.getAffordances().length);
    }

    // Start a monitoring loop per organ
    for (const organ of this.body.getOrgans()) {
      const interval = this.intervals[organ.id] ?? 10000;
      const loop = setInterval(() => this.monitorOrgan(organ), interval);
      this.loops.set(organ.id, loop);
    }
  }

  /** Stop all monitoring loops. */
  stop(): void {
    this.running = false;
    for (const loop of this.loops.values()) {
      clearInterval(loop);
    }
    this.loops.clear();
  }

  // --------------------------------------------------------------------------
  // REFLEXES
  // --------------------------------------------------------------------------

  /** Register a reflex rule. Reflexes fire synchronously before brain processing. */
  addReflex(rule: ReflexRule): void {
    this.reflexes.push(rule);
  }

  /** Remove a reflex by ID. */
  removeReflex(id: string): void {
    this.reflexes = this.reflexes.filter(r => r.id !== id);
  }

  // --------------------------------------------------------------------------
  // SIGNAL LISTENERS
  // --------------------------------------------------------------------------

  /** Subscribe to all nervous signals. Returns unsubscribe function. */
  onSignal(listener: (signal: NervousSignal) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  // --------------------------------------------------------------------------
  // MONITORING LOOP
  // --------------------------------------------------------------------------

  private monitorOrgan(organ: BodyPart): void {
    const currentHealth = organ.getHealth();
    const previousHealth = this.lastHealthState.get(organ.id);

    // Detect health changes
    if (previousHealth && currentHealth !== previousHealth) {
      const signal = this.createSignal(
        currentHealth === 'failed' ? 'pain' : 'health_change',
        organ.id,
        { previousHealth, currentHealth, organName: organ.name },
        currentHealth === 'failed' ? 0.9 : SIGNAL_SALIENCE.health_change,
      );
      this.emitSignal(signal);
      this.lastHealthState.set(organ.id, currentHealth);
    }

    // Detect affordance changes
    const currentAffordanceCount = organ.isActive() ? organ.getAffordances().length : 0;
    const previousCount = this.lastAffordanceCount.get(organ.id) ?? 0;
    if (currentAffordanceCount !== previousCount) {
      const signal = this.createSignal(
        'affordance_change',
        organ.id,
        { previousCount, currentCount: currentAffordanceCount },
        SIGNAL_SALIENCE.affordance_change,
      );
      this.emitSignal(signal);
      this.lastAffordanceCount.set(organ.id, currentAffordanceCount);
    }
  }

  // --------------------------------------------------------------------------
  // SIGNAL EMISSION PIPELINE
  // --------------------------------------------------------------------------

  private emitSignal(signal: NervousSignal): void {
    // 1. Fire reflexes (synchronous, <10ms)
    for (const reflex of this.reflexes) {
      if (!reflex.enabled) continue;
      if (reflex.trigger.organId && reflex.trigger.organId !== signal.organId) continue;
      if (reflex.trigger.signalType !== signal.type) continue;

      try {
        if (reflex.trigger.condition(signal)) {
          reflex.action(signal);
          signal.reflexHandled = true;
        }
      } catch {
        // Reflex errors are non-fatal but should never happen
      }
    }

    // 2. Notify direct listeners
    for (const listener of this.listeners) {
      try { listener(signal); } catch { /* non-fatal */ }
    }

    // 3. Log to ExperienceStream (async, non-blocking)
    if (this.experienceStream) {
      const experienceType = signal.type === 'pain' || signal.type === 'health_change'
        ? 'body_health_change' as const
        : signal.type === 'reflex_triggered'
          ? 'body_reflex' as const
          : signal.type === 'affordance_change'
            ? 'body_affordance_change' as const
            : 'body_sensation' as const;

      this.experienceStream.append(experienceType, signal, 'orchestrator');
    }

    // 4. Broadcast to GlobalWorkspace if salient enough
    if (this.workspace && signal.salience >= 0.5) {
      this.workspace.broadcast({
        source: `digital-ns:${signal.organId}`,
        type: signal.type === 'pain' ? 'failure' : signal.type === 'reflex_triggered' ? 'warning' : 'discovery',
        content: `${signal.organId}: ${signal.type} — ${JSON.stringify(signal.data)}`.slice(0, 200),
        salience: signal.salience,
        timestamp: signal.timestamp,
      });
    }
  }

  private createSignal(
    type: NervousSignalType,
    organId: string,
    data: unknown,
    salience: number,
  ): NervousSignal {
    return {
      id: crypto.randomUUID(),
      type,
      organId,
      domain: 'digital',
      data,
      timestamp: Date.now(),
      salience,
    };
  }
}
