/**
 * X (Twitter) browser tools — drive the user's real logged-in Chrome
 * via CDP to post tweets, threads, articles, and DMs. No API key, no
 * cloud proxy: every action goes out from the user's own Chrome
 * session exactly as if they'd done it by hand.
 *
 * Why this bypasses LocalBrowserService:
 *
 * The daemon's LocalBrowserService wraps Stagehand, which in turn
 * wraps a Playwright Page with its own proxy. External callers that
 * receive `service.getPage()` don't see `page.keyboard` — it's hidden
 * behind the Stagehand wrapper. That means every tool call that tries
 * to type into a ProseMirror / contenteditable fails with
 * `Cannot read properties of undefined (reading 'type')`.
 *
 * Instead, we let the orchestrator activate the browser through the
 * normal path (request_browser → activateBrowser → connectToChrome
 * launches real Chrome with the right profile at port 9222), then we
 * connect our OWN playwright-core instance over CDP to the same
 * running Chrome. CDP supports multiple clients on the same target,
 * so Stagehand and our connection coexist without interfering.
 *
 * Safety defaults:
 *   - `dry_run: true` is the default for every write tool. The tool
 *     composes in the UI and screenshots it but does NOT submit
 *     unless the caller passes `dry_run: false`.
 *   - All text is length-checked client-side before any browser work.
 *
 * Proven selectors (verified live on ohwow_fun account, 2026-04-13):
 *   - Tweet compose textbox: `div[data-testid="tweetTextarea_0"][role="textbox"]`
 *   - Tweet publish:         `[data-testid="tweetButton"]`
 *   - Thread add row:        `[data-testid="addButton"]` → next row is `tweetTextarea_N`
 *   - Delete tweet:          article tweet → `[data-testid="caret"]` →
 *                            role=menuitem text "Delete" →
 *                            `[data-testid="confirmationSheetConfirm"]`
 *   - DM inbox list:         `[data-testid^="dm-conversation-item-<id1>:<id2>"]`
 *   - DM conversation URL:   `https://x.com/i/chat/<id1>-<id2>` (hyphen)
 *   - DM composer input:     `textarea[data-testid="dm-composer-textarea"]`
 *   - DM send button:        `[data-testid="dm-composer-send-button"]`
 *                            (ONLY visible after text is in the textarea)
 *   - Article landing:       `https://x.com/compose/articles` (plural!)
 *   - Article editor URL:    `https://x.com/compose/articles/edit/<draftId>`
 *   - Article title input:   `textarea[placeholder="Add a title"]`
 *   - Article body editor:   `[data-testid="composer"]` (contenteditable)
 *   - Article publish:       button with text "Publish"
 *
 * Gotchas:
 *   - `page.click()` (not `element.click()`) is required — X's React
 *     onClick handlers don't fire on programmatic element clicks.
 *   - `execCommand('insertText')` populates the DOM but doesn't wake
 *     React — Post stays disabled. Use `page.keyboard.type()` which
 *     fires real input events.
 *   - Navigating away from compose with unsaved text triggers a
 *     beforeunload dialog. Install a `page.on('dialog', d => d.accept())`
 *     handler and null out `window.onbeforeunload` before any goto.
 */

import { logger } from '../../lib/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComposeTweetInput {
  text: string;
  dryRun?: boolean;
}

export interface ComposeThreadInput {
  tweets: string[];
  dryRun?: boolean;
}

export interface ComposeArticleInput {
  title: string;
  body: string;
  dryRun?: boolean;
}

export interface SendDmInput {
  /**
   * Either:
   *   - the `<id1>:<id2>` pair used in X's `dm-conversation-item-<pair>` testid
   *   - the `<id1>-<id2>` path segment used in `/i/chat/<pair>` URLs
   * If neither is present, the tool falls back to selecting by `handle`.
   */
  conversationPair?: string;
  /** Recipient handle without the leading `@`, e.g. `jack`. Used as a fallback when no pair is provided. */
  handle?: string;
  text: string;
  dryRun?: boolean;
}

export interface ListDmsInput {
  limit?: number;
}

export interface DeleteLastTweetInput {
  /** Handle of the profile to delete from. Usually the active account. */
  handle: string;
  /** Substring to match — picks the most recent tweet whose text contains this marker. */
  marker: string;
  dryRun?: boolean;
}

export interface ComposeResult {
  success: boolean;
  message: string;
  screenshotBase64?: string;
  tweetsTyped?: number;
  tweetsPublished?: number;
  currentUrl?: string;
  /** For DM/article tools: the page URL or DM pair at the end of the flow. */
  landedAt?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TWEET_LENGTH = 280;
const COMPOSE_URL = 'https://x.com/compose/post';
const DM_INBOX_URL = 'https://x.com/i/chat';
const ARTICLE_LANDING_URL = 'https://x.com/compose/articles';
const CDP_URL = 'http://localhost:9222';

const HYDRATION_WAIT_MS = 2500;
const POST_SETTLE_MS = 3000;
const KEYBOARD_DELAY_MS = 15;

// ---------------------------------------------------------------------------
// CDP connection
// ---------------------------------------------------------------------------

// Minimal structural types for the Playwright surface we use. Avoids
// taking a hard dep on playwright-core's public types — we import
// lazily and the module may be absent in some test harnesses.
type CdpPage = {
  goto: (url: string, opts?: { waitUntil?: string; timeout?: number }) => Promise<unknown>;
  url: () => string;
  title: () => Promise<string>;
  evaluate: <T>(fn: string | ((...args: unknown[]) => T)) => Promise<T>;
  click: (selector: string, opts?: { timeout?: number }) => Promise<void>;
  waitForSelector: (selector: string, opts?: { state?: string; timeout?: number }) => Promise<unknown>;
  screenshot: (opts?: { type?: 'jpeg' | 'png'; quality?: number }) => Promise<Buffer>;
  keyboard: {
    type: (text: string, opts?: { delay?: number }) => Promise<void>;
    press: (key: string) => Promise<void>;
  };
  on: (event: string, handler: (arg: unknown) => void) => void;
};

type CdpContext = { pages: () => CdpPage[] };
type CdpBrowser = { contexts: () => CdpContext[] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedPlaywright: any = null;

async function getPlaywright(): Promise<{ chromium: { connectOverCDP: (url: string) => Promise<CdpBrowser> } }> {
  if (!cachedPlaywright) {
    cachedPlaywright = await import('playwright-core');
  }
  return cachedPlaywright;
}

/**
 * Connect to the already-running debug Chrome at `CDP_URL` and return
 * a Playwright Page we can drive. Caller is responsible for ensuring
 * Chrome is up (via `ctx.browserState.activate()` in tool-executor).
 *
 * This does NOT close the browser when done — that'd kill Chrome for
 * the rest of the daemon. We just let the reference fall out of scope.
 */
async function getCdpPage(urlHint?: string): Promise<CdpPage | null> {
  try {
    const pw = await getPlaywright();
    const browser = await pw.chromium.connectOverCDP(CDP_URL);
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      logger.warn('[x-posting] CDP browser has no contexts');
      return null;
    }
    const ctx = contexts[0];
    const pages = ctx.pages();
    if (pages.length === 0) {
      logger.warn('[x-posting] CDP context has no pages');
      return null;
    }
    // Prefer a page already on x.com (or matching the hint) so we
    // don't interrupt unrelated tabs.
    let page: CdpPage | undefined;
    if (urlHint) {
      page = pages.find((p) => p.url().includes(urlHint));
    }
    if (!page) page = pages.find((p) => p.url().startsWith('https://x.com'));
    if (!page) page = pages[0];

    // Install the beforeunload escape hatches and dialog handler.
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
    logger.warn({ err: err instanceof Error ? err.message : err }, '[x-posting] CDP connect failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Convert a markdown article body to the plain-text shape X Articles
 * can actually render. X Articles has its own toolbar for bold/italic/
 * headings and treats raw markdown characters as literal text, so a
 * body typed straight from `.md` shows up with `**bold**` and `---`
 * hrs visible to readers. Strip the syntax, keep the words.
 *
 * What we do:
 *   - fenced code blocks: drop the ``` fences, keep the content
 *   - inline code: drop the backticks, keep the content
 *   - links [text](url): unwrap to `text (url)` so the URL stays visible
 *   - bare brackets [text]: unwrap to `text` (for placeholder tokens)
 *   - horizontal rules (---, ***, ___ on their own line): remove
 *   - headings (# .. ######): drop the marker, keep heading text as a paragraph
 *   - bold **text** and __text__: unwrap
 *   - collapse 3+ blank lines to 2
 *
 * Italic (_text_ / *text*) is intentionally left alone — it's too easy
 * to munge real prose with asterisks, and X Articles shows italic
 * markers as plain chars which is an acceptable fallback.
 */
export function stripMarkdownForXArticle(body: string): { plainText: string } {
  let out = body;

  out = out.replace(/```[a-zA-Z0-9_-]*\n?/g, '');
  out = out.replace(/`([^`]+)`/g, '$1');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  out = out.replace(/\[([^\]]+)\]/g, '$1');
  out = out.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '');
  out = out.replace(/^#{1,6}\s+/gm, '');
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/__([^_]+)__/g, '$1');
  out = out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
  out = out.replace(/\n{3,}/g, '\n\n');

  return { plainText: out.trim() };
}

function isLoginRedirect(url: string): boolean {
  return /\/(login|i\/flow\/login|i\/flow\/signup)/.test(url);
}

async function captureScreenshot(page: CdpPage): Promise<string | undefined> {
  try {
    const buffer = await page.screenshot({ type: 'jpeg', quality: 70 });
    return buffer.toString('base64');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, '[x-posting] screenshot failed');
    return undefined;
  }
}

/**
 * Focus an element by testid via native JS inside the page. Used for
 * compose textareas — we focus first, then use `page.keyboard.type`
 * so React sees real input events.
 */
async function focusByTestid(page: CdpPage, testid: string): Promise<boolean> {
  try {
    const ok = await page.evaluate(`(() => {
      const el = document.querySelector('[data-testid="${testid}"]');
      if (!(el instanceof HTMLElement)) return false;
      el.scrollIntoView({ block: 'center' });
      el.focus();
      return true;
    })()`);
    return ok === true;
  } catch {
    return false;
  }
}

/**
 * Click an element by text content inside a given scope. Used for
 * Delete menu items and the article Publish button, which don't have
 * stable testids. Dispatches a real event through page.click.
 */
async function clickByText(page: CdpPage, text: string, selectorScope = 'button, [role="button"], [role="menuitem"]'): Promise<boolean> {
  try {
    const found = await page.evaluate(`(() => {
      const scope = ${JSON.stringify(selectorScope)};
      const target = ${JSON.stringify(text)};
      const nodes = Array.from(document.querySelectorAll(scope));
      for (const n of nodes) {
        const txt = (n.textContent || '').trim();
        if (txt === target || txt.startsWith(target)) {
          const el = n instanceof HTMLElement ? n : null;
          if (!el) continue;
          el.setAttribute('data-x-click-target', '1');
          return true;
        }
      }
      return false;
    })()`);
    if (!found) return false;
    await page.click('[data-x-click-target="1"]', { timeout: 5000 });
    // Clean up the attribute so a subsequent clickByText call doesn't
    // pick up the old node.
    await page.evaluate(`(() => {
      const el = document.querySelector('[data-x-click-target="1"]');
      if (el) el.removeAttribute('data-x-click-target');
      return true;
    })()`).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tweet compose
// ---------------------------------------------------------------------------

export async function composeTweetViaBrowser(input: ComposeTweetInput): Promise<ComposeResult> {
  const text = (input.text || '').trim();
  const dryRun = input.dryRun !== false;

  if (!text) return { success: false, message: 'text is required' };
  if (text.length > MAX_TWEET_LENGTH) {
    return {
      success: false,
      message: `Tweet is ${text.length} chars, X limit is ${MAX_TWEET_LENGTH}. Trim or use x_compose_thread.`,
    };
  }

  const page = await getCdpPage('x.com');
  if (!page) return { success: false, message: 'Could not attach to Chrome CDP at :9222.' };

  await page.goto(COMPOSE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await wait(HYDRATION_WAIT_MS);
  if (isLoginRedirect(page.url())) {
    return { success: false, message: `X redirected to login (${page.url()}).`, currentUrl: page.url() };
  }

  const focused = await focusByTestid(page, 'tweetTextarea_0');
  if (!focused) {
    return {
      success: false,
      message: 'Could not focus tweetTextarea_0',
      screenshotBase64: await captureScreenshot(page),
      currentUrl: page.url(),
    };
  }

  // Small warmup: a single space + backspace reliably eats the
  // intermittent first-keystroke-dropped glitch we saw when typing
  // straight after focus.
  await page.keyboard.type(' ', { delay: KEYBOARD_DELAY_MS });
  await page.keyboard.press('Backspace');

  await page.keyboard.type(text, { delay: KEYBOARD_DELAY_MS });
  await wait(400);

  const screenshotBase64 = await captureScreenshot(page);

  if (dryRun) {
    logger.info('[x-posting] Tweet dry run — composed but did not publish');
    return {
      success: true,
      message: `Dry run complete. Composed ${text.length} chars in X compose modal. Call again with dry_run=false to publish.`,
      screenshotBase64,
      tweetsTyped: 1,
      tweetsPublished: 0,
      currentUrl: page.url(),
    };
  }

  try {
    await page.click('[data-testid="tweetButton"]', { timeout: 10000 });
  } catch (err) {
    return {
      success: false,
      message: `Post click failed: ${err instanceof Error ? err.message : String(err)}`,
      screenshotBase64,
      tweetsTyped: 1,
      tweetsPublished: 0,
    };
  }
  await wait(POST_SETTLE_MS);
  const postShot = await captureScreenshot(page);
  logger.info('[x-posting] Tweet published');
  return {
    success: true,
    message: `Tweet published (${text.length} chars).`,
    screenshotBase64: postShot || screenshotBase64,
    tweetsTyped: 1,
    tweetsPublished: 1,
    currentUrl: page.url(),
  };
}

// ---------------------------------------------------------------------------
// Thread compose
// ---------------------------------------------------------------------------

export async function composeThreadViaBrowser(input: ComposeThreadInput): Promise<ComposeResult> {
  const tweets = (input.tweets || []).map((t) => (t || '').trim()).filter((t) => t.length > 0);
  const dryRun = input.dryRun !== false;

  if (tweets.length === 0) return { success: false, message: 'tweets must be a non-empty array' };
  for (let i = 0; i < tweets.length; i++) {
    if (tweets[i].length > MAX_TWEET_LENGTH) {
      return {
        success: false,
        message: `Tweet ${i + 1}/${tweets.length} is ${tweets[i].length} chars — over ${MAX_TWEET_LENGTH} limit.`,
      };
    }
  }

  const page = await getCdpPage('x.com');
  if (!page) return { success: false, message: 'Could not attach to Chrome CDP.' };

  await page.goto(COMPOSE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await wait(HYDRATION_WAIT_MS);
  if (isLoginRedirect(page.url())) {
    return { success: false, message: `X redirected to login.`, currentUrl: page.url() };
  }

  if (!await focusByTestid(page, 'tweetTextarea_0')) {
    return {
      success: false,
      message: 'Could not focus first tweet textarea.',
      screenshotBase64: await captureScreenshot(page),
    };
  }
  await page.keyboard.type(' ', { delay: KEYBOARD_DELAY_MS });
  await page.keyboard.press('Backspace');
  await page.keyboard.type(tweets[0], { delay: KEYBOARD_DELAY_MS });
  let tweetsTyped = 1;

  for (let i = 1; i < tweets.length; i++) {
    try {
      await page.click('[data-testid="addButton"]', { timeout: 5000 });
    } catch (err) {
      return {
        success: false,
        message: `Could not click Add Button for row ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
        screenshotBase64: await captureScreenshot(page),
        tweetsTyped,
      };
    }
    await wait(600);
    if (!await focusByTestid(page, `tweetTextarea_${i}`)) {
      return {
        success: false,
        message: `Could not focus thread row ${i + 1}.`,
        screenshotBase64: await captureScreenshot(page),
        tweetsTyped,
      };
    }
    await page.keyboard.type(tweets[i], { delay: KEYBOARD_DELAY_MS });
    tweetsTyped++;
  }

  await wait(400);
  const screenshotBase64 = await captureScreenshot(page);

  if (dryRun) {
    logger.info(`[x-posting] Thread dry run — typed ${tweetsTyped} tweets`);
    return {
      success: true,
      message: `Dry run complete. Composed ${tweetsTyped}-tweet thread. Call again with dry_run=false to publish.`,
      screenshotBase64,
      tweetsTyped,
      tweetsPublished: 0,
      currentUrl: page.url(),
    };
  }

  try {
    await page.click('[data-testid="tweetButton"]', { timeout: 10000 });
  } catch (err) {
    return {
      success: false,
      message: `Failed to click Post all: ${err instanceof Error ? err.message : String(err)}`,
      screenshotBase64,
      tweetsTyped,
      tweetsPublished: 0,
    };
  }
  await wait(POST_SETTLE_MS);
  logger.info(`[x-posting] Thread published (${tweetsTyped} tweets)`);
  return {
    success: true,
    message: `Thread published (${tweetsTyped} tweets).`,
    screenshotBase64: await captureScreenshot(page) || screenshotBase64,
    tweetsTyped,
    tweetsPublished: tweetsTyped,
    currentUrl: page.url(),
  };
}

// ---------------------------------------------------------------------------
// Article compose
// ---------------------------------------------------------------------------

export async function composeArticleViaBrowser(input: ComposeArticleInput): Promise<ComposeResult> {
  const title = (input.title || '').trim();
  const body = (input.body || '').trim();
  const dryRun = input.dryRun !== false;

  if (!title) return { success: false, message: 'title is required' };
  if (!body || body.length < 100) return { success: false, message: 'body must be at least 100 chars for an article' };

  const page = await getCdpPage('x.com');
  if (!page) return { success: false, message: 'Could not attach to Chrome CDP.' };

  await page.goto(ARTICLE_LANDING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await wait(HYDRATION_WAIT_MS);

  // Click the Write button — testid is `empty_state_button_text` when
  // there are no drafts. If drafts exist, we try the fallback "Write"
  // text-match instead.
  let clickedWrite = false;
  try {
    await page.click('[data-testid="empty_state_button_text"]', { timeout: 3000 });
    clickedWrite = true;
  } catch {
    clickedWrite = await clickByText(page, 'Write');
  }
  if (!clickedWrite) {
    return {
      success: false,
      message: 'Could not click Write button on /compose/articles.',
      screenshotBase64: await captureScreenshot(page),
    };
  }
  await wait(HYDRATION_WAIT_MS);

  // The editor URL now contains a draft ID.
  const draftUrl = page.url();
  if (!/\/compose\/articles\/edit\//.test(draftUrl)) {
    return {
      success: false,
      message: `Editor did not load (landed at ${draftUrl}).`,
      screenshotBase64: await captureScreenshot(page),
    };
  }

  // Fill title (plain textarea with placeholder "Add a title").
  const titleFocused = await page.evaluate(`(() => {
    const el = document.querySelector('textarea[placeholder="Add a title"]');
    if (!(el instanceof HTMLElement)) return false;
    el.focus();
    return true;
  })()`);
  if (!titleFocused) {
    return {
      success: false,
      message: 'Could not focus article title textarea.',
      screenshotBase64: await captureScreenshot(page),
    };
  }
  await page.keyboard.type(title, { delay: KEYBOARD_DELAY_MS });
  await wait(300);

  // Fill body — contenteditable at [data-testid="composer"].
  if (!await focusByTestid(page, 'composer')) {
    return {
      success: false,
      message: 'Could not focus article body composer.',
      screenshotBase64: await captureScreenshot(page),
    };
  }
  const { plainText: bodyPlain } = stripMarkdownForXArticle(body);
  await page.keyboard.type(bodyPlain, { delay: KEYBOARD_DELAY_MS });
  await wait(400);

  const screenshotBase64 = await captureScreenshot(page);

  if (dryRun) {
    logger.info('[x-posting] Article dry run — composed but not published');
    return {
      success: true,
      message: `Dry run complete. Drafted article: "${title.slice(0, 60)}" (${body.length} chars). Call again with dry_run=false to publish.`,
      screenshotBase64,
      currentUrl: draftUrl,
    };
  }

  // X Articles uses a two-step publish:
  //   1. Click the header "Publish" button — opens a "Publish Article"
  //      confirmation dialog with audience / reply settings.
  //   2. Click the second "Publish" button inside that dialog — the
  //      real publish trigger.
  // The dialog's button has no data-testid; we find it by aria-label
  // scoped inside div[role="dialog"] so we don't re-click the header
  // Publish we just clicked.
  const headerClicked = await clickByText(page, 'Publish');
  if (!headerClicked) {
    return {
      success: false,
      message: 'Could not click header Publish button.',
      screenshotBase64,
      currentUrl: draftUrl,
    };
  }

  // Wait for the confirmation dialog to mount.
  try {
    await page.waitForSelector('div[role="dialog"]', { state: 'attached', timeout: 8000 });
  } catch {
    return {
      success: false,
      message: 'Publish confirmation dialog did not appear within 8s.',
      screenshotBase64: await captureScreenshot(page),
      currentUrl: page.url(),
    };
  }
  await wait(400);

  // Click the Publish button inside the dialog. The button has
  // aria-label="Publish" and sits at div[role="dialog"] > ... > button.
  const dialogPublished = await page.evaluate(`(() => {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return false;
    const btns = Array.from(dialog.querySelectorAll('button, [role="button"]'));
    const publish = btns.find((b) => {
      const label = b.getAttribute('aria-label') || '';
      const text = (b.textContent || '').trim();
      return label === 'Publish' || text === 'Publish';
    });
    if (!(publish instanceof HTMLElement)) return false;
    publish.setAttribute('data-x-click-target', '1');
    return true;
  })()`);
  if (!dialogPublished) {
    return {
      success: false,
      message: 'Publish button not found inside confirmation dialog.',
      screenshotBase64: await captureScreenshot(page),
      currentUrl: page.url(),
    };
  }
  try {
    await page.click('[data-x-click-target="1"]', { timeout: 5000 });
  } catch (err) {
    return {
      success: false,
      message: `Dialog Publish click failed: ${err instanceof Error ? err.message : String(err)}`,
      screenshotBase64: await captureScreenshot(page),
    };
  }

  // Wait for X to redirect to the published article (/<handle>/status/<id>).
  // The redirect is the ground-truth signal that publish succeeded —
  // otherwise we'd falsely report success on a stalled confirmation.
  const redirectDeadline = Date.now() + POST_SETTLE_MS + 3000;
  while (Date.now() < redirectDeadline) {
    await wait(400);
    if (/\/status\/\d+/.test(page.url())) break;
  }
  const finalUrl = page.url();
  const publishedOk = /\/status\/\d+/.test(finalUrl);
  logger.info(`[x-posting] Article publish ${publishedOk ? 'succeeded' : 'uncertain'}: ${title.slice(0, 80)}`);
  return {
    success: publishedOk,
    message: publishedOk
      ? `Article published: "${title.slice(0, 80)}". Live at ${finalUrl}`
      : `Article publish click sent but no redirect to /status/ detected within budget. Check manually: ${finalUrl}`,
    screenshotBase64: await captureScreenshot(page) || screenshotBase64,
    currentUrl: finalUrl,
    landedAt: finalUrl,
  };
}

// ---------------------------------------------------------------------------
// DMs: list inbox
// ---------------------------------------------------------------------------

export interface DmThreadSummary {
  pair: string;
  primaryName: string | null;
  preview: string;
  hasUnread: boolean;
}

export interface ListDmsResult {
  success: boolean;
  message: string;
  threads?: DmThreadSummary[];
  screenshotBase64?: string;
}

export async function listDmsViaBrowser(input: ListDmsInput): Promise<ListDmsResult> {
  const limit = Math.max(1, Math.min(50, input.limit ?? 20));
  const page = await getCdpPage('x.com');
  if (!page) return { success: false, message: 'Could not attach to Chrome CDP.' };

  await page.goto(DM_INBOX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await wait(HYDRATION_WAIT_MS);

  const threads = await page.evaluate(`(() => {
    const limit = ${limit};
    const items = Array.from(document.querySelectorAll('[data-testid^="dm-conversation-item-"]'));
    return items.slice(0, limit).map((it) => {
      const testid = it.getAttribute('data-testid') || '';
      const pair = testid.replace(/^dm-conversation-item-/, '');
      const nameEl = it.querySelector('div[dir="ltr"] span, span[dir="ltr"]');
      const preview = (it.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
      const hasUnread = !!it.querySelector('[data-testid*="unread" i]');
      return { pair, primaryName: nameEl?.textContent?.trim() || null, preview, hasUnread };
    });
  })()`);

  return {
    success: true,
    message: `Found ${(threads as DmThreadSummary[]).length} DM thread(s).`,
    threads: threads as DmThreadSummary[],
    screenshotBase64: await captureScreenshot(page),
  };
}

// ---------------------------------------------------------------------------
// DMs: send a message into an existing conversation
// ---------------------------------------------------------------------------

export async function sendDmViaBrowser(input: SendDmInput): Promise<ComposeResult> {
  const text = (input.text || '').trim();
  const dryRun = input.dryRun !== false;
  if (!text) return { success: false, message: 'text is required' };

  // Normalize conversation pair. X testid uses colon, URL uses hyphen.
  const pair = (input.conversationPair || '').trim();
  const pairColon = pair.replace(/-/g, ':');
  const pairHyphen = pair.replace(/:/g, '-');

  const page = await getCdpPage('x.com');
  if (!page) return { success: false, message: 'Could not attach to Chrome CDP.' };

  // Either navigate directly to the thread URL, or open from the inbox.
  if (pairHyphen) {
    await page.goto(`https://x.com/i/chat/${pairHyphen}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } else {
    await page.goto(DM_INBOX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  await wait(HYDRATION_WAIT_MS);

  if (!pairHyphen) {
    // Fallback: if only handle was provided, click the first matching
    // conversation in the inbox whose preview contains the handle. This
    // is best-effort — for deterministic targeting prefer passing pair.
    const handle = (input.handle || '').trim().replace(/^@/, '');
    if (!handle) {
      return { success: false, message: 'either conversationPair or handle is required' };
    }
    const clicked = await page.evaluate(`(() => {
      const handle = ${JSON.stringify(handle.toLowerCase())};
      const items = Array.from(document.querySelectorAll('[data-testid^="dm-conversation-item-"]'));
      for (const it of items) {
        const txt = (it.textContent || '').toLowerCase();
        if (txt.includes(handle)) {
          it.setAttribute('data-x-click-target', '1');
          return true;
        }
      }
      return false;
    })()`);
    if (!clicked) {
      return {
        success: false,
        message: `No conversation found for handle @${handle}`,
        screenshotBase64: await captureScreenshot(page),
      };
    }
    try {
      await page.click('[data-x-click-target="1"]', { timeout: 5000 });
    } catch {
      return { success: false, message: 'Failed to open matched conversation' };
    }
    await wait(HYDRATION_WAIT_MS);
  }

  // Wait for the composer to appear, then type.
  try {
    await page.waitForSelector('textarea[data-testid="dm-composer-textarea"]', { state: 'attached', timeout: 10000 });
  } catch {
    return {
      success: false,
      message: 'DM composer textarea did not appear — conversation may not have opened.',
      screenshotBase64: await captureScreenshot(page),
      currentUrl: page.url(),
    };
  }

  await page.click('textarea[data-testid="dm-composer-textarea"]');
  await page.keyboard.type(text, { delay: KEYBOARD_DELAY_MS });
  await wait(400);

  const screenshotBase64 = await captureScreenshot(page);
  const landedPair = pairColon || pairHyphen || '(handle lookup)';

  if (dryRun) {
    logger.info('[x-posting] DM dry run — composed but not sent');
    return {
      success: true,
      message: `Dry run complete. Composed DM to ${landedPair}: "${text.slice(0, 60)}...". Call again with dry_run=false to send.`,
      screenshotBase64,
      currentUrl: page.url(),
      landedAt: landedPair,
    };
  }

  try {
    await page.click('[data-testid="dm-composer-send-button"]', { timeout: 5000 });
  } catch (err) {
    return {
      success: false,
      message: `DM send click failed: ${err instanceof Error ? err.message : String(err)}`,
      screenshotBase64,
    };
  }
  await wait(POST_SETTLE_MS);
  logger.info(`[x-posting] DM sent to ${landedPair}`);
  return {
    success: true,
    message: `DM sent to ${landedPair}.`,
    screenshotBase64: await captureScreenshot(page) || screenshotBase64,
    currentUrl: page.url(),
    landedAt: landedPair,
  };
}

// ---------------------------------------------------------------------------
// Delete last tweet matching a marker
// ---------------------------------------------------------------------------

export async function deleteLastTweetViaBrowser(input: DeleteLastTweetInput): Promise<ComposeResult> {
  const handle = (input.handle || '').trim().replace(/^@/, '');
  const marker = (input.marker || '').trim();
  const dryRun = input.dryRun !== false;
  if (!handle) return { success: false, message: 'handle is required' };
  if (!marker) return { success: false, message: 'marker is required' };

  const page = await getCdpPage('x.com');
  if (!page) return { success: false, message: 'Could not attach to Chrome CDP.' };

  await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await wait(HYDRATION_WAIT_MS);

  const located = await page.evaluate(`(() => {
    const marker = ${JSON.stringify(marker)};
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    for (const art of articles) {
      if ((art.textContent || '').includes(marker)) {
        art.scrollIntoView({ block: 'center' });
        const caret = art.querySelector('[data-testid="caret"]');
        if (caret instanceof HTMLElement) {
          caret.setAttribute('data-x-click-target', '1');
          return { ok: true };
        }
        return { ok: false, reason: 'caret button not found' };
      }
    }
    return { ok: false, reason: 'no matching tweet', articleCount: articles.length };
  })()`);

  if (!(located as { ok: boolean }).ok) {
    return {
      success: false,
      message: `Tweet with marker "${marker}" not found: ${JSON.stringify(located)}`,
      screenshotBase64: await captureScreenshot(page),
    };
  }

  if (dryRun) {
    return {
      success: true,
      message: `Dry run complete. Found tweet matching marker "${marker}". Call again with dry_run=false to delete.`,
      screenshotBase64: await captureScreenshot(page),
    };
  }

  try {
    await page.click('[data-x-click-target="1"]', { timeout: 5000 });
  } catch (err) {
    return { success: false, message: `Caret click failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  await wait(600);

  const deleteClicked = await clickByText(page, 'Delete', '[role="menuitem"]');
  if (!deleteClicked) {
    return {
      success: false,
      message: 'Delete menu item not found.',
      screenshotBase64: await captureScreenshot(page),
    };
  }
  await wait(600);

  try {
    await page.click('[data-testid="confirmationSheetConfirm"]', { timeout: 5000 });
  } catch {
    // Fallback: confirm by text
    const confirmed = await clickByText(page, 'Delete');
    if (!confirmed) {
      return { success: false, message: 'Could not confirm deletion.' };
    }
  }
  await wait(POST_SETTLE_MS);
  logger.info(`[x-posting] Tweet deleted (marker: ${marker})`);
  return {
    success: true,
    message: `Tweet deleted (marker: ${marker}).`,
    screenshotBase64: await captureScreenshot(page),
    currentUrl: page.url(),
  };
}
