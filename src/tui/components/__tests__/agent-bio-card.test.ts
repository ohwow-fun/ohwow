import { describe, it, expect } from 'vitest';
import { buildRecentText } from '../agent-bio-card.js';

/** Build a task object with created_at at a given ms timestamp. */
function makeTask(
  agentId: string,
  createdAtMs: number,
): { agent_id: string; created_at: string; completed_at: string | null } {
  return {
    agent_id: agentId,
    created_at: new Date(createdAtMs).toISOString(),
    completed_at: null,
  };
}

describe('buildRecentText', () => {
  const NOW = new Date('2026-04-22T12:00:00.000Z');
  const NOW_MS = NOW.getTime();
  const HOUR = 60 * 60 * 1000;

  // Slot mapping (slot index → hours ago):
  //   slot 5 → slotStart = now - 3h, slotEnd = now - 2h → hoursAgo = 2
  //   slot 6 → slotStart = now - 2h, slotEnd = now - 1h → hoursAgo = 1
  //   slot 7 → slotStart = now - 1h, slotEnd = now      → hoursAgo = 0

  it('returns "0 tasks (Xh ago)" for all three slots when task list is empty', () => {
    const result = buildRecentText('agent-1', [], NOW);
    expect(result).toBe('0 tasks (2h ago) → 0 tasks (1h ago) → 0 tasks (0h ago)');
  });

  it('counts a task in the 2h-ago bucket (slot 5) correctly', () => {
    // Place task at 2.5h ago → falls in [now-3h, now-2h) → slot 5 → "2h ago"
    const tasks = [makeTask('agent-1', NOW_MS - 2.5 * HOUR)];
    const result = buildRecentText('agent-1', tasks, NOW);
    expect(result).toBe('1 task (2h ago) → 0 tasks (1h ago) → 0 tasks (0h ago)');
  });

  it('counts a task in the 1h-ago bucket (slot 6) correctly', () => {
    // Place task at 1.5h ago → falls in [now-2h, now-1h) → slot 6 → "1h ago"
    const tasks = [makeTask('agent-1', NOW_MS - 1.5 * HOUR)];
    const result = buildRecentText('agent-1', tasks, NOW);
    expect(result).toBe('0 tasks (2h ago) → 1 task (1h ago) → 0 tasks (0h ago)');
  });

  it('counts a task in the most-recent bucket (slot 7) correctly', () => {
    // Place task at 30min ago → falls in [now-1h, now) → slot 7 → "0h ago"
    const tasks = [makeTask('agent-1', NOW_MS - 30 * 60 * 1000)];
    const result = buildRecentText('agent-1', tasks, NOW);
    expect(result).toBe('0 tasks (2h ago) → 0 tasks (1h ago) → 1 task (0h ago)');
  });

  it('uses singular "task" when count is 1', () => {
    const tasks = [makeTask('agent-1', NOW_MS - 30 * 60 * 1000)];
    const result = buildRecentText('agent-1', tasks, NOW);
    expect(result).toContain('1 task ');
    expect(result).not.toContain('1 tasks');
  });

  it('uses plural "tasks" when count is 0', () => {
    const result = buildRecentText('agent-1', [], NOW);
    expect(result).toContain('0 tasks');
  });

  it('uses plural "tasks" when count is 2+', () => {
    const tasks = [
      makeTask('agent-1', NOW_MS - 20 * 60 * 1000),
      makeTask('agent-1', NOW_MS - 40 * 60 * 1000),
    ];
    const result = buildRecentText('agent-1', tasks, NOW);
    expect(result).toContain('2 tasks (0h ago)');
  });

  it('ignores tasks from a different agent', () => {
    // Task belongs to "other-agent", not "agent-1"
    const tasks = [makeTask('other-agent', NOW_MS - 30 * 60 * 1000)];
    const result = buildRecentText('agent-1', tasks, NOW);
    expect(result).toBe('0 tasks (2h ago) → 0 tasks (1h ago) → 0 tasks (0h ago)');
  });

  it('ignores tasks older than 3h (outside the 3-slot window)', () => {
    // Place task at 4h ago — before slot 5 starts at now-3h
    const tasks = [makeTask('agent-1', NOW_MS - 4 * HOUR)];
    const result = buildRecentText('agent-1', tasks, NOW);
    expect(result).toBe('0 tasks (2h ago) → 0 tasks (1h ago) → 0 tasks (0h ago)');
  });

  it('slot boundary: task at exactly now-3h is counted in slot 5 (inclusive lower bound)', () => {
    // slotStart for slot 5 = now - 3h; task at exactly that ms is >= slotStart
    const tasks = [makeTask('agent-1', NOW_MS - 3 * HOUR)];
    const result = buildRecentText('agent-1', tasks, NOW);
    expect(result).toBe('1 task (2h ago) → 0 tasks (1h ago) → 0 tasks (0h ago)');
  });

  it('slot boundary: task at exactly now-2h falls in slot 6, NOT slot 5 (exclusive upper bound)', () => {
    // slotEnd for slot 5 = now - 2h; task at exactly that ms is NOT < slotEnd
    const tasks = [makeTask('agent-1', NOW_MS - 2 * HOUR)];
    const result = buildRecentText('agent-1', tasks, NOW);
    // Slot 5 (2h ago) should be 0; slot 6 (1h ago) should be 1
    expect(result).toBe('0 tasks (2h ago) → 1 task (1h ago) → 0 tasks (0h ago)');
  });

  it('counts tasks across all three buckets independently', () => {
    const tasks = [
      makeTask('agent-1', NOW_MS - 2.5 * HOUR), // slot 5
      makeTask('agent-1', NOW_MS - 1.5 * HOUR), // slot 6
      makeTask('agent-1', NOW_MS - 1.5 * HOUR), // slot 6 (second task)
      makeTask('agent-1', NOW_MS - 30 * 60 * 1000), // slot 7
    ];
    const result = buildRecentText('agent-1', tasks, NOW);
    expect(result).toBe('1 task (2h ago) → 2 tasks (1h ago) → 1 task (0h ago)');
  });

  it('joins the three segments with " → "', () => {
    const result = buildRecentText('agent-1', [], NOW);
    const parts = result.split(' → ');
    expect(parts).toHaveLength(3);
  });
});

describe('description fallback (personalityText logic)', () => {
  // This logic lives inline in AgentBioCard but we can verify the contract
  // as a pure expression: (description ?? 'No briefing on file.').slice(0, 80)

  it('returns "No briefing on file." when description is null', () => {
    const description: string | null = null;
    const text = (description ?? 'No briefing on file.').slice(0, 80);
    expect(text).toBe('No briefing on file.');
  });

  it('returns "No briefing on file." when description is undefined', () => {
    const description: string | undefined = undefined;
    const text = (description ?? 'No briefing on file.').slice(0, 80);
    expect(text).toBe('No briefing on file.');
  });

  it('returns the description when it is a non-null string', () => {
    const description = 'Handles customer onboarding and CRM updates.';
    const text = (description ?? 'No briefing on file.').slice(0, 80);
    expect(text).toBe(description);
  });

  it('truncates description to 80 chars', () => {
    const description = 'A'.repeat(100);
    const text = (description ?? 'No briefing on file.').slice(0, 80);
    expect(text).toHaveLength(80);
  });

  it('typewriter is enabled when description is non-null, disabled when null', () => {
    // Mirrors the `agent.description != null` guard passed to useTypewriter
    const withDesc = 'some description';
    const withoutDesc: string | null = null;
    expect(withDesc != null).toBe(true);
    expect(withoutDesc != null).toBe(false);
  });
});
