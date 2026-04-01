import type { DatabaseAdapter } from '../db/adapter-types.js';
import type {
  HormoneType,
  HormoneLevel,
  HormoneProfile,
  HormoneStimulus,
  HormoneEffect,
  EndocrineTone,
  CascadeRule,
} from './types.js';
import { DEFAULT_BASELINES, DEFAULT_CASCADE_RULES } from './types.js';
import { computeCascade } from './hormone-cascade.js';
import { computeEffects, summarizeEffects } from './cross-layer-effects.js';
import { logger } from '../lib/logger.js';

export class EndocrineSystem {
  private hormones: Record<HormoneType, HormoneLevel>;
  private cascadeRules: CascadeRule[];
  private lastCascadeTimes = new Map<string, number>();
  private lastTickTime: number;

  constructor(
    private db: DatabaseAdapter | null,
    private workspaceId: string,
    cascadeRules?: CascadeRule[],
  ) {
    this.cascadeRules = cascadeRules ?? DEFAULT_CASCADE_RULES;
    this.lastTickTime = Date.now();

    // Initialize all hormones at baseline
    const hormoneTypes: HormoneType[] = ['cortisol', 'dopamine', 'serotonin', 'adrenaline', 'oxytocin'];
    this.hormones = {} as Record<HormoneType, HormoneLevel>;
    for (const type of hormoneTypes) {
      const defaults = DEFAULT_BASELINES[type];
      this.hormones[type] = {
        type,
        baseline: defaults.baseline,
        current: defaults.baseline,
        halfLifeMs: defaults.halfLifeMs,
        lastUpdated: Date.now(),
      };
    }
  }

  /**
   * Apply a hormone stimulus. Clamps result to [0, 1].
   * Automatically runs cascades after stimulus.
   */
  stimulate(stimulus: HormoneStimulus): void {
    const level = this.hormones[stimulus.hormone];
    if (!level) return;

    const oldLevel = level.current;
    level.current = Math.max(0, Math.min(1, level.current + stimulus.delta));
    level.lastUpdated = Date.now();

    logger.debug(
      { hormone: stimulus.hormone, old: oldLevel.toFixed(2), new: level.current.toFixed(2), source: stimulus.source },
      'endocrine: stimulus applied',
    );

    // Run cascades
    const cascadeStimuli = computeCascade(this.hormones, this.cascadeRules, this.lastCascadeTimes, Date.now());
    for (const cs of cascadeStimuli) {
      const cascadeLevel = this.hormones[cs.hormone];
      if (cascadeLevel) {
        cascadeLevel.current = Math.max(0, Math.min(1, cascadeLevel.current + cs.delta));
        cascadeLevel.lastUpdated = Date.now();
        logger.debug({ hormone: cs.hormone, delta: cs.delta, reason: cs.reason }, 'endocrine: cascade');
      }
    }
  }

  /**
   * Tick: decay all hormones toward their baselines using half-life.
   * Call this periodically (e.g., every 30s or before reading state).
   */
  tick(): void {
    const now = Date.now();
    const elapsed = now - this.lastTickTime;
    this.lastTickTime = now;

    for (const level of Object.values(this.hormones)) {
      if (level.current === level.baseline) continue;

      // Exponential decay toward baseline
      const diff = level.current - level.baseline;
      const decayFactor = Math.exp(-0.693 * elapsed / level.halfLifeMs); // ln(2) ≈ 0.693
      level.current = level.baseline + diff * decayFactor;

      // Snap to baseline if very close
      if (Math.abs(level.current - level.baseline) < 0.01) {
        level.current = level.baseline;
      }
    }
  }

  /** Get current hormone profile */
  getProfile(): HormoneProfile {
    this.tick(); // ensure up-to-date
    return {
      hormones: { ...this.hormones },
      overallTone: this.computeTone(),
      timestamp: Date.now(),
    };
  }

  /** Get cross-layer effects based on current hormone levels */
  getEffects(): HormoneEffect[] {
    return computeEffects(this.getProfile());
  }

  /**
   * Build prompt injection text for system prompt.
   * Returns null if system is balanced.
   */
  buildPromptContext(): string | null {
    const profile = this.getProfile();
    const effects = computeEffects(profile);

    if (effects.length === 0) return null;

    const tone = profile.overallTone;
    const effectsSummary = summarizeEffects(effects);

    const lines: string[] = [];
    lines.push(`System tone: ${tone}`);
    if (effectsSummary) {
      lines.push(`Active modifiers: ${effectsSummary}`);
    }

    return lines.join('\n');
  }

  /** Get a specific hormone's current level */
  getLevel(hormone: HormoneType): number {
    this.tick();
    return this.hormones[hormone]?.current ?? 0;
  }

  /** Persist current snapshot to database */
  async persistSnapshot(): Promise<void> {
    if (!this.db) return;

    try {
      const profile = this.getProfile();
      await this.db.from('hormone_snapshots').insert({
        workspace_id: this.workspaceId,
        profile: JSON.stringify(profile),
      });
    } catch (err) {
      logger.warn({ err }, 'endocrine: failed to persist snapshot');
    }
  }

  /** Compute overall tone from hormone levels */
  private computeTone(): EndocrineTone {
    const c = this.hormones.cortisol.current;
    const d = this.hormones.dopamine.current;
    const s = this.hormones.serotonin.current;
    const a = this.hormones.adrenaline.current;
    const o = this.hormones.oxytocin.current;

    if (c > 0.6 || a > 0.7) return 'stressed';
    if (a > 0.5 || d > 0.7) return 'alert';
    if (o > 0.6) return 'bonded';
    if (s > 0.6 && d > 0.5) return 'content';
    return 'balanced';
  }
}
