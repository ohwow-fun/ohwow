import { describe, it, expect, beforeEach } from 'vitest';
import { computeCascade } from '../hormone-cascade.js';
import { computeEffects, summarizeEffects } from '../cross-layer-effects.js';
import { EndocrineSystem } from '../endocrine-system.js';
import type { HormoneLevel, CascadeRule, HormoneProfile } from '../types.js';
import { DEFAULT_BASELINES } from '../types.js';

function makeHormones(overrides: Partial<Record<string, { current: number }>> = {}): Record<string, HormoneLevel> {
  const result: Record<string, HormoneLevel> = {};
  for (const [type, defaults] of Object.entries(DEFAULT_BASELINES)) {
    result[type] = {
      type: type as any,
      baseline: defaults.baseline,
      current: overrides[type]?.current ?? defaults.baseline,
      halfLifeMs: defaults.halfLifeMs,
      lastUpdated: Date.now(),
    };
  }
  return result;
}

describe('hormone-cascade', () => {
  it('should trigger cascade when threshold exceeded', () => {
    const hormones = makeHormones({ cortisol: { current: 0.8 } });
    const rules: CascadeRule[] = [
      { trigger: { hormone: 'cortisol', condition: 'above', threshold: 0.7 }, effect: { hormone: 'adrenaline', delta: 0.2 }, cooldownMs: 0 },
    ];
    const stimuli = computeCascade(hormones, rules, new Map(), Date.now());
    expect(stimuli.length).toBe(1);
    expect(stimuli[0].hormone).toBe('adrenaline');
    expect(stimuli[0].delta).toBe(0.2);
  });

  it('should not trigger when below threshold', () => {
    const hormones = makeHormones({ cortisol: { current: 0.3 } });
    const rules: CascadeRule[] = [
      { trigger: { hormone: 'cortisol', condition: 'above', threshold: 0.7 }, effect: { hormone: 'adrenaline', delta: 0.2 }, cooldownMs: 0 },
    ];
    const stimuli = computeCascade(hormones, rules, new Map(), Date.now());
    expect(stimuli.length).toBe(0);
  });

  it('should respect cooldown period', () => {
    const hormones = makeHormones({ cortisol: { current: 0.8 } });
    const rules: CascadeRule[] = [
      { trigger: { hormone: 'cortisol', condition: 'above', threshold: 0.7 }, effect: { hormone: 'adrenaline', delta: 0.2 }, cooldownMs: 60_000 },
    ];
    const lastTimes = new Map<string, number>();
    const now = Date.now();

    // First cascade fires
    const stimuli1 = computeCascade(hormones, rules, lastTimes, now);
    expect(stimuli1.length).toBe(1);

    // Second cascade blocked by cooldown
    const stimuli2 = computeCascade(hormones, rules, lastTimes, now + 1000);
    expect(stimuli2.length).toBe(0);

    // After cooldown, fires again
    const stimuli3 = computeCascade(hormones, rules, lastTimes, now + 61_000);
    expect(stimuli3.length).toBe(1);
  });

  it('should handle below condition', () => {
    const hormones = makeHormones({ serotonin: { current: 0.1 } });
    const rules: CascadeRule[] = [
      { trigger: { hormone: 'serotonin', condition: 'below', threshold: 0.2 }, effect: { hormone: 'cortisol', delta: 0.1 }, cooldownMs: 0 },
    ];
    const stimuli = computeCascade(hormones, rules, new Map(), Date.now());
    expect(stimuli.length).toBe(1);
    expect(stimuli[0].hormone).toBe('cortisol');
  });
});

describe('cross-layer-effects', () => {
  it('should produce effects for elevated cortisol', () => {
    const profile: HormoneProfile = {
      hormones: makeHormones({ cortisol: { current: 0.8 } }) as any,
      overallTone: 'stressed',
      timestamp: Date.now(),
    };
    const effects = computeEffects(profile);
    expect(effects.length).toBeGreaterThan(0);
    expect(effects.some(e => e.targetLayer === 'brain')).toBe(true);
    expect(effects.some(e => e.modifier < 1)).toBe(true); // suppression
  });

  it('should produce effects for elevated dopamine', () => {
    const profile: HormoneProfile = {
      hormones: makeHormones({ dopamine: { current: 0.8 } }) as any,
      overallTone: 'alert',
      timestamp: Date.now(),
    };
    const effects = computeEffects(profile);
    expect(effects.some(e => e.modifier > 1)).toBe(true); // amplification
  });

  it('should return no effects when balanced', () => {
    const profile: HormoneProfile = {
      hormones: makeHormones() as any,
      overallTone: 'balanced',
      timestamp: Date.now(),
    };
    const effects = computeEffects(profile);
    expect(effects.length).toBe(0);
  });

  it('should summarize effects', () => {
    const effects = [
      { targetLayer: 'brain' as const, parameter: 'caution', modifier: 0.7, reason: 'Elevated cortisol: increase caution' },
    ];
    const summary = summarizeEffects(effects);
    expect(summary).toContain('cortisol');
  });

  it('should return null summary when no effects', () => {
    expect(summarizeEffects([])).toBeNull();
  });
});

describe('EndocrineSystem', () => {
  let system: EndocrineSystem;

  beforeEach(() => {
    system = new EndocrineSystem(null, 'test-workspace');
  });

  it('should initialize at baselines', () => {
    const profile = system.getProfile();
    expect(profile.overallTone).toBe('balanced');
    expect(profile.hormones.cortisol.current).toBeCloseTo(0.2, 1);
    expect(profile.hormones.dopamine.current).toBeCloseTo(0.4, 1);
  });

  it('should apply stimulus and clamp to [0,1]', () => {
    system.stimulate({ hormone: 'cortisol', delta: 0.5, source: 'test', reason: 'test' });
    expect(system.getLevel('cortisol')).toBeCloseTo(0.7, 1);

    system.stimulate({ hormone: 'cortisol', delta: 0.5, source: 'test', reason: 'test' });
    expect(system.getLevel('cortisol')).toBeLessThanOrEqual(1.0);
  });

  it('should not go below 0', () => {
    system.stimulate({ hormone: 'dopamine', delta: -1, source: 'test', reason: 'test' });
    expect(system.getLevel('dopamine')).toBeCloseTo(0, 5);
  });

  it('should trigger cascades on high cortisol', () => {
    system.stimulate({ hormone: 'cortisol', delta: 0.6, source: 'test', reason: 'test' });
    // Cascade: cortisol > 0.7 -> adrenaline +0.2, dopamine -0.15
    const adrenaline = system.getLevel('adrenaline');
    expect(adrenaline).toBeGreaterThan(DEFAULT_BASELINES.adrenaline.baseline);
  });

  it('should compute correct tone', () => {
    system.stimulate({ hormone: 'cortisol', delta: 0.6, source: 'test', reason: 'stress' });
    expect(system.getProfile().overallTone).toBe('stressed');
  });

  it('should produce effects for stressed state', () => {
    system.stimulate({ hormone: 'cortisol', delta: 0.5, source: 'test', reason: 'stress' });
    const effects = system.getEffects();
    expect(effects.length).toBeGreaterThan(0);
  });

  it('should build prompt context when not balanced', () => {
    system.stimulate({ hormone: 'cortisol', delta: 0.5, source: 'test', reason: 'stress' });
    const ctx = system.buildPromptContext();
    expect(ctx).not.toBeNull();
    expect(ctx).toContain('stressed');
  });

  it('should return null prompt context when balanced', () => {
    const ctx = system.buildPromptContext();
    expect(ctx).toBeNull();
  });

  it('should compute bonded tone with high oxytocin', () => {
    system.stimulate({ hormone: 'oxytocin', delta: 0.4, source: 'test', reason: 'bonding' });
    expect(system.getProfile().overallTone).toBe('bonded');
  });
});
