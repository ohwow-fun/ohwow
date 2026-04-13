/**
 * Synthesis Probe — CDP-driven selector manifest extractor
 *
 * Given a URL and a goal description, navigate the user's real logged-
 * in Chrome to that URL and enumerate every element the generator will
 * later need selectors for: `[data-testid="..."]` nodes, plain form
 * inputs, buttons, contenteditable regions. The output manifest is
 * everything a deterministic tool needs to skip the ReAct loop and
 * go straight to playwright calls — exactly the manual work we did
 * on 2026-04-13 to build x_compose_tweet.
 *
 * Why this lives in its own module instead of piggybacking on
 * LocalBrowserService: same reason x-posting.ts does. Stagehand's
 * wrapped Page proxy hides page.keyboard, and the probe needs full
 * Playwright surface access. We connect our own CDP client per call.
 *
 * Two public functions:
 *
 *   1. probeSurface({url, goalDescription, waitMs}) — the end-to-end
 *      entry point. Connects to Chrome, navigates, collects the
 *      manifest, returns it with a screenshot. Used by the synthesis
 *      generator tool and as a debug tool the orchestrator can call
 *      directly from chat.
 *
 *   2. collectManifest(page) — the underlying DOM traversal logic,
 *      isolated so tests can drive it with a mocked page object
 *      without spinning up real Chrome. Every new selector category
 *      should be added here, not in probeSurface.
 *
 * The manifest shape is intentionally boring — flat arrays of
 * {selector, metadata} rather than a DOM tree. The synthesizer
 * prompt pastes it verbatim into the LLM context, so anything
 * structured saves tokens at generation time.
 */

import { logger } from '../../lib/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProbeSurfaceInput {
  /** Absolute URL to probe (https://...). */
  url: string;
  /**
   * One-sentence description of what a future tool built from this
   * manifest will try to do. Not used at probe time, but copied into
   * the returned manifest so the generator has a natural-language
   * anchor next to the selector list.
   */
  goalDescription?: string;
  /** Extra settle time after page load to let SPAs hydrate. Default 2500ms. */
  waitMs?: number;
}

export interface TestidElement {
  testid: string;
  /** CSS selector string that uniquely targets this node. */
  selector: string;
  tag: string;
  role: string | null;
  ariaLabel: string | null;
  placeholder: string | null;
  textContent: string;
  disabled: boolean;
  isTextInput: boolean;
  isButton: boolean;
  rect: { x: number; y: number; w: number; h: number };
}

export interface FormElementSample {
  /** Best-guess CSS selector — testid, id, or tag+name fallback. */
  selector: string;
  tag: 'input' | 'textarea' | 'select' | 'button';
  type: string | null;
  name: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  disabled: boolean;
  rect: { x: number; y: number; w: number; h: number };
}

export interface ContentEditableSample {
  selector: string;
  role: string | null;
  ariaLabel: string | null;
  textLength: number;
  rect: { x: number; y: number; w: number; h: number };
}

export interface SelectorManifest {
  url: string;
  pageTitle: string;
  goalDescription?: string;
  /** Elements carrying `data-testid` — the most stable kind of selector. */
  testidElements: TestidElement[];
  /** `<input>`, `<textarea>`, `<select>`, `<button>` without testids. */
  formElements: FormElementSample[];
  /** `contenteditable` regions (e.g. ProseMirror, Tiptap). */
  contentEditables: ContentEditableSample[];
  /** Free-text notes about the page state that the generator should honor. */
  observations: string[];
  /** Base64 JPEG of the page at probe time, quality 70. */
  screenshotBase64?: string;
  /** ISO timestamp — the manifest is a point-in-time snapshot. */
  probedAt: string;
}

export interface ProbeSurfaceResult {
  success: boolean;
  message: string;
  manifest?: SelectorManifest;
}

// ---------------------------------------------------------------------------
// Minimal structural types for the Playwright surface we actually use.
// Kept independent of playwright-core's public types so tests don't have
// to install Playwright just to stub a page.
// ---------------------------------------------------------------------------

export interface ProbePage {
  goto: (url: string, opts?: { waitUntil?: string; timeout?: number }) => Promise<unknown>;
  url: () => string;
  title: () => Promise<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluate: <T>(fn: string | ((...args: any[]) => T)) => Promise<T>;
  screenshot: (opts?: { type?: 'jpeg' | 'png'; quality?: number }) => Promise<Buffer>;
  on: (event: string, handler: (arg: unknown) => void) => void;
}

interface CdpContext { pages: () => ProbePage[] }
interface CdpBrowser { contexts: () => CdpContext[] }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedPlaywright: any = null;

async function getPlaywright(): Promise<{ chromium: { connectOverCDP: (url: string) => Promise<CdpBrowser> } }> {
  if (!cachedPlaywright) {
    cachedPlaywright = await import('playwright-core');
  }
  return cachedPlaywright;
}

const CDP_URL = 'http://localhost:9222';
const DEFAULT_HYDRATION_WAIT_MS = 2500;

async function getCdpPageForProbe(urlHint?: string): Promise<ProbePage | null> {
  try {
    const pw = await getPlaywright();
    const browser = await pw.chromium.connectOverCDP(CDP_URL);
    const contexts = browser.contexts();
    if (contexts.length === 0) return null;
    const pages = contexts[0].pages();
    if (pages.length === 0) return null;

    let page: ProbePage | undefined;
    if (urlHint) page = pages.find((p) => p.url().includes(urlHint));
    if (!page) page = pages[0];

    // Suppress beforeunload dialogs so navigation is deterministic —
    // the probe doesn't care about existing compose drafts.
    page.on('dialog', (d: unknown) => {
      (d as { accept: () => Promise<void> }).accept().catch(() => {});
    });
    await page.evaluate(`(() => {
      try {
        window.onbeforeunload = null;
        window.addEventListener('beforeunload', (e) => {
          e.stopImmediatePropagation && e.stopImmediatePropagation();
          delete e.returnValue;
        }, { capture: true });
      } catch {}
      return true;
    })()`).catch(() => {});
    return page;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, '[synthesis-probe] CDP connect failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Manifest collection (DOM-side script + Node-side orchestration)
// ---------------------------------------------------------------------------

/**
 * The DOM-side script that runs inside `page.evaluate`. Returns a
 * plain-object manifest payload that we merge with the Node-side
 * metadata (url/title/screenshot) into the final SelectorManifest.
 *
 * Inlined as a template-string so the function body can be stringified
 * and sent over CDP. Do not add closures or imports to this function —
 * anything it references must be available inside the browser runtime.
 */
const COLLECT_SCRIPT = `(() => {
  const MAX_TEXT = 120;
  const MAX_TESTIDS = 80;
  const MAX_FORMS = 80;
  const MAX_CE = 30;

  const cssEscape = (v) => (window.CSS && window.CSS.escape) ? window.CSS.escape(v) : String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\\\' + c);
  const text = (el) => ((el && el.textContent) || '').trim().replace(/\\s+/g, ' ').slice(0, MAX_TEXT);
  const rectOf = (el) => {
    try {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    } catch {
      return { x: 0, y: 0, w: 0, h: 0 };
    }
  };

  const testidElements = [];
  const seenNodes = new Set();
  const testidNodes = Array.from(document.querySelectorAll('[data-testid]')).slice(0, MAX_TESTIDS);
  for (const el of testidNodes) {
    seenNodes.add(el);
    const testid = el.getAttribute('data-testid') || '';
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const role = el.getAttribute('role');
    const ariaLabel = el.getAttribute('aria-label');
    const placeholder = el.getAttribute('placeholder');
    const disabledAttr = el.getAttribute('disabled');
    const isTextInput = tag === 'input' || tag === 'textarea' || el.hasAttribute('contenteditable') || role === 'textbox';
    const isButton = tag === 'button' || role === 'button';
    testidElements.push({
      testid,
      selector: '[data-testid="' + cssEscape(testid).replace(/\\\\/g, '') + '"]',
      tag,
      role: role || null,
      ariaLabel: ariaLabel || null,
      placeholder: placeholder || null,
      textContent: text(el),
      disabled: disabledAttr !== null,
      isTextInput,
      isButton,
      rect: rectOf(el),
    });
  }

  const formElements = [];
  const formNodes = Array.from(document.querySelectorAll('input, textarea, select, button')).slice(0, 200);
  for (const el of formNodes) {
    if (seenNodes.has(el)) continue;
    if (formElements.length >= MAX_FORMS) break;
    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute('name');
    const type = el.getAttribute('type');
    const id = el.id;
    const placeholder = el.getAttribute('placeholder');
    const ariaLabel = el.getAttribute('aria-label');
    let selector = tag;
    if (id) selector = tag + '#' + cssEscape(id);
    else if (name) selector = tag + '[name="' + cssEscape(name).replace(/\\\\/g, '') + '"]';
    else if (placeholder) selector = tag + '[placeholder="' + placeholder.replace(/"/g, '\\\\"') + '"]';
    formElements.push({
      selector,
      tag,
      type: type || null,
      name: name || null,
      placeholder: placeholder || null,
      ariaLabel: ariaLabel || null,
      disabled: el.hasAttribute('disabled'),
      rect: rectOf(el),
    });
  }

  const contentEditables = [];
  const ceNodes = Array.from(document.querySelectorAll('[contenteditable="true"], [contenteditable=""], [role="textbox"]')).slice(0, 100);
  for (const el of ceNodes) {
    if (seenNodes.has(el)) continue;
    if (contentEditables.length >= MAX_CE) break;
    const role = el.getAttribute('role');
    const ariaLabel = el.getAttribute('aria-label');
    let selector = el.tagName.toLowerCase();
    if (el.id) selector += '#' + cssEscape(el.id);
    else if (role === 'textbox') selector += '[role="textbox"]';
    else selector += '[contenteditable]';
    contentEditables.push({
      selector,
      role: role || null,
      ariaLabel: ariaLabel || null,
      textLength: (el.textContent || '').length,
      rect: rectOf(el),
    });
  }

  const observations = [];
  try {
    if (document.querySelector('div[role="dialog"]')) observations.push('modal dialog is mounted');
    if (document.body && document.body.getAttribute('data-hydrated') === 'true') observations.push('body[data-hydrated=true]');
    if (window.onbeforeunload) observations.push('onbeforeunload handler installed');
    if (document.querySelector('meta[name="robots"][content*="noindex"]')) observations.push('page is noindex');
    const h1 = document.querySelector('h1');
    if (h1) observations.push('h1: ' + text(h1));
  } catch {}

  return { testidElements, formElements, contentEditables, observations };
})()`;

interface CollectPayload {
  testidElements: TestidElement[];
  formElements: FormElementSample[];
  contentEditables: ContentEditableSample[];
  observations: string[];
}

/**
 * Run the DOM-side script in the given page and unwrap the result.
 * Exposed separately from probeSurface so unit tests can drive it
 * with a mocked page that returns a canned payload from evaluate().
 */
export async function collectManifest(page: ProbePage): Promise<CollectPayload> {
  const payload = await page.evaluate<CollectPayload>(COLLECT_SCRIPT);
  return {
    testidElements: Array.isArray(payload?.testidElements) ? payload.testidElements : [],
    formElements: Array.isArray(payload?.formElements) ? payload.formElements : [],
    contentEditables: Array.isArray(payload?.contentEditables) ? payload.contentEditables : [],
    observations: Array.isArray(payload?.observations) ? payload.observations : [],
  };
}

// ---------------------------------------------------------------------------
// Public tool entry point
// ---------------------------------------------------------------------------

export async function probeSurface(input: ProbeSurfaceInput): Promise<ProbeSurfaceResult> {
  const url = (input.url || '').trim();
  if (!url || !/^https?:\/\//.test(url)) {
    return { success: false, message: 'input.url must be an absolute http(s) URL' };
  }
  const waitMs = typeof input.waitMs === 'number' && input.waitMs >= 0 ? input.waitMs : DEFAULT_HYDRATION_WAIT_MS;

  const page = await getCdpPageForProbe('x.com');
  if (!page) {
    return { success: false, message: 'Could not attach to Chrome CDP at :9222. Is the debug Chrome running?' };
  }

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    return {
      success: false,
      message: `Navigation to ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  await new Promise((resolve) => setTimeout(resolve, waitMs));

  const landedUrl = page.url();
  const pageTitle = await page.title().catch(() => '');

  let collected: CollectPayload;
  try {
    collected = await collectManifest(page);
  } catch (err) {
    return {
      success: false,
      message: `Manifest collection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let screenshotBase64: string | undefined;
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
    screenshotBase64 = buf.toString('base64');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, '[synthesis-probe] screenshot failed');
  }

  const manifest: SelectorManifest = {
    url: landedUrl,
    pageTitle,
    goalDescription: input.goalDescription,
    testidElements: collected.testidElements,
    formElements: collected.formElements,
    contentEditables: collected.contentEditables,
    observations: collected.observations,
    screenshotBase64,
    probedAt: new Date().toISOString(),
  };

  return {
    success: true,
    message: `Probed ${landedUrl} — ${manifest.testidElements.length} testid nodes, ${manifest.formElements.length} form elements, ${manifest.contentEditables.length} contenteditables`,
    manifest,
  };
}
