/**
 * Presence Engine — State Machine + Proactive Gate
 *
 * "Dasein is always already in-the-world."
 * — Martin Heidegger, Being and Time
 *
 * The presence engine manages the user's physical proximity state
 * and orchestrates the greeting → voice activation flow.
 *
 * State machine: absent → arriving → present → greeting → voice_active → idle → absent
 *
 * Two-model proactive gate (LLAMAPIE pattern, arxiv 2505.04066):
 * 1. Small model decides IF to greet (fast, cheap)
 * 2. Large model assembles WHAT to say (only if gate passes)
 *
 * Interruption timing (ProMemAssist, arxiv 2507.21378):
 * - Fresh arrival (user was idle): greet immediately
 * - User was already active: delay 10s to avoid interruption
 */

import { EventEmitter } from 'node:events';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { ModelRouter } from '../execution/model-router.js';
import type { GlobalWorkspace } from '../brain/global-workspace.js';
import type { NervousSystem } from '../body/nervous-system.js';
import type { VoiceSession } from '../voice/voice-session.js';
import type { InnerThoughtsLoop } from './inner-thoughts.js';
import { GreetingAssembler } from './greeting-assembler.js';
import type {
  PresenceState,
  PresenceEventPayload,
  ProactiveDecision,
  AssembledGreeting,
} from './types.js';
import { getFleetSensingData } from '../lib/device-info.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** How long face must be detected before confirming presence (ms). */
const ARRIVAL_CONFIRM_MS = 3000;

/** How long without detection before marking absent (ms). */
const DEPARTURE_TIMEOUT_MS = 30_000;

/** How long without interaction before marking idle (ms). */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Delay greeting when user was already at screen (interruption avoidance). */
const ACTIVE_USER_DELAY_MS = 10_000;

/** Minimum confidence from the proactive gate to proceed with greeting. */
const PROACTIVE_THRESHOLD = 0.6;

// ============================================================================
// PRESENCE ENGINE
// ============================================================================

export interface PresenceEngineOptions {
  innerThoughts: InnerThoughtsLoop;
  workspace: GlobalWorkspace;
  nervousSystem?: NervousSystem;
  modelRouter: ModelRouter;
  db: DatabaseAdapter;
  workspaceId: string;
  /** Factory to create and start a voice session for greeting + always-listening. */
  voiceSessionFactory?: () => Promise<VoiceSession>;
}

export class PresenceEngine extends EventEmitter {
  private state: PresenceState = 'absent';
  private innerThoughts: InnerThoughtsLoop;
  private greetingAssembler: GreetingAssembler;
  private workspace: GlobalWorkspace;
  private nervousSystem?: NervousSystem;
  private modelRouter: ModelRouter;
  private voiceSessionFactory?: () => Promise<VoiceSession>;
  private activeVoiceSession: VoiceSession | null = null;

  private arrivalTimer: ReturnType<typeof setTimeout> | null = null;
  private departureTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDetectionTime = 0;

  constructor(opts: PresenceEngineOptions) {
    super();
    this.innerThoughts = opts.innerThoughts;
    this.workspace = opts.workspace;
    this.nervousSystem = opts.nervousSystem;
    this.modelRouter = opts.modelRouter;
    this.voiceSessionFactory = opts.voiceSessionFactory;

    this.greetingAssembler = new GreetingAssembler(
      opts.db,
      opts.innerThoughts,
      opts.modelRouter,
      opts.workspaceId,
    );
  }

  // --------------------------------------------------------------------------
  // PUBLIC API
  // --------------------------------------------------------------------------

  getState(): PresenceState {
    return this.state;
  }

  getLastDetection(): number | null {
    return this.lastDetectionTime || null;
  }

  isActive(): boolean {
    return this.state !== 'absent';
  }

  /**
   * Handle a presence event from the phone eye (via control plane).
   */
  handlePresenceEvent(event: PresenceEventPayload): void {
    this.lastDetectionTime = event.timestamp || Date.now();

    logger.info(
      { eventType: event.eventType, confidence: event.confidence, state: this.state },
      '[Presence] Event received',
    );

    switch (event.eventType) {
      case 'arrival':
        this.handleArrival(event.confidence);
        break;
      case 'departure':
        this.handleDeparture();
        break;
      case 'still_here':
        this.handleStillHere();
        break;
    }
  }

  /**
   * Handle macOS idle state changes (from fleet sensing).
   */
  handleIdleChange(userActive: boolean): void {
    if (!userActive && (this.state === 'voice_active' || this.state === 'present')) {
      this.startIdleTimer();
    }
    if (userActive && this.state === 'idle') {
      this.transitionTo('voice_active');
    }
  }

  /** Stop all timers and reset state. */
  shutdown(): void {
    this.clearAllTimers();
    this.state = 'absent';
    this.activeVoiceSession = null;
  }

  // --------------------------------------------------------------------------
  // EVENT HANDLERS
  // --------------------------------------------------------------------------

  private handleArrival(confidence: number): void {
    if (this.state === 'absent') {
      // Start arrival confirmation timer
      this.transitionTo('arriving');
      this.clearTimer('departure');

      this.arrivalTimer = setTimeout(() => {
        if (this.state === 'arriving') {
          this.confirmArrival();
        }
      }, ARRIVAL_CONFIRM_MS);

    } else if (this.state === 'arriving') {
      // Already in arriving state, reset departure timer
      this.clearTimer('departure');

    } else if (this.state === 'idle') {
      // User came back from idle
      this.clearTimer('departure');
      this.transitionTo('voice_active');
    }
  }

  private handleDeparture(): void {
    if (this.state === 'absent') return;

    // Don't immediately transition — start a departure timer
    if (!this.departureTimer) {
      this.departureTimer = setTimeout(() => {
        this.departureTimer = null;
        if (this.state !== 'absent') {
          this.transitionTo('absent');
          this.cleanupVoiceSession();
        }
      }, DEPARTURE_TIMEOUT_MS);
    }
  }

  private handleStillHere(): void {
    // Reset departure timer if running
    this.clearTimer('departure');

    // Reset idle timer
    if (this.state === 'voice_active' || this.state === 'present') {
      this.resetIdleTimer();
    }
  }

  // --------------------------------------------------------------------------
  // ARRIVAL CONFIRMATION + GREETING
  // --------------------------------------------------------------------------

  private async confirmArrival(): Promise<void> {
    this.transitionTo('present');

    // Broadcast high-salience signal to the brain
    this.workspace.broadcastSignal('presence', 'User arrived at desk', 0.9);

    // Check interruption timing
    const sensing = await getFleetSensingData(true);
    const wasAlreadyActive = sensing.userActive && sensing.screenActive;

    if (wasAlreadyActive) {
      // User was already at screen — delay to avoid interruption
      logger.info('[Presence] User was already active, delaying greeting');
      await new Promise(resolve => setTimeout(resolve, ACTIVE_USER_DELAY_MS));
    }

    // Proactive gate: should we greet?
    const decision = await this.shouldGreet();

    if (!decision.shouldGreet) {
      logger.info(`[Presence] Proactive gate declined greeting: ${decision.reason}`);
      this.transitionTo('voice_active');
      this.activateVoice(null);
      return;
    }

    // Assemble and speak greeting
    try {
      this.transitionTo('greeting');
      const greeting = await this.greetingAssembler.assembleGreeting();
      this.emit('greeting', greeting);

      logger.info(
        { urgentItems: greeting.urgentItems.length, nextSteps: greeting.nextSteps.length },
        `[Presence] Greeting: ${greeting.text.slice(0, 100)}...`,
      );

      // Speak the greeting via voice session
      await this.activateVoice(greeting);

      // Clear inner thoughts that were consumed by the greeting
      this.innerThoughts.clearThoughts();

      this.transitionTo('voice_active');
      this.startIdleTimer();
    } catch (err) {
      logger.error(`[Presence] Greeting failed: ${err instanceof Error ? err.message : err}`);
      this.transitionTo('voice_active');
      this.activateVoice(null);
    }
  }

  // --------------------------------------------------------------------------
  // PROACTIVE GATE — Small model decides if/when to greet
  // --------------------------------------------------------------------------

  private async shouldGreet(): Promise<ProactiveDecision> {
    const thoughts = this.innerThoughts.getThoughts(5);

    // If there are no thoughts, still greet with a simple hello
    if (thoughts.length === 0) {
      return { shouldGreet: true, urgency: 0.3, reason: 'No context but user arrived' };
    }

    // Check if there's anything urgent
    const hasUrgent = thoughts.some(t => t.salience >= 0.8);
    if (hasUrgent) {
      return { shouldGreet: true, urgency: 0.9, reason: 'Urgent items detected' };
    }

    // Use a quick heuristic rather than an LLM call for the gate
    // (saves latency — the LLM is used for the greeting content itself)
    const avgSalience = thoughts.reduce((sum, t) => sum + t.salience, 0) / thoughts.length;
    if (avgSalience >= PROACTIVE_THRESHOLD) {
      return { shouldGreet: true, urgency: avgSalience, reason: 'Salient context available' };
    }

    // Low salience — still greet but note it's a casual one
    return { shouldGreet: true, urgency: avgSalience, reason: 'Casual greeting' };
  }

  // --------------------------------------------------------------------------
  // VOICE ACTIVATION
  // --------------------------------------------------------------------------

  private async activateVoice(greeting: AssembledGreeting | null): Promise<void> {
    if (!this.voiceSessionFactory) {
      logger.debug('[Presence] No voice session factory configured, skipping voice activation');
      return;
    }

    try {
      if (!this.activeVoiceSession) {
        this.activeVoiceSession = await this.voiceSessionFactory();
      }

      // If we have a greeting, speak it first
      if (greeting && this.activeVoiceSession) {
        this.emit('speak', greeting.text);
        // The actual TTS is handled by the voice session or the WebSocket voice handler
        // We emit the event so the daemon can route it appropriately
      }
    } catch (err) {
      logger.warn(`[Presence] Voice activation failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private cleanupVoiceSession(): void {
    if (this.activeVoiceSession) {
      this.activeVoiceSession = null;
      this.emit('voice_deactivated');
    }
  }

  // --------------------------------------------------------------------------
  // STATE MACHINE
  // --------------------------------------------------------------------------

  private transitionTo(newState: PresenceState): void {
    const oldState = this.state;
    if (oldState === newState) return;

    this.state = newState;
    this.emit('state:changed', { from: oldState, to: newState });

    logger.info(`[Presence] ${oldState} → ${newState}`);

    // Broadcast to nervous system
    if (newState === 'present' || newState === 'arriving') {
      this.workspace.broadcast({
        source: 'presence',
        type: 'signal',
        content: `User presence: ${newState}`,
        salience: newState === 'present' ? 0.9 : 0.5,
        timestamp: Date.now(),
      });
    }

    if (newState === 'absent') {
      this.workspace.broadcast({
        source: 'presence',
        type: 'signal',
        content: 'User departed',
        salience: 0.5,
        timestamp: Date.now(),
      });
    }
  }

  // --------------------------------------------------------------------------
  // TIMERS
  // --------------------------------------------------------------------------

  private startIdleTimer(): void {
    this.clearTimer('idle');
    this.idleTimer = setTimeout(() => {
      if (this.state === 'voice_active' || this.state === 'present') {
        this.transitionTo('idle');
      }
    }, IDLE_TIMEOUT_MS);
  }

  private resetIdleTimer(): void {
    this.startIdleTimer();
  }

  private clearTimer(which: 'arrival' | 'departure' | 'idle'): void {
    switch (which) {
      case 'arrival':
        if (this.arrivalTimer) { clearTimeout(this.arrivalTimer); this.arrivalTimer = null; }
        break;
      case 'departure':
        if (this.departureTimer) { clearTimeout(this.departureTimer); this.departureTimer = null; }
        break;
      case 'idle':
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        break;
    }
  }

  private clearAllTimers(): void {
    this.clearTimer('arrival');
    this.clearTimer('departure');
    this.clearTimer('idle');
  }
}
