/**
 * Braille sparkline utility for TodayBoard agent roster.
 * Maps task activity in the last 8 hours to an 8-character intensity bar.
 */

/** Eight braille intensity levels, from blank to fully filled. */
export const SPARKLINE_CHARS: readonly string[] = [
  '⠀', // 0 — empty
  '⣀', // 1
  '⣄', // 2
  '⣤', // 3
  '⣦', // 4
  '⣶', // 5
  '⣷', // 6
  '⣿', // 7 — full
] as const;

/**
 * Produce an 8-character braille sparkline for a single agent.
 *
 * Buckets: 8 × 1-hour slots, slot 0 = oldest (now-8h), slot 7 = most recent.
 * A task counts toward a slot when its created_at OR completed_at falls within
 * that hour window. Count is clamped to 7 and mapped to SPARKLINE_CHARS.
 *
 * Returns '⠀⠀⠀⠀⠀⠀⠀⠀' (8 blanks) when no tasks match the given agentId.
 */
export function sparklineForAgent(
  tasks: Array<{ agent_id: string; created_at: string; completed_at: string | null }>,
  agentId: string,
  now: Date,
): string {
  const nowMs = now.getTime();
  const windowMs = 8 * 60 * 60 * 1000; // 8 hours
  const slotMs = 60 * 60 * 1000;        // 1 hour per slot
  const windowStart = nowMs - windowMs;

  // Filter to this agent's tasks that touch the 8-hour window
  const agentTasks = tasks.filter(t => t.agent_id === agentId);

  if (agentTasks.length === 0) {
    return SPARKLINE_CHARS[0].repeat(8);
  }

  const counts = new Array<number>(8).fill(0);

  for (const task of agentTasks) {
    const timestamps: number[] = [];
    const created = Date.parse(task.created_at);
    if (!isNaN(created)) timestamps.push(created);
    if (task.completed_at) {
      const completed = Date.parse(task.completed_at);
      if (!isNaN(completed)) timestamps.push(completed);
    }

    for (const ts of timestamps) {
      if (ts < windowStart || ts > nowMs) continue;
      const slotIndex = Math.floor((ts - windowStart) / slotMs);
      // clamp to [0, 7] in case of floating-point edge cases
      const slot = Math.min(7, Math.max(0, slotIndex));
      counts[slot]++;
    }
  }

  return counts.map(c => SPARKLINE_CHARS[Math.min(c, 7)]).join('');
}
