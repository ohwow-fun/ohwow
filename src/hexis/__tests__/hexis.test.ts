import { describe, it, expect } from 'vitest';
import { detectCues } from '../cue-detector.js';
import { computeStrength, computeAutomaticity, decayHabitStrength } from '../habit-strength.js';
import { detectBadHabits } from '../bad-habit-detector.js';
import { HabitEngine } from '../habit-engine.js';
import type { Habit } from '../types.js';

function makeHabit(overrides: Partial<Habit> = {}): Habit {
  return {
    id: 'h1',
    name: 'test habit',
    cue: { type: 'intent_match', pattern: 'deploy', confidence: 0.9 },
    routine: {
      toolSequence: ['build', 'test', 'deploy'],
      description: 'Build, test, and deploy',
      estimatedDurationMs: 6000,
    },
    reward: {
      expectedOutcome: 'deployment complete',
      successMetric: 'task_completed',
      averageRewardValue: 0.8,
    },
    strength: 0.6,
    automaticity: 'semi_automatic',
    successRate: 0.85,
    executionCount: 10,
    lastExecuted: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    decayRate: 0.03,
    ...overrides,
  };
}

// ── Cue Detection ────────────────────────────────────────────────────

describe('detectCues', () => {
  it('matches intent_match cues case-insensitively', () => {
    const habits = [makeHabit()];
    const matches = detectCues('I want to Deploy the app', [], habits);
    expect(matches).toHaveLength(1);
    expect(matches[0].cueMatchConfidence).toBe(0.9);
  });

  it('matches sequential cues based on last tool', () => {
    const habit = makeHabit({
      id: 'h2',
      cue: { type: 'sequential', pattern: 'build', confidence: 0.85 },
    });
    const matches = detectCues('next step', ['lint', 'build'], [habit]);
    expect(matches).toHaveLength(1);
    expect(matches[0].habit.id).toBe('h2');
  });

  it('does not match temporal cues in-context', () => {
    const habit = makeHabit({
      cue: { type: 'temporal', pattern: '0 9 * * *', confidence: 0.95 },
    });
    const matches = detectCues('morning routine', [], [habit]);
    expect(matches).toHaveLength(0);
  });

  it('filters out low-confidence matches (< 0.3)', () => {
    const habit = makeHabit({
      cue: { type: 'intent_match', pattern: 'deploy', confidence: 0.2 },
    });
    const matches = detectCues('deploy now', [], [habit]);
    expect(matches).toHaveLength(0);
  });

  it('sorts by strength * confidence descending', () => {
    const h1 = makeHabit({ id: 'a', strength: 0.9, cue: { type: 'intent_match', pattern: 'deploy', confidence: 0.5 } });
    const h2 = makeHabit({ id: 'b', strength: 0.4, cue: { type: 'intent_match', pattern: 'deploy', confidence: 0.9 } });
    const matches = detectCues('deploy', [], [h1, h2]);
    // h1 score = 0.9 * 0.5 = 0.45, h2 score = 0.4 * 0.9 = 0.36
    expect(matches[0].habit.id).toBe('a');
    expect(matches[1].habit.id).toBe('b');
  });
});

// ── Habit Strength ───────────────────────────────────────────────────

describe('computeStrength', () => {
  it('increases with execution count and success rate', () => {
    const s1 = computeStrength(5, 0.8, 0);
    const s2 = computeStrength(15, 0.8, 0);
    expect(s2).toBeGreaterThan(s1);
  });

  it('caps at 1.0', () => {
    const s = computeStrength(100, 1.0, 0);
    expect(s).toBeLessThanOrEqual(1.0);
  });

  it('decays over time', () => {
    const fresh = computeStrength(10, 0.9, 0);
    const stale = computeStrength(10, 0.9, 10);
    expect(stale).toBeLessThan(fresh);
  });

  it('returns 0 for no executions', () => {
    expect(computeStrength(0, 0.5, 0)).toBe(0);
  });
});

describe('computeAutomaticity', () => {
  it('returns deliberate for low strength/count', () => {
    expect(computeAutomaticity(0.2, 3, 0.8)).toBe('deliberate');
  });

  it('transitions to semi_automatic', () => {
    expect(computeAutomaticity(0.5, 6, 0.7)).toBe('semi_automatic');
  });

  it('transitions to automatic', () => {
    expect(computeAutomaticity(0.8, 20, 0.9)).toBe('automatic');
  });

  it('requires high success rate for automatic', () => {
    // High strength and count but low success rate
    expect(computeAutomaticity(0.8, 20, 0.6)).toBe('semi_automatic');
  });
});

describe('decayHabitStrength', () => {
  it('reduces strength for unused habits', () => {
    const habit = makeHabit({ strength: 0.7, executionCount: 10, successRate: 0.9 });
    const decayed = decayHabitStrength(habit, 15);
    expect(decayed).toBeLessThan(habit.strength);
  });
});

// ── Bad Habit Detection ──────────────────────────────────────────────

describe('detectBadHabits', () => {
  it('flags declining success rate', () => {
    const habit = makeHabit({
      strength: 0.5,
      successRate: 0.3,
      executionCount: 10,
    });
    const indicators = detectBadHabits([habit]);
    expect(indicators.some((i) => i.reason === 'declining_success')).toBe(true);
  });

  it('flags context_changed for old habits', () => {
    const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    const habit = makeHabit({
      strength: 0.5,
      lastExecuted: thirtyFiveDaysAgo,
    });
    const indicators = detectBadHabits([habit]);
    expect(indicators.some((i) => i.reason === 'context_changed')).toBe(true);
  });

  it('ignores weak habits (strength <= 0.3)', () => {
    const habit = makeHabit({ strength: 0.2, successRate: 0.1, executionCount: 10 });
    const indicators = detectBadHabits([habit]);
    expect(indicators).toHaveLength(0);
  });
});

// ── HabitEngine ──────────────────────────────────────────────────────

describe('HabitEngine', () => {
  it('promotes a pattern and checks cues', async () => {
    const engine = new HabitEngine(null, 'ws1');

    await engine.promotePattern(
      'deploy flow',
      ['build', 'test', 'deploy'],
      { type: 'intent_match', pattern: 'deploy', confidence: 0.9 },
      'app deployed',
    );

    const habits = engine.getHabits();
    expect(habits).toHaveLength(1);
    expect(habits[0].name).toBe('deploy flow');
    expect(habits[0].automaticity).toBe('deliberate');

    const matches = engine.checkCues('deploy the app', []);
    expect(matches).toHaveLength(1);
    expect(matches[0].habit.name).toBe('deploy flow');
  });

  it('records execution and increases strength', async () => {
    const engine = new HabitEngine(null, 'ws1');

    const habit = await engine.promotePattern(
      'test flow',
      ['lint', 'test'],
      { type: 'intent_match', pattern: 'test', confidence: 0.8 },
      'tests pass',
    );

    const initialStrength = habit.strength;

    // Record several successful executions
    for (let i = 0; i < 5; i++) {
      await engine.recordExecution(habit.id, true);
    }

    const updated = engine.getHabits().find((h) => h.id === habit.id)!;
    expect(updated.executionCount).toBe(5);
    expect(updated.strength).toBeGreaterThan(initialStrength);
  });

  it('builds prompt context when matches exist', async () => {
    const engine = new HabitEngine(null, 'ws1');

    await engine.promotePattern(
      'deploy',
      ['build', 'deploy'],
      { type: 'intent_match', pattern: 'deploy', confidence: 0.9 },
      'deployed',
    );

    const matches = engine.checkCues('deploy now', []);
    const ctx = engine.buildPromptContext(matches);
    expect(ctx).not.toBeNull();
    expect(ctx).toContain('Habit Shortcuts');
    expect(ctx).toContain('deploy');
  });

  it('returns null prompt context when no matches', () => {
    const engine = new HabitEngine(null, 'ws1');
    const ctx = engine.buildPromptContext([]);
    expect(ctx).toBeNull();
  });

  it('detects bad habits via checkBadHabits', async () => {
    const engine = new HabitEngine(null, 'ws1');

    const _habit = await engine.promotePattern(
      'failing routine',
      ['tool1'],
      { type: 'intent_match', pattern: 'fail', confidence: 0.9 },
      'should work',
    );

    // Manually set bad stats on the habit
    const habits = engine.getHabits();
    habits[0].strength = 0.5;
    habits[0].successRate = 0.2;
    habits[0].executionCount = 10;

    const bad = engine.checkBadHabits();
    expect(bad.length).toBeGreaterThan(0);
    expect(bad[0].reason).toBe('declining_success');
  });
});
