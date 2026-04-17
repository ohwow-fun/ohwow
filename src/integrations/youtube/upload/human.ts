/**
 * Human-like input helpers for Studio automation.
 *
 * Context (2026-04-17): YouTube Studio flagged our account with a
 * rate-limit warning ("Upload more videos daily after a one-time
 * verification or wait 24 hours") after a few automated stage-as-draft
 * runs. The automation was too fast — every wizard stage completed in
 * single-digit-ms after the 4s processing wait, which is nothing like
 * a human walking the wizard.
 *
 * This module replaces the fast paths with jittered, human-ish ones:
 *
 *   - sleepRandom(min, max) replaces fixed sleeps so no two runs have
 *     the same timing fingerprint.
 *   - humanType() replaces document.execCommand('insertText', … FULL)
 *     one-shot writes with char-by-char Input.insertText calls paced
 *     at ~400-600 CPM with occasional thinking pauses. Mirrors how a
 *     real operator fills the title/description.
 *   - humanClickAt() replaces JS element.click() (which is also
 *     untrusted — Studio rejects those in some places) with a
 *     multi-step Input.dispatchMouseEvent sequence: mouseMoved along a
 *     curved path to the target, a brief hover, then mousePressed +
 *     mouseReleased with a realistic 40-120ms hold.
 *   - readTime() gives callers a reasonable "reading pause" between
 *     stages scaled to how much text just appeared.
 *
 * None of this is bulletproof against adversarial detection — a
 * motivated anti-bot system can fingerprint far more subtle signals.
 * The goal is "looks enough like a careful human to not trip the
 * default rate-limiter on a channel that's otherwise well-behaved."
 */

import type { RawCdpPage } from '../../../execution/browser/raw-cdp.js';

// ---------------------------------------------------------------------------
// Timing primitives
// ---------------------------------------------------------------------------

/** Integer in [min, max]. */
export function jitter(min: number, max: number): number {
  if (max <= min) return min;
  return Math.floor(min + Math.random() * (max - min + 1));
}

export function sleepRandom(minMs: number, maxMs: number): Promise<void> {
  return new Promise((r) => setTimeout(r, jitter(minMs, maxMs)));
}

/**
 * Rough "reading time" for a string of length N. Based on ~250 words
 * per minute average reading speed (5 chars/word average = 1250 chars/min
 * = ~48ms/char), floored at 600ms, capped at 4000ms.
 */
export function readTime(textLength: number): number {
  const ms = Math.min(4_000, Math.max(600, Math.round(textLength * 48)));
  return jitter(Math.round(ms * 0.6), Math.round(ms * 1.2));
}

// ---------------------------------------------------------------------------
// Typing
// ---------------------------------------------------------------------------

export interface HumanTypeOptions {
  /** Per-char delay range. Default 40-120ms (~400-600 CPM). */
  perCharMinMs?: number;
  perCharMaxMs?: number;
  /**
   * Chance (0-1) that any given char triggers an extra "thinking pause"
   * between 200-600ms. Happens more at punctuation boundaries.
   */
  thinkChance?: number;
}

/**
 * Type `text` character by character into the currently focused input
 * via CDP's Input.insertText. The caller is responsible for focusing
 * + selecting-all before calling this; humanType never focuses.
 *
 * Studio's contenteditable title/description boxes accept this cleanly
 * and dispatch the same input/change events a real keystroke would.
 */
export async function humanType(
  page: RawCdpPage,
  text: string,
  opts: HumanTypeOptions = {},
): Promise<void> {
  const minMs = opts.perCharMinMs ?? 40;
  const maxMs = opts.perCharMaxMs ?? 120;
  const thinkChance = opts.thinkChance ?? 0.08;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    await page.send('Input.insertText', { text: ch });
    await sleepRandom(minMs, maxMs);

    // Longer pause after punctuation (clause boundaries) + occasional
    // random "thinking" moment.
    const isPunct = /[.!?,;:]/.test(ch);
    if (isPunct || Math.random() < thinkChance) {
      await sleepRandom(isPunct ? 150 : 200, isPunct ? 400 : 600);
    }
  }
}

// ---------------------------------------------------------------------------
// Mouse movement + click
// ---------------------------------------------------------------------------

export interface HumanClickOptions {
  /** Approx number of movement steps from start to target. Default 14. */
  steps?: number;
  /** Total movement duration ms (across all steps). Default 220-440. */
  totalMinMs?: number;
  totalMaxMs?: number;
  /** Click-hold duration in ms. Default 40-120. */
  holdMinMs?: number;
  holdMaxMs?: number;
}

// We don't know the real cursor position from CDP. Pick a plausible
// "starting point" near the target — as if the user already had their
// mouse roughly in the area — and interpolate from there.
function randomStart(x: number, y: number): { x: number; y: number } {
  const dx = (Math.random() - 0.5) * 360;
  const dy = (Math.random() - 0.5) * 240;
  return { x: x + dx, y: y + dy };
}

/** Quadratic-bezier-ish easing: slow out → fast middle → slow in. */
function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Move the mouse along a curved path from a nearby start point to
 * (x, y), then dispatch mousePressed + mouseReleased at the target.
 *
 * Uses Input.dispatchMouseEvent for both move and click — that path
 * produces "trusted" events from the page's perspective, which matters
 * for handlers that check event.isTrusted (Studio's thumbnail uploader
 * button among them).
 */
export async function humanClickAt(
  page: RawCdpPage,
  x: number,
  y: number,
  opts: HumanClickOptions = {},
): Promise<void> {
  const steps = opts.steps ?? 14;
  const totalMs = jitter(opts.totalMinMs ?? 220, opts.totalMaxMs ?? 440);
  const perStepMs = Math.max(8, Math.round(totalMs / steps));
  const hold = jitter(opts.holdMinMs ?? 40, opts.holdMaxMs ?? 120);

  const start = randomStart(x, y);
  // Control point for a gentle curve — orthogonal offset from midpoint
  // scaled by distance. Makes the path a soft arc instead of a line.
  const mx = (start.x + x) / 2;
  const my = (start.y + y) / 2;
  const dist = Math.hypot(x - start.x, y - start.y);
  const curveAmp = Math.min(80, dist * 0.2);
  const perpAng = Math.atan2(y - start.y, x - start.x) + Math.PI / 2;
  const cx = mx + Math.cos(perpAng) * curveAmp * (Math.random() < 0.5 ? -1 : 1);
  const cy = my + Math.sin(perpAng) * curveAmp * (Math.random() < 0.5 ? -1 : 1);

  for (let i = 1; i <= steps; i += 1) {
    const t = easeInOut(i / steps);
    // Quadratic bezier: (1-t)^2·P0 + 2(1-t)t·C + t^2·P1
    const nt = 1 - t;
    const px = nt * nt * start.x + 2 * nt * t * cx + t * t * x;
    const py = nt * nt * start.y + 2 * nt * t * cy + t * t * y;
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(px + (Math.random() - 0.5) * 1.2),
      y: Math.round(py + (Math.random() - 0.5) * 1.2),
      button: 'none',
    });
    await sleepRandom(Math.max(6, perStepMs - 4), perStepMs + 6);
  }

  // Brief settle pause before the actual click, like a human's "aim".
  await sleepRandom(30, 120);

  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  });
  await new Promise((r) => setTimeout(r, hold));
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  });
}

/**
 * Resolve `selector` to the center of the first visible match's
 * bounding rect, then humanClickAt. Throws if no visible match.
 *
 * Optional `filter` runs in the page and must return true for the
 * element to be considered (used when multiple elements share an id,
 * e.g. Studio's #select-button for upload + thumbnail).
 */
export async function humanClickSelector(
  page: RawCdpPage,
  selector: string,
  opts: HumanClickOptions & { filter?: string; label?: string } = {},
): Promise<void> {
  const filter = opts.filter ?? 'true';
  const coords = await page.evaluate<{ x: number; y: number } | null>(`(() => {
    for (const el of document.querySelectorAll(${JSON.stringify(selector)})) {
      if (el.offsetParent === null) continue;
      if (!(${filter})(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  })()`);
  if (!coords) {
    throw new Error(`humanClickSelector: no visible element for ${opts.label ?? selector}`);
  }
  await humanClickAt(page, coords.x, coords.y, opts);
}
