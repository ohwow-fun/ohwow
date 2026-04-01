import type { HormoneLevel, HormoneStimulus, CascadeRule } from './types.js';

/**
 * Compute cascade effects from current hormone levels.
 * Cascades are secondary hormone changes triggered by primary levels.
 * Returns additional stimuli to apply.
 */
export function computeCascade(
  hormones: Record<string, HormoneLevel>,
  rules: CascadeRule[],
  lastCascadeTimes: Map<string, number>,
  now: number,
): HormoneStimulus[] {
  const stimuli: HormoneStimulus[] = [];

  for (const rule of rules) {
    const level = hormones[rule.trigger.hormone];
    if (!level) continue;

    // Check condition
    const triggered = rule.trigger.condition === 'above'
      ? level.current > rule.trigger.threshold
      : level.current < rule.trigger.threshold;

    if (!triggered) continue;

    // Check cooldown
    const ruleKey = `${rule.trigger.hormone}:${rule.trigger.condition}:${rule.effect.hormone}`;
    const lastFired = lastCascadeTimes.get(ruleKey) ?? 0;
    if (now - lastFired < rule.cooldownMs) continue;

    lastCascadeTimes.set(ruleKey, now);

    stimuli.push({
      hormone: rule.effect.hormone,
      delta: rule.effect.delta,
      source: 'cascade',
      reason: `${rule.trigger.hormone} ${rule.trigger.condition} ${rule.trigger.threshold}`,
    });
  }

  return stimuli;
}
