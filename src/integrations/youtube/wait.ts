/**
 * DOM wait helpers for YouTube Studio flows.
 *
 * Replaces the `sleep(1500)` / `sleep(3000)` pattern in _yt-browser.mjs
 * with selector-aware polls that return as soon as the target state is
 * observed. Each helper throws YTTimeoutError on deadline expiry so
 * callers see *which* wait failed instead of a generic "Next button not
 * found" three stages later.
 *
 * Polling uses page.evaluate at 150ms intervals — matches the cadence
 * already used by RawCdpPage.waitForSelector. Kept deliberately small:
 * these are building blocks, not a framework.
 */

import type { RawCdpPage } from '../../execution/browser/raw-cdp.js';
import { YTSelectorMissingError, YTTimeoutError } from './errors.js';

const POLL_INTERVAL_MS = 150;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface WaitOptions {
  timeoutMs?: number;
  /** When true, require `offsetParent !== null` + non-zero rect. */
  visible?: boolean;
  /** Human-readable label for error messages. */
  label?: string;
}

/**
 * Poll until the selector matches. With `visible: true`, also requires
 * the element to be rendered (non-zero bounding rect, offsetParent set).
 * Throws YTSelectorMissingError on timeout (not YTTimeoutError — the
 * common cause is Studio DOM drift, and we want the selector in meta).
 */
export async function waitForSelector(
  page: RawCdpPage,
  selector: string,
  opts: WaitOptions = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  const expr = opts.visible
    ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; if (el.offsetParent === null) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`
    : `(() => !!document.querySelector(${JSON.stringify(selector)}))()`;
  while (Date.now() < deadline) {
    const present = await page.evaluate<boolean>(expr);
    if (present) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new YTSelectorMissingError(
    selector,
    `waitForSelector: ${opts.label ?? selector} not ${opts.visible ? 'visible' : 'present'} within ${opts.timeoutMs ?? 10_000}ms`,
  );
}

/**
 * Poll until the selector matches NOTHING. Use after clicking a dialog
 * close button to confirm the dialog actually went away — catches the
 * failure mode where the click lands but a confirmation re-mounts the
 * same selector.
 */
export async function waitForNoSelector(
  page: RawCdpPage,
  selector: string,
  opts: WaitOptions = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    const present = await page.evaluate<boolean>(
      `(() => !!document.querySelector(${JSON.stringify(selector)}))()`,
    );
    if (!present) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new YTTimeoutError(
    `waitForNoSelector: ${opts.label ?? selector} still present after ${opts.timeoutMs ?? 10_000}ms`,
    opts.timeoutMs ?? 10_000,
    { selector },
  );
}

/**
 * Poll until a predicate (evaluated in page context) returns true. The
 * predicate string must be a JS expression that evaluates to a boolean
 * — e.g. `"document.querySelector('#foo')?.textContent === 'Done'"`.
 */
export async function waitForPredicate(
  page: RawCdpPage,
  predicateExpr: string,
  opts: WaitOptions = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    const ok = await page.evaluate<boolean>(`(() => { try { return !!(${predicateExpr}); } catch { return false; } })()`);
    if (ok) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new YTTimeoutError(
    `waitForPredicate: ${opts.label ?? 'predicate'} never held within ${opts.timeoutMs ?? 10_000}ms`,
    opts.timeoutMs ?? 10_000,
    { predicateExpr },
  );
}

/**
 * Wait for the text of an element matching `selector` to match `regex`.
 * Used e.g. for the wizard button flipping from "Next" to "Publish" at
 * the final step, or for upload progress strings ("Uploading 45%",
 * "Processing", "Finished processing").
 */
export async function waitForText(
  page: RawCdpPage,
  selector: string,
  regex: RegExp,
  opts: WaitOptions = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  const source = regex.source.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const flags = regex.flags;
  const expr = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const re = new RegExp('${source}', '${flags}'); return re.test(el.textContent || ''); })()`;
  while (Date.now() < deadline) {
    const ok = await page.evaluate<boolean>(expr);
    if (ok) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new YTTimeoutError(
    `waitForText: ${opts.label ?? selector} text never matched ${regex} within ${opts.timeoutMs ?? 10_000}ms`,
    opts.timeoutMs ?? 10_000,
    { selector, regex: String(regex) },
  );
}

/**
 * Wait for a selector to be present AND stable for `stableMs` — i.e. it
 * hasn't been unmounted and re-mounted during that window. Useful for
 * upload progress indicators that blink into existence, mutate, then
 * settle: the upload is truly ready only when the progress bar has been
 * holding its "done" state for a beat.
 *
 * Implementation: every poll, check presence; reset stable-start timer
 * on any disappearance; resolve when `(now - stableStart) >= stableMs`.
 */
export async function waitForSelectorStable(
  page: RawCdpPage,
  selector: string,
  stableMs: number,
  opts: WaitOptions = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  let stableSince: number | null = null;
  while (Date.now() < deadline) {
    const present = await page.evaluate<boolean>(
      `(() => !!document.querySelector(${JSON.stringify(selector)}))()`,
    );
    if (present) {
      if (stableSince === null) stableSince = Date.now();
      if (Date.now() - stableSince >= stableMs) return;
    } else {
      stableSince = null;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new YTTimeoutError(
    `waitForSelectorStable: ${opts.label ?? selector} never stable for ${stableMs}ms within ${opts.timeoutMs ?? 15_000}ms`,
    opts.timeoutMs ?? 15_000,
    { selector, stableMs },
  );
}
