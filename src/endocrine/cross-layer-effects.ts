import type { HormoneProfile, HormoneEffect } from './types.js';

/**
 * Compute cross-layer effects from current hormone profile.
 * Each effect is a multiplier that the target layer should apply.
 * < 1 = suppressed, 1 = normal, > 1 = amplified.
 */
export function computeEffects(profile: HormoneProfile): HormoneEffect[] {
  const effects: HormoneEffect[] = [];
  const h = profile.hormones;

  // === CORTISOL (stress -> caution) ===
  if (h.cortisol.current > 0.6) {
    effects.push({
      targetLayer: 'brain',
      parameter: 'dialectic_threshold',
      modifier: 0.7, // lower threshold = more counter-argument checking
      reason: 'Elevated cortisol: increase caution in planning',
    });
    effects.push({
      targetLayer: 'work',
      parameter: 'ambition',
      modifier: 0.8,
      reason: 'Elevated cortisol: reduce task complexity',
    });
    effects.push({
      targetLayer: 'symbiosis',
      parameter: 'handoff_threshold',
      modifier: 0.7,
      reason: 'Elevated cortisol: ask for help sooner',
    });
  }

  // === DOPAMINE (reward -> reinforcement) ===
  if (h.dopamine.current > 0.7) {
    effects.push({
      targetLayer: 'brain',
      parameter: 'prediction_confidence',
      modifier: 1.2,
      reason: 'Elevated dopamine: increased confidence from recent success',
    });
    effects.push({
      targetLayer: 'work',
      parameter: 'ambition',
      modifier: 1.15,
      reason: 'Elevated dopamine: ready for more challenging work',
    });
  }

  // === SEROTONIN (stability -> contentment) ===
  if (h.serotonin.current > 0.7) {
    effects.push({
      targetLayer: 'work',
      parameter: 'stability',
      modifier: 1.2,
      reason: 'High serotonin: stable execution, resist unnecessary change',
    });
  }
  if (h.serotonin.current < 0.2) {
    effects.push({
      targetLayer: 'brain',
      parameter: 'exploration',
      modifier: 1.3,
      reason: 'Low serotonin: restless, seek new approaches',
    });
  }

  // === ADRENALINE (urgency -> focus) ===
  if (h.adrenaline.current > 0.6) {
    effects.push({
      targetLayer: 'brain',
      parameter: 'focus',
      modifier: 1.3,
      reason: 'Elevated adrenaline: heightened focus on immediate task',
    });
    effects.push({
      targetLayer: 'body',
      parameter: 'reflex_speed',
      modifier: 1.2,
      reason: 'Elevated adrenaline: faster nervous system response',
    });
  }

  // === OXYTOCIN (bonding -> trust) ===
  if (h.oxytocin.current > 0.6) {
    effects.push({
      targetLayer: 'symbiosis',
      parameter: 'trust_extension',
      modifier: 1.2,
      reason: 'Elevated oxytocin: extend trust more readily',
    });
    effects.push({
      targetLayer: 'soul',
      parameter: 'relationship_health',
      modifier: 1.1,
      reason: 'Elevated oxytocin: strengthened bond',
    });
  }

  return effects;
}

/**
 * Summarize active effects for prompt injection.
 * Returns null if system is balanced (no notable effects).
 */
export function summarizeEffects(effects: HormoneEffect[]): string | null {
  if (effects.length === 0) return null;

  const lines = effects.slice(0, 5).map(e => e.reason);
  return lines.join('. ') + '.';
}
