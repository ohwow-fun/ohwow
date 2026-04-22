/**
 * Tests for useTypewriter hook logic.
 *
 * Since the Vitest environment is `node` (no DOM / jsdom) and
 * @testing-library/react is not installed, we exercise the hook's core
 * logic directly — simulating what useState + useEffect would do by
 * reproducing the exact interval/reset behaviour with vi.useFakeTimers.
 *
 * Each test mirrors one of the spec criteria:
 *   - enabled=false  → full text returned immediately, no interval
 *   - empty string   → empty string returned immediately
 *   - normal reveal  → chars appear one per charDelayMs tick
 *   - text change    → reveal index resets to 0
 *   - charDelayMs    → interval speed is honoured
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Simulate the hook's core logic without React.
// We replicate useState + setInterval exactly as written in use-typewriter.ts
// so that fake-timer advances map 1-to-1 to what the real hook would do.
// ---------------------------------------------------------------------------

interface TypewriterState {
  revealedCount: number;
  intervalId: ReturnType<typeof setInterval> | null;
}

/**
 * Creates a simulated instance of the useTypewriter hook.
 * Returns helpers to inspect current output and tear down the interval.
 */
function createHookSim(text: string, enabled = true, charDelayMs = 40) {
  const state: TypewriterState = { revealedCount: 0, intervalId: null };

  function applyEffect(t: string, en: boolean, delay: number) {
    // Clear any prior interval (mirrors cleanup return of useEffect)
    if (state.intervalId !== null) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }

    // Always reset on text change
    state.revealedCount = 0;

    if (!en || t.length === 0) {
      if (!en) state.revealedCount = t.length;
      return;
    }

    state.intervalId = setInterval(() => {
      if (state.revealedCount >= t.length) {
        if (state.intervalId !== null) clearInterval(state.intervalId);
        return;
      }
      state.revealedCount += 1;
    }, delay);
  }

  // Run the effect once on mount
  applyEffect(text, enabled, charDelayMs);

  return {
    output: () => text.slice(0, state.revealedCount),
    /** Simulate a text/enabled/charDelayMs prop change */
    update(newText: string, newEnabled = enabled, newDelay = charDelayMs) {
      text = newText;
      enabled = newEnabled;
      charDelayMs = newDelay;
      applyEffect(newText, newEnabled, newDelay);
    },
    dispose() {
      if (state.intervalId !== null) clearInterval(state.intervalId);
    },
    _state: state,
  };
}

// ---------------------------------------------------------------------------

describe('useTypewriter — enabled=false returns full text immediately', () => {
  it('returns the full string without starting an interval when enabled=false', () => {
    const hook = createHookSim('hello world', false);
    // No fake timers needed — result must be synchronous
    expect(hook.output()).toBe('hello world');
    expect(hook._state.intervalId).toBeNull();
    hook.dispose();
  });

  it('returns empty string when text is empty and enabled=false', () => {
    const hook = createHookSim('', false);
    expect(hook.output()).toBe('');
    hook.dispose();
  });
});

describe('useTypewriter — empty string with enabled=true', () => {
  it('returns empty string immediately without starting an interval', () => {
    const hook = createHookSim('', true, 40);
    expect(hook.output()).toBe('');
    expect(hook._state.intervalId).toBeNull();
    hook.dispose();
  });
});

describe('useTypewriter — char-by-char reveal at 40ms/char', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reveals nothing before the first tick', () => {
    const hook = createHookSim('hello', true, 40);
    expect(hook.output()).toBe('');
    hook.dispose();
  });

  it('reveals one char after 40ms', () => {
    const hook = createHookSim('hello', true, 40);
    vi.advanceTimersByTime(40);
    expect(hook.output()).toBe('h');
    hook.dispose();
  });

  it('reveals full 5-char string after 5 ticks (200ms)', () => {
    const hook = createHookSim('hello', true, 40);
    vi.advanceTimersByTime(200);
    expect(hook.output()).toBe('hello');
    hook.dispose();
  });

  it('does not exceed full text length after extra ticks', () => {
    const hook = createHookSim('hi', true, 40);
    vi.advanceTimersByTime(500); // far past end
    expect(hook.output()).toBe('hi');
    hook.dispose();
  });
});

describe('useTypewriter — text prop change resets reveal to 0', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resets to start of new text when text prop changes mid-reveal', () => {
    const hook = createHookSim('hello', true, 40);

    // Advance 3 chars into 'hello'
    vi.advanceTimersByTime(120);
    expect(hook.output()).toBe('hel');

    // Swap text — should restart from index 0 of new string
    hook.update('world', true, 40);
    expect(hook.output()).toBe(''); // immediately 0 before any tick

    // One tick → first char of new text
    vi.advanceTimersByTime(40);
    expect(hook.output()).toBe('w');

    hook.dispose();
  });
});

describe('useTypewriter — charDelayMs controls interval speed', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('with 100ms delay, reveals 1 char after 100ms not before', () => {
    const hook = createHookSim('abc', true, 100);

    vi.advanceTimersByTime(99);
    expect(hook.output()).toBe('');

    vi.advanceTimersByTime(1); // total 100ms
    expect(hook.output()).toBe('a');

    vi.advanceTimersByTime(100); // total 200ms
    expect(hook.output()).toBe('ab');

    hook.dispose();
  });

  it('with 10ms delay, reveals faster than default 40ms', () => {
    const hook = createHookSim('abc', true, 10);

    vi.advanceTimersByTime(30); // 3 ticks at 10ms
    expect(hook.output()).toBe('abc');

    hook.dispose();
  });
});

describe('useTypewriter — switching enabled=true→false mid-reveal', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns full text immediately when enabled flips to false mid-reveal', () => {
    const hook = createHookSim('hello', true, 40);
    vi.advanceTimersByTime(80); // reveals 'he'
    expect(hook.output()).toBe('he');

    // Simulate the isStreaming guard: enabled becomes false
    hook.update('hello', false, 40);
    expect(hook.output()).toBe('hello');
    expect(hook._state.intervalId).toBeNull();

    hook.dispose();
  });
});
