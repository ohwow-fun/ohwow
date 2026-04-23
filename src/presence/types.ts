/**
 * Presence Types — Ambient Awareness (Heidegger's Being-in-the-World)
 *
 * "The world is always already there before we begin to think about it."
 * — Martin Heidegger
 *
 * Presence is the agent's awareness of the user's physical proximity.
 * The phone serves as the agent's eye — a body organ for visual awareness.
 * When the user arrives at their desk, the agent perceives this through
 * the eye and responds with a proactive greeting, transitioning into
 * always-listening voice mode.
 */

// ============================================================================
// PRESENCE STATE MACHINE
// ============================================================================

/**
 * States the presence engine can be in.
 *
 * absent → arriving → present → greeting → voice_active → idle → absent
 *
 * - absent: No user detected. Inner thoughts loop runs in background.
 * - arriving: Face detected by phone eye, not yet confirmed (< 3s).
 * - present: Confirmed presence (3s+ continuous detection). Greeting assembles.
 * - greeting: TTS is speaking the greeting to the user.
 * - voice_active: Greeting done, always-listening voice mode is on.
 * - idle: User present but inactive for 5+ minutes. Voice stays hot.
 */
export type PresenceState =
  | 'absent'
  | 'arriving'
  | 'present'
  | 'greeting'
  | 'voice_active'
  | 'idle';

// ============================================================================
// PRESENCE EVENTS — From phone eye to local runtime
// ============================================================================

export type PresenceEventType = 'arrival' | 'departure' | 'still_here';

// PresenceEventPayload is defined in control-plane/types.ts (canonical source).
// Re-export for convenience.
export type { PresenceEventPayload } from '../control-plane/types.js';

// ============================================================================
// INNER THOUGHTS — Background context accumulation
// ============================================================================

export interface ThoughtEntry {
  id: string;
  /** The distilled insight (one sentence). */
  content: string;
  /** What category this thought falls into. */
  category: 'task' | 'message' | 'agent_activity' | 'calendar' | 'anomaly' | 'insight';
  /** How important this is for the greeting (0-1). */
  salience: number;
  /** When this thought was generated. */
  timestamp: number;
  /** Raw context data that produced this thought. */
  sourceData?: Record<string, unknown>;
}

export interface ContextSnapshot {
  pendingTasks: Array<{ id: string; title: string; agentName: string; priority?: string }>;
  recentCompletions: Array<{ title: string; agentName: string; completedAt: string }>;
  unreadMessages: Array<{ channel: string; from: string; preview: string }>;
  overnightActivity: {
    tasksCompleted: number;
    tasksStarted: number;
    errors: number;
  };
  /** Time since last user activity (ms). */
  userIdleMs: number;
  /** Current time of day context. */
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
  /** Number of peer nodes currently in the mesh (including self). 1 = solo operation. */
  connectedPeerCount: number;
}

// ============================================================================
// GREETING — Assembled from inner thoughts
// ============================================================================

export interface AssembledGreeting {
  /** The spoken greeting text. */
  text: string;
  /** Suggested next actions. */
  nextSteps: string[];
  /** Urgent items requiring immediate attention. */
  urgentItems: string[];
  /** Thoughts that contributed to this greeting. */
  sourceThoughts: ThoughtEntry[];
}

// ============================================================================
// PROACTIVE GATE — Should I greet? (LLAMAPIE two-model pattern)
// ============================================================================

export interface ProactiveDecision {
  shouldGreet: boolean;
  /** How urgent is the greeting (0-1). Feeds into interruption timing. */
  urgency: number;
  /** Brief reason for the decision (for logging). */
  reason?: string;
}
