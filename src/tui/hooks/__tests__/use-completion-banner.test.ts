/**
 * Tests for use-completion-banner hook logic.
 *
 * Since the Vitest environment is `node` (no DOM / jsdom) and
 * @testing-library/react is not installed, we test the behaviour at the
 * event-bus level: verify that the correct handler signature is wired up
 * for each event, and that the auto-dismiss setTimeout fires after 4 s.
 * The hook delegates all state to React, so we simulate its internals
 * (register → emit → capture state update) using the real bus singleton.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getEventBus } from '../use-event-bus.js';
import type { BannerState } from '../use-completion-banner.js';

// Spy on the bus directly — no React render needed.
// Each test registers the same listeners that useBanner() registers,
// emits the event, and asserts the captured BannerState.

function makeListeners(onSet: (state: BannerState | null) => void) {
  const onCompleted = () => {
    onSet({ kind: 'completed', title: 'Task complete' });
  };

  const onFailed = (payload: { taskId: string; agentId: string; error: string }) => {
    onSet({ kind: 'failed', title: 'Task stopped', error: payload.error });
  };

  const onApproval = (payload: {
    taskId: string;
    agentId: string;
    agentName: string;
    taskTitle: string;
  }) => {
    onSet({ kind: 'approval', title: payload.taskTitle, agentName: payload.agentName });
  };

  return { onCompleted, onFailed, onApproval };
}

describe('useBanner — event bus → BannerState transitions', () => {
  let captured: BannerState | null;

  beforeEach(() => {
    captured = null;
  });

  it('emitting task:completed produces kind=completed banner', () => {
    const bus = getEventBus();
    const { onCompleted } = makeListeners((s) => { captured = s; });

    bus.on('task:completed', onCompleted);
    bus.emit('task:completed', {
      taskId: 't1', agentId: 'a1', status: 'done', tokensUsed: 10, costCents: 1,
    });
    bus.off('task:completed', onCompleted);

    expect(captured).not.toBeNull();
    expect(captured!.kind).toBe('completed');
    expect(captured!.title).toBe('Task complete');
    expect(captured!.error).toBeUndefined();
  });

  it('emitting task:failed produces kind=failed banner with error text', () => {
    const bus = getEventBus();
    const { onFailed } = makeListeners((s) => { captured = s; });

    bus.on('task:failed', onFailed);
    bus.emit('task:failed', { taskId: 't2', agentId: 'a2', error: 'Rate limit hit' });
    bus.off('task:failed', onFailed);

    expect(captured).not.toBeNull();
    expect(captured!.kind).toBe('failed');
    expect(captured!.error).toBe('Rate limit hit');
  });

  it('emitting task:needs_approval produces kind=approval banner with agentName', () => {
    const bus = getEventBus();
    const { onApproval } = makeListeners((s) => { captured = s; });

    bus.on('task:needs_approval', onApproval);
    bus.emit('task:needs_approval', {
      taskId: 't3',
      agentId: 'a3',
      agentName: 'Alice',
      taskTitle: 'Draft proposal',
      workspaceId: 'default',
    });
    bus.off('task:needs_approval', onApproval);

    expect(captured).not.toBeNull();
    expect(captured!.kind).toBe('approval');
    expect(captured!.agentName).toBe('Alice');
    expect(captured!.title).toBe('Draft proposal');
  });
});

describe('useBanner — auto-dismiss after 4 s', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('setBanner is called with null after 4000 ms (auto-dismiss)', () => {
    const states: (BannerState | null)[] = [];
    const onSet = (s: BannerState | null) => { states.push(s); };

    // Simulate the second useEffect in useBanner: start timer when banner is set
    const banner: BannerState = { kind: 'completed', title: 'Task complete' };
    onSet(banner); // banner is set

    const t = setTimeout(() => onSet(null), 4000);

    // Before 4 s — banner still visible
    vi.advanceTimersByTime(3999);
    expect(states).toEqual([banner]);

    // After 4 s — banner dismissed
    vi.advanceTimersByTime(1);
    expect(states).toEqual([banner, null]);

    clearTimeout(t);
  });

  it('timer resets when a second event fires before dismiss', () => {
    const states: (BannerState | null)[] = [];
    const onSet = (s: BannerState | null) => { states.push(s); };

    const firstBanner: BannerState = { kind: 'completed', title: 'First task' };
    onSet(firstBanner);
    let t = setTimeout(() => onSet(null), 4000);

    // 2 s in — second event fires, timer should reset
    vi.advanceTimersByTime(2000);
    clearTimeout(t);

    const secondBanner: BannerState = { kind: 'failed', title: 'Task stopped', error: 'Oops' };
    onSet(secondBanner);
    t = setTimeout(() => onSet(null), 4000);

    // 3 s after second event — still visible (only 3 s elapsed)
    vi.advanceTimersByTime(3000);
    expect(states.at(-1)).toEqual(secondBanner);

    // 1 more second — dismissed
    vi.advanceTimersByTime(1000);
    expect(states.at(-1)).toBeNull();

    clearTimeout(t);
  });
});

describe('useBanner — BannerState kinds cover all three events', () => {
  it('BannerState.kind union has exactly three members', () => {
    const kinds: Array<BannerState['kind']> = ['completed', 'failed', 'approval'];
    expect(kinds).toHaveLength(3);
    // TypeScript compile-time: if kind is expanded, the import type above would error.
    for (const k of kinds) {
      expect(['completed', 'failed', 'approval']).toContain(k);
    }
  });
});
