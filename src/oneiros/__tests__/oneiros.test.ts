import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SleepCycle } from '../sleep-cycle.js';
import { PHASE_CONFIG } from '../types.js';
import {
  selectForConsolidation,
  identifyForPruning,
  identifyForStrengthening,
} from '../consolidation.js';
import type { ConsolidationMemory } from '../consolidation.js';
import { generateDreamAssociations } from '../dreaming.js';
import { generateSpontaneousInsight, simulateFuture } from '../default-mode.js';

const MS_PER_MINUTE = 60_000;

describe('SleepCycle', () => {
  let cycle: SleepCycle;

  beforeEach(() => {
    cycle = new SleepCycle();
  });

  it('starts in wake phase', () => {
    expect(cycle.getState().phase).toBe('wake');
  });

  it('transitions wake -> drowsy after idle threshold', () => {
    const result = cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    expect(result).toBe('drowsy');
  });

  it('stays in wake if idle time is below threshold', () => {
    const result = cycle.tick((PHASE_CONFIG.idleToDrowsy - 1) * MS_PER_MINUTE);
    expect(result).toBe('wake');
  });

  it('transitions drowsy -> light_sleep after drowsyToLight minutes', () => {
    // Enter drowsy
    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    expect(cycle.getState().phase).toBe('drowsy');

    // Simulate time passing in drowsy phase
    const enteredAt = cycle.getState().enteredPhaseAt;
    vi.spyOn(Date, 'now').mockReturnValue(enteredAt + PHASE_CONFIG.drowsyToLight * MS_PER_MINUTE);

    const result = cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    expect(result).toBe('light_sleep');
    vi.restoreAllMocks();
  });

  it('transitions light_sleep -> deep_sleep -> REM', () => {
    // Force into light_sleep
    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    let enteredAt = cycle.getState().enteredPhaseAt;
    vi.spyOn(Date, 'now').mockReturnValue(enteredAt + PHASE_CONFIG.drowsyToLight * MS_PER_MINUTE);
    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    expect(cycle.getState().phase).toBe('light_sleep');
    vi.restoreAllMocks();

    // light -> deep
    enteredAt = cycle.getState().enteredPhaseAt;
    vi.spyOn(Date, 'now').mockReturnValue(enteredAt + PHASE_CONFIG.lightToDeep * MS_PER_MINUTE);
    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    expect(cycle.getState().phase).toBe('deep_sleep');
    vi.restoreAllMocks();

    // deep -> REM
    enteredAt = cycle.getState().enteredPhaseAt;
    vi.spyOn(Date, 'now').mockReturnValue(enteredAt + PHASE_CONFIG.deepToREM * MS_PER_MINUTE);
    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    expect(cycle.getState().phase).toBe('REM');
    vi.restoreAllMocks();
  });

  it('cycles REM -> light_sleep when under maxCycles', () => {
    // Navigate to REM
    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    let enteredAt = cycle.getState().enteredPhaseAt;
    vi.spyOn(Date, 'now').mockReturnValue(enteredAt + PHASE_CONFIG.drowsyToLight * MS_PER_MINUTE);
    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    vi.restoreAllMocks();

    enteredAt = cycle.getState().enteredPhaseAt;
    vi.spyOn(Date, 'now').mockReturnValue(enteredAt + PHASE_CONFIG.lightToDeep * MS_PER_MINUTE);
    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    vi.restoreAllMocks();

    enteredAt = cycle.getState().enteredPhaseAt;
    vi.spyOn(Date, 'now').mockReturnValue(enteredAt + PHASE_CONFIG.deepToREM * MS_PER_MINUTE);
    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    expect(cycle.getState().phase).toBe('REM');
    vi.restoreAllMocks();

    // REM -> light_sleep (cycle 1)
    enteredAt = cycle.getState().enteredPhaseAt;
    vi.spyOn(Date, 'now').mockReturnValue(enteredAt + PHASE_CONFIG.remToLight * MS_PER_MINUTE);
    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    expect(cycle.getState().phase).toBe('light_sleep');
    expect(cycle.getState().cycleCount).toBe(1);
    vi.restoreAllMocks();
  });

  it('wake() immediately returns to wake from any phase', () => {
    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    expect(cycle.getState().phase).toBe('drowsy');

    cycle.wake('user interaction');
    expect(cycle.getState().phase).toBe('wake');
    expect(cycle.getState().cycleCount).toBe(0);
  });

  it('isAsleep() returns false in wake and waking, true otherwise', () => {
    expect(cycle.isAsleep()).toBe(false);

    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    expect(cycle.isAsleep()).toBe(true); // drowsy

    cycle.wake('test');
    expect(cycle.isAsleep()).toBe(false); // wake
  });

  it('shouldConsolidate() returns true only in deep_sleep', () => {
    expect(cycle.shouldConsolidate()).toBe(false);

    // Navigate to deep_sleep
    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    expect(cycle.shouldConsolidate()).toBe(false);

    let enteredAt = cycle.getState().enteredPhaseAt;
    vi.spyOn(Date, 'now').mockReturnValue(enteredAt + PHASE_CONFIG.drowsyToLight * MS_PER_MINUTE);
    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    vi.restoreAllMocks();

    enteredAt = cycle.getState().enteredPhaseAt;
    vi.spyOn(Date, 'now').mockReturnValue(enteredAt + PHASE_CONFIG.lightToDeep * MS_PER_MINUTE);
    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    vi.restoreAllMocks();

    expect(cycle.getState().phase).toBe('deep_sleep');
    expect(cycle.shouldConsolidate()).toBe(true);
  });

  it('shouldDream() returns true only in REM', () => {
    expect(cycle.shouldDream()).toBe(false);

    // Navigate to REM
    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    let enteredAt = cycle.getState().enteredPhaseAt;
    vi.spyOn(Date, 'now').mockReturnValue(enteredAt + PHASE_CONFIG.drowsyToLight * MS_PER_MINUTE);
    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    vi.restoreAllMocks();

    enteredAt = cycle.getState().enteredPhaseAt;
    vi.spyOn(Date, 'now').mockReturnValue(enteredAt + PHASE_CONFIG.lightToDeep * MS_PER_MINUTE);
    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    vi.restoreAllMocks();

    enteredAt = cycle.getState().enteredPhaseAt;
    vi.spyOn(Date, 'now').mockReturnValue(enteredAt + PHASE_CONFIG.deepToREM * MS_PER_MINUTE);
    cycle.tick(PHASE_CONFIG.idleToDrowsy * MS_PER_MINUTE);
    vi.restoreAllMocks();

    expect(cycle.getState().phase).toBe('REM');
    expect(cycle.shouldDream()).toBe(true);
  });

  it('computeSleepDebt() increases with experiences and time', () => {
    const low = cycle.computeSleepDebt({
      experiencesSinceLastSleep: 10,
      hoursSinceLastConsolidation: 2,
      memoryPressure: 0.1,
    });

    const high = cycle.computeSleepDebt({
      experiencesSinceLastSleep: 80,
      hoursSinceLastConsolidation: 20,
      memoryPressure: 0.9,
    });

    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThan(0.5);
    expect(high).toBeGreaterThan(0.5);
    expect(high).toBeLessThanOrEqual(1);
  });

  it('computeSleepDebt() clamps to 0-1 range', () => {
    const extreme = cycle.computeSleepDebt({
      experiencesSinceLastSleep: 1000,
      hoursSinceLastConsolidation: 100,
      memoryPressure: 1,
    });
    expect(extreme).toBeLessThanOrEqual(1);

    const zero = cycle.computeSleepDebt({
      experiencesSinceLastSleep: 0,
      hoursSinceLastConsolidation: 0,
      memoryPressure: 0,
    });
    expect(zero).toBe(0);
  });
});

describe('Consolidation', () => {
  const now = Date.now();
  const memories: ConsolidationMemory[] = [
    { id: 'a', content: 'important recent', relevanceScore: 0.9, timesUsed: 5, createdAt: now - 1000, affect: 'joy' },
    { id: 'b', content: 'mediocre old', relevanceScore: 0.3, timesUsed: 0, createdAt: now - 8 * 24 * 60 * 60 * 1000 },
    { id: 'c', content: 'decent recent', relevanceScore: 0.6, timesUsed: 2, createdAt: now - 2000 },
    { id: 'd', content: 'low old unused', relevanceScore: 0.1, timesUsed: 0, createdAt: now - 10 * 24 * 60 * 60 * 1000 },
    { id: 'e', content: 'high relevance old', relevanceScore: 0.85, timesUsed: 4, createdAt: now - 5 * 24 * 60 * 60 * 1000 },
  ];

  it('selects highest-scored memories for consolidation', () => {
    const selected = selectForConsolidation(memories, 2);
    expect(selected).toHaveLength(2);
    // Memory 'a' should be first: high relevance + recent + affect
    expect(selected[0].id).toBe('a');
  });

  it('identifies low-value old unused memories for pruning', () => {
    const pruned = identifyForPruning(memories, 0.4);
    expect(pruned).toContain('b');
    expect(pruned).toContain('d');
    expect(pruned).not.toContain('a');
    expect(pruned).not.toContain('c');
  });

  it('does not prune recent low-relevance memories', () => {
    const recentLow: ConsolidationMemory = {
      id: 'recent', content: 'recent low', relevanceScore: 0.1,
      timesUsed: 0, createdAt: now - 1000,
    };
    const pruned = identifyForPruning([recentLow], 0.4);
    expect(pruned).toHaveLength(0);
  });

  it('identifies frequently-used or high-relevance memories for strengthening', () => {
    const strengthened = identifyForStrengthening(memories);
    expect(strengthened).toContain('a');  // timesUsed > 3
    expect(strengthened).toContain('e');  // relevanceScore > 0.8
    expect(strengthened).not.toContain('b');
    expect(strengthened).not.toContain('d');
  });
});

describe('Dreaming', () => {
  it('generates associations between different-domain memories', () => {
    const memories = [
      { id: '1', content: 'cooking recipe', keywords: ['food', 'cooking'] },
      { id: '2', content: 'machine learning model', keywords: ['ai', 'technology'] },
      { id: '3', content: 'garden planning', keywords: ['nature', 'garden'] },
    ];

    const associations = generateDreamAssociations(memories, 5);
    expect(associations.length).toBeGreaterThan(0);
    associations.forEach((a) => {
      expect(a.noveltyScore).toBeGreaterThan(0.5);
      expect(a.connection).toBeTruthy();
    });
  });

  it('scores novelty by inverse keyword overlap', () => {
    const memories = [
      { id: '1', content: 'web app', keywords: ['web', 'javascript', 'react'] },
      { id: '2', content: 'web api', keywords: ['web', 'javascript', 'api'] },
      { id: '3', content: 'music theory', keywords: ['music', 'composition'] },
    ];

    const associations = generateDreamAssociations(memories, 10);
    // music+web should be more novel than web+web
    const musicWeb = associations.find(
      (a) =>
        (a.memoryA.id === '3' || a.memoryB.id === '3') &&
        (a.memoryA.id === '1' || a.memoryB.id === '1'),
    );
    expect(musicWeb).toBeDefined();
    expect(musicWeb!.noveltyScore).toBe(1); // zero overlap
  });

  it('returns empty array for fewer than 2 memories', () => {
    expect(generateDreamAssociations([], 5)).toEqual([]);
    expect(generateDreamAssociations([{ id: '1', content: 'solo' }], 5)).toEqual([]);
  });

  it('handles memories without keywords', () => {
    const memories = [
      { id: '1', content: 'first memory' },
      { id: '2', content: 'second memory' },
    ];
    const associations = generateDreamAssociations(memories, 5);
    expect(associations.length).toBe(1);
    expect(associations[0].noveltyScore).toBe(1.0);
  });
});

describe('Default Mode Network', () => {
  it('generates spontaneous insight from patterns and principles', () => {
    const patterns = [
      { name: 'error_clustering', description: 'Errors cluster around timeout handling in async operations' },
    ];
    const principles = [
      { rule: 'Always set timeout guards for async operations', category: 'reliability' },
      { rule: 'Log structured data', category: 'observability' },
    ];

    const insight = generateSpontaneousInsight(patterns, principles);
    expect(insight).not.toBeNull();
    expect(insight!.type).toMatch(/spontaneous_insight|creative_recombination/);
    expect(insight!.confidence).toBeGreaterThan(0);
    expect(insight!.confidence).toBeLessThanOrEqual(1);
  });

  it('returns null for empty inputs', () => {
    expect(generateSpontaneousInsight([], [{ rule: 'test', category: 'test' }])).toBeNull();
    expect(generateSpontaneousInsight([{ name: 'test', description: 'test' }], [])).toBeNull();
  });

  it('simulateFuture() projects goal progress', () => {
    const goals = [{ title: 'response_time', currentValue: 60, targetValue: 100 }];
    const insight = simulateFuture(goals, []);
    expect(insight).not.toBeNull();
    expect(insight!.type).toBe('future_simulation');
    expect(insight!.content).toContain('response_time');
    expect(insight!.content).toContain('60%');
  });

  it('simulateFuture() detects negative trends', () => {
    const goals = [{ title: 'accuracy', currentValue: 30, targetValue: 100 }];
    const trends = ['accuracy declining over past week'];
    const insight = simulateFuture(goals, trends);
    expect(insight).not.toBeNull();
    expect(insight!.content).toContain('Risk');
    expect(insight!.content).toContain('trending away');
  });

  it('simulateFuture() recognizes completed goals', () => {
    const goals = [{ title: 'coverage', currentValue: 100, targetValue: 100 }];
    const insight = simulateFuture(goals, []);
    expect(insight).not.toBeNull();
    expect(insight!.content).toContain('reached');
  });

  it('simulateFuture() returns null for empty goals', () => {
    expect(simulateFuture([], [])).toBeNull();
  });
});
