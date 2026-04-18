import { describe, expect, it, vi } from 'vitest';

import type { CdpTargetInfo } from '../../../execution/browser/raw-cdp.js';
import { YTSessionError } from '../errors.js';
import { pickSpawnableFallbackContext, rankFallbackContexts, type ProbeBrowser } from '../session.js';

/**
 * Regression coverage for pickFallbackContext's read-only-partition fix.
 *
 * Before: the function returned the first youtube.com tab's
 * browserContextId. Chrome's read-only profile partitions (seen in
 * "Profile 1" / 9222 debug setups) silently accept the id in CDP
 * metadata but reject Target.createTarget with -32000 "Failed to find
 * browser context …". The publish pipeline hit that and stalled.
 *
 * After: pickSpawnableFallbackContext probes each candidate with a
 * throwaway about:blank target and skips -32000 rejections, falling
 * through to a sibling context that actually spawns. Non -32000 errors
 * are re-thrown so transport failures still surface.
 */

function target(url: string, contextId: string | null, targetId = 't-' + url): CdpTargetInfo {
  return { targetId, type: 'page', title: url, url, browserContextId: contextId };
}

function missingCtxError(): Error {
  // Matches the shape `raw-cdp.send()` produces when the browser-side
  // CDP error comes back as { code: -32000, message: "Failed to find
  // browser context with id ..." } — the class serializes via
  // JSON.stringify(err).
  return new Error(JSON.stringify({ code: -32000, message: 'Failed to find browser context with id deadbeef' }));
}

function makeProbe(spec: {
  onCreate: (ctxId: string) => Promise<string>;
}): ProbeBrowser & {
  createTargetInContext: ReturnType<typeof vi.fn>;
  closeTarget: ReturnType<typeof vi.fn>;
} {
  const createTargetInContext = vi.fn(spec.onCreate);
  const closeTarget = vi.fn(async (_: string) => {
    // noop — matches RawCdpBrowser.closeTarget's best-effort surface.
  });
  return { createTargetInContext, closeTarget };
}

describe('pickSpawnableFallbackContext', () => {
  it('skips a read-only candidate and returns the next one (no close on the skipped probe)', async () => {
    // Two candidates. The first (youtube.com, CTX_A) throws -32000.
    // The second (x.com, CTX_B) succeeds.
    const targets: CdpTargetInfo[] = [
      target('https://www.youtube.com/watch?v=xyz', 'CTX_A', 't-yt'),
      target('https://x.com/home', 'CTX_B', 't-x'),
    ];
    const probe = makeProbe({
      onCreate: async (ctxId: string) => {
        if (ctxId === 'CTX_A') throw missingCtxError();
        if (ctxId === 'CTX_B') return 'probe-tab-b';
        throw new Error('unexpected ctx ' + ctxId);
      },
    });

    const picked = await pickSpawnableFallbackContext(probe, targets);

    expect(picked.contextId).toBe('CTX_B');
    // createTargetInContext called twice, once per candidate, in order
    expect(probe.createTargetInContext).toHaveBeenCalledTimes(2);
    expect(probe.createTargetInContext.mock.calls[0][0]).toBe('CTX_A');
    expect(probe.createTargetInContext.mock.calls[1][0]).toBe('CTX_B');
    // closeTarget is called ONCE — only for the probe that actually opened
    expect(probe.closeTarget).toHaveBeenCalledTimes(1);
    expect(probe.closeTarget).toHaveBeenCalledWith('probe-tab-b');
  });

  it('single spawnable candidate: returns it and closes the probe tab', async () => {
    const targets: CdpTargetInfo[] = [
      target('https://www.youtube.com/watch?v=abc', 'CTX_ONLY'),
    ];
    const probe = makeProbe({
      onCreate: async () => 'probe-only',
    });

    const picked = await pickSpawnableFallbackContext(probe, targets);

    expect(picked.contextId).toBe('CTX_ONLY');
    expect(probe.createTargetInContext).toHaveBeenCalledTimes(1);
    expect(probe.closeTarget).toHaveBeenCalledTimes(1);
    expect(probe.closeTarget).toHaveBeenCalledWith('probe-only');
  });

  it('single read-only candidate: throws structured no_spawnable_context error', async () => {
    const targets: CdpTargetInfo[] = [
      target('https://www.youtube.com/watch?v=ghi', 'CTX_DEAD'),
    ];
    const probe = makeProbe({
      onCreate: async () => {
        throw missingCtxError();
      },
    });

    await expect(pickSpawnableFallbackContext(probe, targets)).rejects.toMatchObject({
      name: 'YTSessionError',
      meta: expect.objectContaining({ code: 'no_spawnable_context' }),
    });
    // Error is specifically YTSessionError (stable contract for callers)
    await expect(pickSpawnableFallbackContext(probe, targets)).rejects.toBeInstanceOf(YTSessionError);
    // closeTarget never called — probe never opened
    expect(probe.closeTarget).not.toHaveBeenCalled();
  });

  it('re-throws a non-32000 error verbatim (e.g., transport failure)', async () => {
    const targets: CdpTargetInfo[] = [
      target('https://www.youtube.com/watch?v=jkl', 'CTX_DOWN'),
    ];
    const transportErr = new Error('CDP websocket not open');
    const probe = makeProbe({
      onCreate: async () => { throw transportErr; },
    });

    await expect(pickSpawnableFallbackContext(probe, targets)).rejects.toBe(transportErr);
    // Must not be dressed up as a YTSessionError — -32000 skip path is
    // strictly scoped to Chrome's read-only-partition case.
    await expect(pickSpawnableFallbackContext(probe, targets)).rejects.not.toBeInstanceOf(YTSessionError);
  });

  it('three candidates, middle one read-only: returns the FIRST (priority preserved)', async () => {
    // Priority ranking:
    //   1. studio.youtube.com
    //   2. other youtube.com
    //   3. x.com / twitter.com
    // So with studio + youtube-watch + x, studio is tier 1 and returned first.
    // The "middle one read-only" scenario tests that a broken mid-priority
    // context doesn't get promoted past the valid top-priority context.
    const targets: CdpTargetInfo[] = [
      target('https://studio.youtube.com/channel/UC123', 'CTX_STUDIO', 't-studio'),
      target('https://www.youtube.com/watch?v=mid', 'CTX_MID_READONLY', 't-mid'),
      target('https://x.com/home', 'CTX_X', 't-x'),
    ];
    const probe = makeProbe({
      onCreate: async (ctxId: string) => {
        if (ctxId === 'CTX_MID_READONLY') throw missingCtxError();
        if (ctxId === 'CTX_STUDIO') return 'probe-studio';
        if (ctxId === 'CTX_X') return 'probe-x';
        throw new Error('unexpected ctx ' + ctxId);
      },
    });

    const picked = await pickSpawnableFallbackContext(probe, targets);

    // Should be the first candidate (studio), not the third (x).
    expect(picked.contextId).toBe('CTX_STUDIO');
    // Only the studio probe is ever tried — the middle/bottom tiers
    // aren't reached because the top succeeded first.
    expect(probe.createTargetInContext).toHaveBeenCalledTimes(1);
    expect(probe.createTargetInContext).toHaveBeenCalledWith('CTX_STUDIO', 'about:blank');
    expect(probe.closeTarget).toHaveBeenCalledWith('probe-studio');
  });
});

describe('rankFallbackContexts', () => {
  it('orders candidates by tier and de-dupes by contextId', () => {
    // Two youtube tabs share CTX_YT; a single x.com tab uses CTX_X; one
    // context-less tab is dropped.
    const targets: CdpTargetInfo[] = [
      target('https://www.youtube.com/watch?v=a', 'CTX_YT', 't1'),
      target('https://www.youtube.com/feed/subscriptions', 'CTX_YT', 't2'),
      target('https://x.com/explore', 'CTX_X', 't3'),
      target('about:blank', null, 't4'),
      target('https://studio.youtube.com', 'CTX_STUDIO', 't5'),
    ];
    const ranked = rankFallbackContexts(targets);
    expect(ranked.map((r) => r.contextId)).toEqual(['CTX_STUDIO', 'CTX_YT', 'CTX_X']);
  });
});
