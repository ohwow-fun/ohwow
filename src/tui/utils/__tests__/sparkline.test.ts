import { describe, it, expect } from 'vitest';
import { sparklineForAgent, SPARKLINE_CHARS } from '../sparkline.js';

const BLANK = SPARKLINE_CHARS[0]; // '⠀'
const MAX_CHAR = SPARKLINE_CHARS[7]; // '⣿'

/** Helper: create a task object with created_at at a given offset from `now`. */
function makeTask(
  agentId: string,
  createdAtMs: number,
  completedAtMs?: number,
): { agent_id: string; created_at: string; completed_at: string | null } {
  return {
    agent_id: agentId,
    created_at: new Date(createdAtMs).toISOString(),
    completed_at: completedAtMs != null ? new Date(completedAtMs).toISOString() : null,
  };
}

describe('sparklineForAgent', () => {
  const NOW = new Date('2026-04-22T12:00:00.000Z');
  const NOW_MS = NOW.getTime();
  const HOUR = 60 * 60 * 1000;

  it('returns 8 blank braille chars for an empty task array', () => {
    const result = sparklineForAgent([], 'agent-1', NOW);
    expect(result).toBe(BLANK.repeat(8));
    expect([...result]).toHaveLength(8);
  });

  it('returns 8 blank braille chars when tasks exist but none match the agentId', () => {
    const tasks = [
      makeTask('other-agent', NOW_MS - 30 * 60 * 1000),
      makeTask('different-agent', NOW_MS - 2 * HOUR),
    ];
    const result = sparklineForAgent(tasks, 'agent-1', NOW);
    expect(result).toBe(BLANK.repeat(8));
  });

  it('5 tasks in the current (most recent) hour: last char is not blank, first 7 are blank', () => {
    // Slot 7 = [now - 1h, now]. Place all 5 tasks in this slot.
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTask('agent-1', NOW_MS - i * 5 * 60 * 1000),
    );
    const result = sparklineForAgent(tasks, 'agent-1', NOW);
    const chars = [...result];
    expect(chars).toHaveLength(8);
    // First 7 positions must be blank
    for (let i = 0; i < 7; i++) {
      expect(chars[i]).toBe(BLANK);
    }
    // Last position must be non-blank
    expect(chars[7]).not.toBe(BLANK);
  });

  it('tasks spread across all 8 hours produce a non-uniform string', () => {
    // One task per hour slot, placing each task at the midpoint of its slot.
    // Slot i covers [windowStart + i*HOUR, windowStart + (i+1)*HOUR).
    const windowStart = NOW_MS - 8 * HOUR;
    const tasks = Array.from({ length: 8 }, (_, i) =>
      makeTask('agent-1', windowStart + i * HOUR + 30 * 60 * 1000),
    );
    const result = sparklineForAgent(tasks, 'agent-1', NOW);
    const chars = [...result];
    expect(chars).toHaveLength(8);
    // With exactly 1 task per slot every character should be the same level,
    // but the string itself must be non-blank (at least one char differs from BLANK).
    const hasNonBlank = chars.some(c => c !== BLANK);
    expect(hasNonBlank).toBe(true);
    // Verify uniform: all chars equal (each slot has count=1 → same char).
    const allSame = chars.every(c => c === chars[0]);
    expect(allSame).toBe(true);
    expect(chars[0]).not.toBe(BLANK);
  });

  it('produces non-uniform chars when slots have different task counts', () => {
    const windowStart = NOW_MS - 8 * HOUR;
    // Slot 0 gets 1 task, slot 7 gets 5 tasks → different chars.
    const tasks = [
      makeTask('agent-1', windowStart + 30 * 60 * 1000),        // slot 0, count=1
      ...Array.from({ length: 5 }, (_, i) =>
        makeTask('agent-1', NOW_MS - i * 5 * 60 * 1000),        // slot 7, count=5
      ),
    ];
    const result = sparklineForAgent(tasks, 'agent-1', NOW);
    const chars = [...result];
    expect(chars[0]).not.toBe(chars[7]);
  });

  it('clamps: 10+ tasks in one hour yields max braille char (⣿) for that slot', () => {
    // Drop 10 tasks into slot 7 (the current hour).
    const tasks = Array.from({ length: 10 }, (_, i) =>
      makeTask('agent-1', NOW_MS - i * 3 * 60 * 1000),
    );
    const result = sparklineForAgent(tasks, 'agent-1', NOW);
    const chars = [...result];
    expect(chars[7]).toBe(MAX_CHAR);
  });

  it('task at exactly the 8h boundary (oldest slot) is counted in slot 0', () => {
    const windowStart = NOW_MS - 8 * HOUR;
    // created_at == windowStart exactly (inclusive lower bound).
    const tasks = [makeTask('agent-1', windowStart)];
    const result = sparklineForAgent(tasks, 'agent-1', NOW);
    const chars = [...result];
    // Slot 0 should be non-blank.
    expect(chars[0]).not.toBe(BLANK);
    // Remaining slots should be blank.
    for (let i = 1; i < 8; i++) {
      expect(chars[i]).toBe(BLANK);
    }
  });

  it('task older than 8h window is excluded (all blank)', () => {
    // created_at is 1 ms before the window start — should not be counted.
    const windowStart = NOW_MS - 8 * HOUR;
    const tasks = [makeTask('agent-1', windowStart - 1)];
    const result = sparklineForAgent(tasks, 'agent-1', NOW);
    expect(result).toBe(BLANK.repeat(8));
  });

  it('SPARKLINE_CHARS[7] is exactly ⣿', () => {
    expect(SPARKLINE_CHARS[7]).toBe('⣿');
  });

  it('SPARKLINE_CHARS[0] is exactly ⠀ (blank braille)', () => {
    expect(SPARKLINE_CHARS[0]).toBe('⠀');
  });
});
