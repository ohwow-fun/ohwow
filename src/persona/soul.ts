/**
 * Soul — Unified Persona Coordinator (Aristotle's Psyche)
 *
 * "The soul is the first actuality of a natural body that has
 * life potentially." — Aristotle, De Anima
 *
 * The Soul ties together chrono-biology, cognitive load,
 * communication style, and agent trust into a single
 * PersonaModel that the Brain uses to adapt its behavior.
 */

import type { PersonaModel, EnergyState, CognitiveLoadState } from './types.js';
import { PersonaObserver, type PersonaPersistence } from './persona-observer.js';
import { formatCommunicationGuidance } from './communication.js';

// ============================================================================
// SOUL
// ============================================================================

export class Soul {
  readonly observer: PersonaObserver;

  constructor(persistence?: PersonaPersistence) {
    this.observer = new PersonaObserver(persistence);
  }

  /** Hydrate from persistence on startup. */
  async hydrate(): Promise<number> {
    return this.observer.hydrate();
  }

  /** Get the full persona model. */
  getPersona(liveData?: { openApprovals: number; openTasks: number }): PersonaModel {
    return this.observer.computePersona(liveData);
  }

  /** Get current energy state. */
  getEnergyState(): EnergyState {
    return this.observer.getEnergyState();
  }

  /** Get current cognitive load. */
  getCognitiveLoad(openApprovals: number, openTasks: number): CognitiveLoadState {
    return this.observer.getCurrentLoad(openApprovals, openTasks);
  }

  /** Should we add more work? */
  shouldAddWork(openApprovals: number, openTasks: number): boolean {
    return this.observer.shouldAddWork(openApprovals, openTasks);
  }

  /**
   * Build a persona context string for system prompt injection.
   * Returns null if not enough data.
   */
  buildPromptContext(liveData?: { openApprovals: number; openTasks: number }): string | null {
    const persona = this.getPersona(liveData);

    if (persona.dataPoints < 10) return null; // not enough data yet

    const parts: string[] = [];

    // Energy state
    const energyLabel = {
      peak: 'peak energy',
      normal: 'normal energy',
      low: 'low energy (energy trough)',
      rest: 'off hours (likely resting)',
    }[persona.energyState];
    parts.push(`The human is currently at ${energyLabel}.`);

    // Cognitive load
    if (persona.cognitiveLoad.level === 'overloaded') {
      parts.push('They are overloaded. Do not add new tasks. Only surface critical items.');
    } else if (persona.cognitiveLoad.level === 'high') {
      parts.push('Their cognitive load is high. Keep responses focused. Avoid adding low-priority work.');
    }

    // Communication style
    const commGuidance = formatCommunicationGuidance(persona.communication);
    if (commGuidance) parts.push(commGuidance);

    // Work intensity
    if (persona.workIntensity === 'sprint') {
      parts.push('They have been working intensely. Be efficient.');
    } else if (persona.workIntensity === 'recovery') {
      parts.push('They seem to be in a light period. Good time for reflective or strategic work.');
    }

    return parts.length > 0 ? parts.join(' ') : null;
  }
}
