/**
 * Endocrine System — Spinoza's conatus + homeostatic drive
 * Global state modulator: hormones cross all architectural boundaries.
 */

export type HormoneType = 'cortisol' | 'dopamine' | 'serotonin' | 'adrenaline' | 'oxytocin';

export interface HormoneLevel {
  type: HormoneType;
  baseline: number;      // 0-1, "normal" resting level
  current: number;       // 0-1, actual level right now
  halfLifeMs: number;    // how fast it decays toward baseline
  lastUpdated: number;   // epoch ms
}

export interface HormoneProfile {
  hormones: Record<HormoneType, HormoneLevel>;
  overallTone: EndocrineTone;
  timestamp: number;
}

export type EndocrineTone = 'stressed' | 'alert' | 'balanced' | 'content' | 'bonded';

export interface HormoneEffect {
  targetLayer: 'brain' | 'body' | 'work' | 'soul' | 'symbiosis' | 'bios';
  parameter: string;      // what aspect is affected
  modifier: number;       // multiplier: <1 suppresses, >1 amplifies
  reason: string;
}

export interface HormoneStimulus {
  hormone: HormoneType;
  delta: number;          // change amount, clamped to [-1, 1]
  source: string;         // what caused this stimulus
  reason: string;
}

export interface CascadeRule {
  trigger: {
    hormone: HormoneType;
    condition: 'above' | 'below';
    threshold: number;
  };
  effect: {
    hormone: HormoneType;
    delta: number;
  };
  cooldownMs: number;     // prevent cascade loops
}

/** Default hormone baselines */
export const DEFAULT_BASELINES: Record<HormoneType, { baseline: number; halfLifeMs: number }> = {
  cortisol:   { baseline: 0.2, halfLifeMs: 300_000 },    // 5 min half-life
  dopamine:   { baseline: 0.4, halfLifeMs: 180_000 },    // 3 min half-life
  serotonin:  { baseline: 0.5, halfLifeMs: 600_000 },    // 10 min half-life (slow, stable)
  adrenaline: { baseline: 0.1, halfLifeMs: 120_000 },    // 2 min half-life (fast spike, fast decay)
  oxytocin:   { baseline: 0.3, halfLifeMs: 900_000 },    // 15 min half-life (slow bonding)
};

/** Default cascade rules */
export const DEFAULT_CASCADE_RULES: CascadeRule[] = [
  // High cortisol triggers adrenaline
  { trigger: { hormone: 'cortisol', condition: 'above', threshold: 0.7 }, effect: { hormone: 'adrenaline', delta: 0.2 }, cooldownMs: 60_000 },
  // High cortisol suppresses dopamine
  { trigger: { hormone: 'cortisol', condition: 'above', threshold: 0.7 }, effect: { hormone: 'dopamine', delta: -0.15 }, cooldownMs: 60_000 },
  // High dopamine boosts serotonin
  { trigger: { hormone: 'dopamine', condition: 'above', threshold: 0.8 }, effect: { hormone: 'serotonin', delta: 0.1 }, cooldownMs: 120_000 },
  // High adrenaline feeds cortisol (stress spiral)
  { trigger: { hormone: 'adrenaline', condition: 'above', threshold: 0.8 }, effect: { hormone: 'cortisol', delta: 0.1 }, cooldownMs: 120_000 },
  // Low serotonin increases cortisol (unhappiness -> stress)
  { trigger: { hormone: 'serotonin', condition: 'below', threshold: 0.2 }, effect: { hormone: 'cortisol', delta: 0.1 }, cooldownMs: 300_000 },
];
