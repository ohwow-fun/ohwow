/**
 * SleepCycle — State machine managing sleep phase transitions.
 * Models biological ultradian rhythms: wake → drowsy → light → deep → REM → (cycle or wake).
 */

import { logger } from '../lib/logger.js';
import type { SleepPhase, SleepState, SleepDebtFactors } from './types.js';
import { PHASE_CONFIG } from './types.js';

const MS_PER_MINUTE = 60_000;

export class SleepCycle {
  private phase: SleepPhase = 'wake';
  private sleepDebt = 0;
  private lastConsolidation = 0;
  private lastDream = 0;
  private cycleCount = 0;
  private enteredPhaseAt = Date.now();

  /**
   * Advance phase based on accumulated idle time.
   * Returns the new phase after evaluation.
   */
  tick(idleTimeMs: number): SleepPhase {
    const idleMinutes = idleTimeMs / MS_PER_MINUTE;
    const phaseMinutes = (Date.now() - this.enteredPhaseAt) / MS_PER_MINUTE;

    switch (this.phase) {
      case 'wake':
        if (idleMinutes >= PHASE_CONFIG.idleToDrowsy) {
          this.transitionTo('drowsy');
        }
        break;

      case 'drowsy':
        if (phaseMinutes >= PHASE_CONFIG.drowsyToLight) {
          this.transitionTo('light_sleep');
        }
        break;

      case 'light_sleep':
        if (phaseMinutes >= PHASE_CONFIG.lightToDeep) {
          this.transitionTo('deep_sleep');
        }
        break;

      case 'deep_sleep':
        if (phaseMinutes >= PHASE_CONFIG.deepToREM) {
          this.transitionTo('REM');
        }
        break;

      case 'REM':
        if (phaseMinutes >= PHASE_CONFIG.remToLight) {
          this.cycleCount++;
          if (this.cycleCount >= PHASE_CONFIG.maxCycles) {
            this.transitionTo('waking');
          } else {
            this.transitionTo('light_sleep');
          }
        }
        break;

      case 'waking':
        this.transitionTo('wake');
        break;
    }

    return this.phase;
  }

  /** Immediately return to wake phase. */
  wake(reason: string): void {
    logger.info({ from: this.phase, reason }, 'oneiros: forced wake');
    this.phase = 'wake';
    this.cycleCount = 0;
    this.enteredPhaseAt = Date.now();
  }

  /** Current sleep state snapshot. */
  getState(): SleepState {
    return {
      phase: this.phase,
      sleepDebt: this.sleepDebt,
      lastConsolidation: this.lastConsolidation,
      lastDream: this.lastDream,
      cycleCount: this.cycleCount,
      enteredPhaseAt: this.enteredPhaseAt,
    };
  }

  /** True when in any sleep phase (not wake or waking). */
  isAsleep(): boolean {
    return this.phase !== 'wake' && this.phase !== 'waking';
  }

  /** True only during deep_sleep — time for memory consolidation. */
  shouldConsolidate(): boolean {
    return this.phase === 'deep_sleep';
  }

  /** True only during REM — time for creative dreaming. */
  shouldDream(): boolean {
    return this.phase === 'REM';
  }

  /**
   * Compute sleep debt from environmental factors.
   * Returns a value clamped to 0-1.
   */
  computeSleepDebt(factors: SleepDebtFactors): number {
    const experienceWeight = Math.min(factors.experiencesSinceLastSleep / 100, 1) * 0.4;
    const timeWeight = Math.min(factors.hoursSinceLastConsolidation / 24, 1) * 0.3;
    const pressureWeight = factors.memoryPressure * 0.3;

    this.sleepDebt = Math.min(1, Math.max(0, experienceWeight + timeWeight + pressureWeight));
    return this.sleepDebt;
  }

  /** Record that consolidation just occurred. */
  markConsolidation(): void {
    this.lastConsolidation = Date.now();
  }

  /** Record that dreaming just occurred. */
  markDream(): void {
    this.lastDream = Date.now();
  }

  private transitionTo(next: SleepPhase): void {
    logger.info({ from: this.phase, to: next, cycleCount: this.cycleCount }, 'oneiros: phase transition');
    this.phase = next;
    this.enteredPhaseAt = Date.now();
  }
}
