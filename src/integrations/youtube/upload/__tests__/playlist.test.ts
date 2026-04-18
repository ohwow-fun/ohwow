/**
 * Regression coverage for the 2026-04-18 playlist-picker timeout fix.
 *
 * Prior behavior: openPicker waited 4000ms for the "New playlist" button
 * to become interactable, then threw a generic "picker interactive never
 * held within 4000ms". Studio occasionally takes 4-7s on first-mount,
 * especially on a cold profile session, so the wait stalled the publish
 * pipeline with no diagnostic about what actually happened in the DOM.
 *
 * Fix (this commit):
 *   - bumped the wait to 8000ms
 *   - on timeout, readPickerDiag snapshots selector state and the thrown
 *     YTUploadError carries a human-readable summary so a future failure
 *     tells the operator which selectors matched and which didn't
 *   - --no-playlist / skipPlaylist is the explicit escape hatch; the
 *     upload-layer predicate shouldRunPlaylistStage enforces that
 *     skipPlaylist: true suppresses the stage even if a playlist name
 *     is set.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { YTUploadError } from '../../errors.js';
import { shouldRunPlaylistStage } from '../index.js';
import { selectPlaylist } from '../playlist.js';

// ---------------------------------------------------------------------------
// Mock RawCdpPage — minimal surface: evaluate() (reads/writes DOM state) and
// send() (humanClickAt dispatches mouse events through this). Tests hand
// a script of evaluate return values; send() is recorded but ignored.
// ---------------------------------------------------------------------------
interface MockPage {
  evaluate: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

function makePage(evaluateQueue: Array<unknown | ((expr: string) => unknown)>): MockPage {
  let idx = 0;
  return {
    evaluate: vi.fn(async (_expr: string) => {
      if (idx >= evaluateQueue.length) {
        throw new Error(`evaluate called more times than scripted (idx=${idx})`);
      }
      const next = evaluateQueue[idx];
      idx += 1;
      if (typeof next === 'function') return (next as (expr: string) => unknown)(_expr);
      return next;
    }),
    send: vi.fn(async () => ({})),
  };
}

describe('shouldRunPlaylistStage', () => {
  it('runs when playlist is set and skipPlaylist is unset', () => {
    expect(shouldRunPlaylistStage({ playlist: 'Daily AI News' })).toBe(true);
  });

  it('skips when skipPlaylist is true, even if a playlist name is set', () => {
    expect(
      shouldRunPlaylistStage({ playlist: 'Daily AI News', skipPlaylist: true }),
    ).toBe(false);
  });

  it('skips when no playlist name is provided', () => {
    expect(shouldRunPlaylistStage({})).toBe(false);
  });

  it('skips when both flags absent', () => {
    expect(shouldRunPlaylistStage({ skipPlaylist: false })).toBe(false);
  });
});

describe('selectPlaylist — picker-interactive timeout diagnostic', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws YTUploadError with DOM-state diagnostic when the New button never mounts', async () => {
    // Sequence of evaluate() calls during the flow:
    //   1) revealTrigger presence check -> trigger IS visible (skip expand path)
    //   2) readChipNames -> [] (no existing binding)
    //   3) openPicker: trigger coords -> valid coords
    //   ... humanClickAt does NOT call page.evaluate (it uses page.send only)
    //   4..N) waitForPredicate polls for visible New button -> always false
    //   N+1) readPickerDiag snapshot at timeout
    //
    // We scripted enough "false" returns to outlast the poll loop at
    // 150ms intervals for 8000ms (~54 polls); vi.useFakeTimers lets the
    // loop drain fast without real wall time.
    const diagSnapshot = {
      dialogPresent: true,
      dialogVisible: false,
      newButtonPresent: false,
      newButtonVisible: false,
      rowsCount: 0,
      visibleRowsCount: 0,
    };

    let call = 0;
    const page = {
      evaluate: vi.fn(async (expr: string) => {
        call += 1;
        // 1st call: revealTrigger visibility check
        if (call === 1) return true;
        // 2nd call: readChipNames
        if (call === 2) return [];
        // 3rd call: openPicker trigger coords
        if (call === 3) return { x: 100, y: 200 };
        // From call 4 onward: either the waitForPredicate poll or the
        // diagnostic read at the end. The diagnostic predicate is the
        // ONLY one that returns an object (the shape above); everything
        // else is the boolean "New button visible?" predicate.
        // We return false for any expression that looks like the predicate,
        // and the diag snapshot for the one that looks like a diag read.
        if (expr.includes('visibleRowsCount')) {
          return diagSnapshot;
        }
        return false;
      }),
      send: vi.fn(async () => ({})),
    };

    const promise = selectPlaylist(page as never, {
      name: 'Daily AI News',
      createIfMissing: true,
    });
    // Swallow the rejection on the original promise handle so vitest
    // doesn't report an "unhandled rejection" after we catch it below.
    // We still assert on the error shape via the captured value.
    promise.catch(() => { /* observed via `captured` below */ });

    // Let fake timers drain through the poll loop.
    await vi.runAllTimersAsync();

    let captured: unknown = null;
    try {
      await promise;
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(YTUploadError);
    expect(captured).toMatchObject({ stage: 'select_playlist' });
    const msg = (captured as Error).message;
    expect(msg).toMatch(/picker never became interactive within 8000ms/);
    // Diagnostic summary must be in the message so operators can tell
    // what actually happened without attaching a debugger.
    expect(msg).toMatch(/dialog\[present=true,visible=false\]/);
    expect(msg).toMatch(/newButton\[present=false,visible=false\]/);
    expect(msg).toMatch(/rows\[total=0,visible=0\]/);
    expect(msg).toMatch(/--no-playlist/);
  });
});
