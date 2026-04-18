/**
 * CDP-driven desktop streaming helper.
 *
 * Wraps Chromium's `Page.startScreencast` / `Page.stopScreencast` /
 * `Page.screencastFrame` event triad so callers can fan JPEG frames
 * out to WebSocket subscribers (see `src/api/screencast-websocket.ts`)
 * without learning the CDP surface themselves.
 *
 * Design notes:
 *  - One `RawCdpBrowser` connection per active target is the caller's
 *    responsibility. Most callers use `ensureCdpBrowser` + attach the
 *    returned `RawCdpPage` to this helper's `sessionId` argument.
 *  - CDP frames come with their own per-frame `sessionId` (different
 *    from the WS session id and different from the CDP-attach
 *    sessionId). We MUST ack each one via `Page.screencastFrameAck` or
 *    Chrome throttles subsequent frames to a trickle and eventually
 *    stops emitting entirely. The ack carries the per-frame id, not
 *    ours.
 *  - `everyNthFrame` is Chrome's coarse throttle (skip N-1 frames per
 *    N emitted). Chrome's own capture loop is usually 60fps, so
 *    `everyNthFrame: 3` lands around 20fps and `everyNthFrame: 2`
 *    around 30fps. We aim for ~24fps via both the CDP flag and a
 *    time-guard inside the frame handler.
 */

import { logger } from '../../lib/logger.js';
import type { RawCdpBrowser } from './raw-cdp.js';

export interface ScreencastFrame {
  /** Base64-encoded JPEG data. Raw CDP payload, no data-URL prefix. */
  data: string;
  /** CDP attach session id this frame was captured against. */
  sessionId: string;
  /** CDP-reported capture timestamp (seconds since epoch, with fractional millis). Optional — CDP does not always include it. */
  timestamp?: number;
  /** Raw CDP metadata blob (scroll offsets, viewport dims, etc.). */
  metadata?: Record<string, unknown>;
}

export interface StartScreencastOptions {
  /** JPEG quality 0–100. Defaults to 60 — customer-visible streaming target. */
  quality?: number;
  /** Max width in device pixels. Defaults to 1280. */
  maxWidth?: number;
  /** Max height in device pixels. Defaults to 720. */
  maxHeight?: number;
  /** Target effective frame rate. Defaults to 24fps. */
  targetFps?: number;
}

/**
 * Default coarse "capture every Nth frame" value for Chrome's
 * screencast. Chrome's own capture loop runs at roughly 60fps, so
 * `everyNthFrame: 3` lands near 20fps of emitted frames, then the
 * time-guard inside onFrame trims the rest down to targetFps.
 */
const DEFAULT_EVERY_NTH_FRAME = 3;

interface ActiveScreencast {
  /** Listener disposer for `Page.screencastFrame`. Call on stop. */
  offFrame: () => void;
  /** Minimum milliseconds between forwarded frames (the 24fps guard). */
  minFrameIntervalMs: number;
  lastForwardedAt: number;
}

// Module-level registry: one active screencast per (browser, sessionId)
// pair. Keyed by the CDP attach session id — two concurrent callers
// against the same browser need distinct session ids anyway, which is
// the normal case because each `attachToPage` yields a fresh one.
const active = new Map<string, ActiveScreencast>();

/**
 * Start a CDP screencast against the attach session `sessionId`.
 *
 * `onFrame` fires for every forwarded frame (after the time-guard).
 * Frames that arrive faster than `targetFps` are dropped *here*, not
 * floored at the browser, so Chrome keeps capturing at native rate and
 * our consumers control perceived fluidity.
 */
export async function startScreencast(
  raw: RawCdpBrowser,
  sessionId: string,
  onFrame: (frame: ScreencastFrame) => void,
  opts: StartScreencastOptions = {},
): Promise<void> {
  if (active.has(sessionId)) {
    logger.debug({ sessionId }, '[screencast] startScreencast called for already-active session; ignoring');
    return;
  }

  const quality = opts.quality ?? 60;
  const maxWidth = opts.maxWidth ?? 1280;
  const maxHeight = opts.maxHeight ?? 720;
  const targetFps = Math.max(1, Math.min(60, opts.targetFps ?? 24));
  const minFrameIntervalMs = Math.floor(1000 / targetFps);

  const entry: ActiveScreencast = {
    offFrame: () => { /* replaced below */ },
    minFrameIntervalMs,
    lastForwardedAt: 0,
  };
  active.set(sessionId, entry);

  // Subscribe BEFORE we issue Page.startScreencast so we don't miss
  // the very first frame Chrome may emit synchronously after the
  // command resolves.
  const offFrame = raw.on('Page.screencastFrame', (params, frameSessionId) => {
    // Only handle frames for our CDP attach session.
    if (frameSessionId !== sessionId) return;

    const p = params as {
      data?: string;
      sessionId?: number;
      metadata?: { timestamp?: number } & Record<string, unknown>;
    };
    if (!p || typeof p.data !== 'string' || typeof p.sessionId !== 'number') {
      // Malformed frame — still best-effort ack so Chrome keeps streaming.
      return;
    }

    // ACK FIRST so Chrome keeps emitting even if our forwarder bails.
    raw.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sessionId).catch((err) => {
      logger.debug(
        { err: err instanceof Error ? err.message : err, sessionId },
        '[screencast] screencastFrameAck failed (non-fatal)',
      );
    });

    // Time-guard throttle: drop frames that arrive faster than target.
    const now = Date.now();
    const current = active.get(sessionId);
    if (!current) return;
    if (now - current.lastForwardedAt < current.minFrameIntervalMs) return;
    current.lastForwardedAt = now;

    try {
      onFrame({
        data: p.data,
        sessionId,
        timestamp: p.metadata?.timestamp,
        metadata: p.metadata as Record<string, unknown> | undefined,
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, sessionId },
        '[screencast] onFrame handler threw',
      );
    }
  });
  entry.offFrame = offFrame;

  try {
    await raw.send(
      'Page.startScreencast',
      {
        format: 'jpeg',
        quality,
        maxWidth,
        maxHeight,
        everyNthFrame: DEFAULT_EVERY_NTH_FRAME,
      },
      sessionId,
    );
    logger.info(
      { sessionId, quality, maxWidth, maxHeight, targetFps },
      '[screencast] Page.startScreencast issued',
    );
  } catch (err) {
    // Rollback: stop listening and drop the registry entry so the
    // caller can retry without us thinking a screencast is already up.
    offFrame();
    active.delete(sessionId);
    throw err;
  }
}

/**
 * Stop the screencast against `sessionId`. Idempotent — safe to call
 * when no screencast is active for this session. Swallows CDP errors
 * because the most common cause of `Page.stopScreencast` failing is
 * that the target was already closed, which is exactly when callers
 * most need `stopScreencast` to "just work".
 */
export async function stopScreencast(raw: RawCdpBrowser, sessionId: string): Promise<void> {
  const entry = active.get(sessionId);
  if (!entry) return;

  active.delete(sessionId);
  try { entry.offFrame(); } catch { /* ignore */ }

  try {
    await raw.send('Page.stopScreencast', {}, sessionId);
    logger.info({ sessionId }, '[screencast] Page.stopScreencast issued');
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err, sessionId },
      '[screencast] Page.stopScreencast failed (likely target already gone)',
    );
  }
}

/**
 * Diagnostic: is a screencast currently active against this attach
 * sessionId? Used by tests and by the WS bridge to avoid double-starts.
 */
export function isScreencastActive(sessionId: string): boolean {
  return active.has(sessionId);
}
