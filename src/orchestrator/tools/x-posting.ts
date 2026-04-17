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
 * Proven selectors (verified live on a real X account, 2026-04-13):
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

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { logger } from '../../lib/logger.js';
import { type RawCdpBrowser, type RawCdpPage } from '../../execution/browser/raw-cdp.js';
import {
  markTabOwned,
  isTabOwned,
  ensureCdpBrowser,
  type TabOwnershipMode,
} from '../../execution/browser/chrome-profile-router.js';
import {
  confirmPostLanded,
  typeIntoRichTextbox,
  tagTabAsOwned,
  clickFirstEnabledSubmit,
} from './social-cdp-helpers.js';

// ---------------------------------------------------------------------------
// Tool schema definitions
// ---------------------------------------------------------------------------
//
// Source order matters: the orchestrator catalog interleaves these with the
// synthesis_skill_for_goal / synthesis_run_acceptance schemas (which are
// in the same file region historically). To preserve the original order
// without pulling unrelated synthesis tools into this file, the X tools
// are split into HEAD (the 5 compose/list/send tools that appear first)
// and DELETE (x_delete_tweet, which appears after the synthesis pair).

export const X_POSTING_HEAD_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'x_compose_tweet',
    description: 'Compose a single tweet (≤280 chars) on x.com by driving the user\'s real logged-in Chrome. Navigates to the compose modal, types the text, and optionally publishes. DEFAULTS TO DRY RUN: the tool types the text into compose but does NOT click Post unless you explicitly pass dry_run=false. Use this for short posts. Use x_compose_thread for multi-tweet threads.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description: 'The tweet text, verbatim, ≤280 characters. Will be typed exactly as provided.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true (default), types the text in compose and screenshots it but does NOT publish. Set to false to actually publish. Always dry-run first unless the user explicitly asked to publish.',
        },
        profile: {
          type: 'string',
          description: 'Chrome profile to use for the real logged-in session. Accepts an email (e.g. "alice@example.com") or a profile directory name. Defaults to the owner\'s profile.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'x_compose_thread',
    description: 'Compose a multi-tweet thread on x.com by driving the user\'s real logged-in Chrome. Opens the compose modal once, types each tweet in sequence, chains them via the "Add another post" button, and optionally publishes them all. DEFAULTS TO DRY RUN. Use this for launch threads, countdown threads, and any multi-tweet content where each segment is ≤280 chars.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tweets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of tweet strings, in order. Each ≤280 chars. The tool chains them into a thread.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true (default), composes the thread in the modal and screenshots it but does NOT publish. Set to false to publish all tweets in one shot.',
        },
        profile: {
          type: 'string',
          description: 'Chrome profile to use. Same rules as x_compose_tweet.',
        },
      },
      required: ['tweets'],
    },
  },
  {
    name: 'x_compose_article',
    description: 'Compose a long-form X Article by driving the user\'s real Chrome. Navigates to /compose/articles, clicks Write to create a new draft, types the title and body, and optionally publishes. DEFAULTS TO DRY RUN. Use this for launch blog-style posts (Article #1, Article #2, etc.) where the content is longer than a thread. Requires X Premium on the active account — the tool returns a useful error if Articles is not available for this profile.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Article title. Required.',
        },
        body: {
          type: 'string',
          description: 'Article body markdown/plain text. Minimum 100 characters. The tool types this into the X article editor one character at a time.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true (default), drafts the article but does NOT click Publish. Set to false to actually publish.',
        },
        profile: {
          type: 'string',
          description: 'Chrome profile to use.',
        },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'x_list_dms',
    description: 'List the user\'s X DM inbox by driving the real Chrome. Returns an array of thread summaries with the conversation pair id, the primary correspondent name, a short preview of the last message, and an unread flag. Use this for DM triage: call it first to see what needs attention, then call x_send_dm to reply into a specific thread.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Max number of threads to return. Defaults to 20, capped at 50.',
        },
        profile: { type: 'string', description: 'Chrome profile to use.' },
      },
      required: [],
    },
  },
  {
    name: 'x_send_dm',
    description: 'Send a DM to an existing X conversation by driving the real Chrome. Opens the thread, types the message into the composer, and optionally clicks Send. DEFAULTS TO DRY RUN. Prefer passing conversation_pair (from x_list_dms) for deterministic targeting; handle fallback is best-effort.',
    input_schema: {
      type: 'object' as const,
      properties: {
        conversation_pair: {
          type: 'string',
          description: 'The conversation pair id from x_list_dms (e.g. "<userIdA>:<userIdB>" or "<userIdA>-<userIdB>"). Either this or handle is required.',
        },
        handle: {
          type: 'string',
          description: 'Recipient handle (without @) as a fallback when the pair is unknown. The tool will pick the first inbox thread whose preview mentions this handle — best-effort only.',
        },
        text: {
          type: 'string',
          description: 'Message body. Required.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true (default), types the message into the composer but does NOT click Send. Set to false to send for real.',
        },
        profile: { type: 'string', description: 'Chrome profile to use.' },
      },
      required: ['text'],
    },
  },
];

export const X_POSTING_DELETE_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'x_delete_tweet',
    description: 'Delete the user\'s most recent tweet matching a text marker. Used for cleanup after test posts. Opens the profile, finds an article whose text contains the marker, opens its menu, clicks Delete, and confirms. DEFAULTS TO DRY RUN.',
    input_schema: {
      type: 'object' as const,
      properties: {
        handle: {
          type: 'string',
          description: 'Profile handle (without @) to search on. Usually the active account.',
        },
        marker: {
          type: 'string',
          description: 'Unique substring that identifies the tweet to delete. The tool picks the first matching article.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true (default), locates the tweet but does NOT delete it. Set to false to actually delete.',
        },
        profile: { type: 'string', description: 'Chrome profile to use.' },
      },
      required: ['handle', 'marker'],
    },
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComposeTweetInput {
  text: string;
  dryRun?: boolean;
  /**
   * Expected X handle of the logged-in user on the target Chrome profile
   * (no leading @). When set, the tool verifies the page's active account
   * BEFORE typing or publishing — if the handle doesn't match, the call
   * fails loudly rather than silently posting from the wrong profile.
   * The core safety rail for live mode: every multi-profile debug Chrome
   * we've tested sometimes routes a CDP attach to the wrong profile's
   * window, and relying on URL heuristics ("pick any x.com tab") trusts
   * something we can't verify.
   */
  expectedHandle?: string;
  /**
   * CDP `browserContextId` of the Chrome profile window we should post
   * from. When set, the tool attaches to an x.com tab in THIS context
   * only — never an x.com tab belonging to some other profile — and
   * opens a new tab in that context if no x.com tab exists. Passed
   * down from `openProfileWindow`'s return value; the upstream
   * `ensureProfileChrome` / tool-executor paths own that lookup.
   */
  expectedBrowserContextId?: string;
}

export interface ComposeThreadInput {
  tweets: string[];
  dryRun?: boolean;
  expectedBrowserContextId?: string;
}

export interface ComposeArticleInput {
  title: string;
  body: string;
  dryRun?: boolean;
  expectedBrowserContextId?: string;
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
  expectedBrowserContextId?: string;
}

export interface ListDmsInput {
  limit?: number;
  expectedBrowserContextId?: string;
}

export interface DeleteLastTweetInput {
  /** Handle of the profile to delete from. Usually the active account. */
  handle: string;
  /** Substring to match — picks the most recent tweet whose text contains this marker. */
  marker: string;
  dryRun?: boolean;
  expectedBrowserContextId?: string;
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
  /**
   * True when X rejected the post with the "Whoops! You already said
   * that." banner. Distinct from a general failure: the content is
   * already out there, so callers should treat the underlying work
   * item (approved draft, agent task) as effectively done and advance
   * the queue instead of retrying the same bytes on the next tick.
   */
  duplicateBlocked?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_TWEET_LENGTH = 280;
export const X_HYDRATION_WAIT_MS = 2500;
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

// Use the raw CDP driver instead of Playwright's `chromium.connectOverCDP`.
// Playwright collapses every Chrome profile into a single BrowserContext,
// which means `browser.contexts()[0]` picks an arbitrary profile — when
// the daemon is posting from a multi-profile debug Chrome we'd land in
// whichever context was enumerated first (often the unauthenticated one)
// even though ensureProfileChrome correctly set up the right window. The
// raw driver exposes targets with their real `browserContextId`, so we
// can pick the exact profile's x.com tab. See raw-cdp.ts top-of-file
// comment for the full rationale + the hang repro.
export type CdpPage = RawCdpPage;

/**
 * Connect to the already-running debug Chrome at `CDP_URL` and return a
 * RawCdpPage attached to an x.com tab. Caller is responsible for ensuring
 * Chrome is up (via ctx.browserState.activate() in tool-executor, or
 * ensureProfileChrome() in the deliverable-executor path).
 *
 * Profile pinning via `expectedContextId`:
 *   In a multi-profile debug Chrome, more than one profile may have an
 *   x.com tab open. URL alone does not identify the right profile — we
 *   could attach to another profile's x.com tab even though the caller
 *   intended to post from a specific account. CDP's `browserContextId`
 *   is the only reliable per-profile handle, and it's the value
 *   `openProfileWindow` now returns.
 *
 *   When `expectedContextId` is set we restrict page targets to that
 *   context and — if no x.com tab exists inside it — open a new tab in
 *   that context via `Target.createTarget`. This is the missing step
 *   that lets the runtime post from the intended profile regardless of
 *   what tabs other profiles have open.
 *
 *   When `expectedContextId` is not set we fall back to the old
 *   URL-heuristic behavior (used by callers that haven't threaded the
 *   context through yet, and by tests).
 *
 * Returns null when no suitable tab exists and we can't safely create
 * one — callers surface the error to the operator rather than posting
 * from the wrong session.
 */
export async function getCdpPage(
  urlHint?: string,
  expectedContextId?: string,
  ownershipMode: TabOwnershipMode = 'any',
): Promise<CdpPage | null> {
  let browser: RawCdpBrowser | null = null;
  // 'ours' hides tabs we didn't create, so the human's x.com sessions
  // stay fully off-limits to the caller. 'any' is the legacy behavior
  // (compose/scan inherits 'ours' through caller threading; DM tools
  // keep 'any' so operator-opened DM conversations still work).
  const isUsable = (tid: string) => ownershipMode === 'any' || isTabOwned(tid);
  try {
    // Self-heal: spawn debug Chrome if it's down before trying to
    // connect. Every getCdpPage caller (compose, scan, reply, DM)
    // flows through here, so closing Chrome is a transient blip
    // rather than an outage requiring operator intervention.
    browser = await ensureCdpBrowser();
    const targets = await browser.getTargets();
    const pageTargets = targets.filter((t) => t.type === 'page');
    if (pageTargets.length === 0) {
      logger.warn('[x-posting] CDP browser has no page targets');
      browser.close();
      return null;
    }

    // X has several specialty routes (DM chat, compose modal) that
    // render different DOM than the main timeline/status pages and
    // resist programmatic navigation away. Prefer "clean" tabs first
    // (home / status / search / profile) over these specialty routes.
    const isCleanXUrl = (u: string) =>
      /^https:\/\/(x|twitter)\.com\//.test(u)
      && !u.includes('/i/chat')
      && !u.includes('/i/messages')
      && !u.includes('/compose/post')
      && !u.includes('/compose/tweet')
      && !u.includes('/compose/articles');

    if (expectedContextId) {
      const inContext = pageTargets.filter((t) => t.browserContextId === expectedContextId && isUsable(t.targetId));
      // Prefer clean tabs first; fall through to specialty tabs only if necessary.
      let target = urlHint ? inContext.find((t) => t.url.includes(urlHint) && isCleanXUrl(t.url)) : undefined;
      if (!target) target = inContext.find((t) => isCleanXUrl(t.url));
      if (!target) target = urlHint ? inContext.find((t) => t.url.includes(urlHint)) : undefined;
      if (!target) target = inContext.find((t) => t.url.startsWith('https://x.com'));
      if (!target) target = inContext.find((t) => t.url.startsWith('https://twitter.com'));

      if (!target) {
        try {
          const newTargetId = await browser.createTargetInContext(expectedContextId, 'https://x.com/home');
          markTabOwned(newTargetId);
          logger.info(
            { ctx: expectedContextId.slice(0, 8), targetId: newTargetId.slice(0, 8), ownershipMode },
            '[x-posting] opened new x.com tab in target profile context',
          );
          const page = await browser.attachToPage(newTargetId);
          await page.installUnloadEscapes();
          await tagTabAsOwned(page);
          return page;
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : err, ctx: expectedContextId.slice(0, 8) },
            '[x-posting] createTargetInContext failed',
          );
          browser.close();
          return null;
        }
      }

      logger.debug(
        { targetId: target.targetId.slice(0, 8), ctx: target.browserContextId?.slice(0, 8), url: target.url },
        '[x-posting] attaching to x.com tab in pinned profile context',
      );
      const page = await browser.attachToPage(target.targetId);
      await page.installUnloadEscapes();
      return page;
    }

    // Fallback: no context hint. Apply the same clean-tab preference.
    const candidates = pageTargets.filter((t) => isUsable(t.targetId));
    let target = urlHint
      ? candidates.find((t) => t.url.includes(urlHint) && isCleanXUrl(t.url))
      : undefined;
    if (!target) target = candidates.find((t) => isCleanXUrl(t.url));
    if (!target) target = urlHint ? candidates.find((t) => t.url.includes(urlHint)) : undefined;
    if (!target) target = candidates.find((t) => t.url.startsWith('https://x.com'));
    if (!target) target = candidates.find((t) => t.url.startsWith('https://twitter.com'));
    if (!target) {
      // Ownership-mode='ours' + no owned tab = can't reuse. But this
      // is the scheduler/scan path (called without a context hint)
      // and it's still legitimate agent work — open our own owned
      // tab rather than bail. Pick any visible browserContextId from
      // existing tabs (the debug profile) so the new tab lands in
      // the same session state. If no existing tabs, Chrome uses
      // the default context.
      if (ownershipMode === 'ours') {
        const ctxIdFromOther = pageTargets.find((t) => t.browserContextId)?.browserContextId;
        try {
          const newTargetId = ctxIdFromOther
            ? await browser.createTargetInContext(ctxIdFromOther, 'https://x.com/home')
            : null;
          if (newTargetId) {
            markTabOwned(newTargetId);
            logger.info(
              { targetId: newTargetId.slice(0, 8), ownershipMode },
              '[x-posting] opened new owned x.com tab (no-context fallback)',
            );
            const page = await browser.attachToPage(newTargetId);
            await page.installUnloadEscapes();
            await tagTabAsOwned(page);
            return page;
          }
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : err },
            '[x-posting] createTargetInContext fallback failed',
          );
        }
      }
      logger.warn(
        { pageUrls: pageTargets.slice(0, 6).map((t) => t.url), ownershipMode },
        '[x-posting] no usable x.com/twitter.com tab in CDP; refusing to hijack an unrelated tab',
      );
      browser.close();
      return null;
    }
    logger.debug(
      { targetId: target.targetId.slice(0, 8), ctx: target.browserContextId?.slice(0, 8), url: target.url },
      '[x-posting] attaching to existing x.com tab (URL-only routing; no context hint supplied)',
    );
    const page = await browser.attachToPage(target.targetId);
    await page.installUnloadEscapes();
    return page;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, '[x-posting] CDP connect failed');
    if (browser) browser.close();
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function wait(ms: number): Promise<void> {
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

export function isLoginRedirect(url: string): boolean {
  return /\/(login|i\/flow\/login|i\/flow\/signup)/.test(url);
}

export async function captureScreenshot(page: CdpPage): Promise<string | undefined> {
  try {
    return await page.screenshotJpeg(70);
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
export async function focusByTestid(page: CdpPage, testid: string): Promise<boolean> {
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
export async function clickByText(page: CdpPage, text: string, selectorScope = 'button, [role="button"], [role="menuitem"]'): Promise<boolean> {
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
    const clicked = await page.clickSelector('[data-x-click-target="1"]', 5000);
    // Clean up the attribute so a subsequent clickByText call doesn't
    // pick up the old node.
    await page.evaluate(`(() => {
      const el = document.querySelector('[data-x-click-target="1"]');
      if (el) el.removeAttribute('data-x-click-target');
      return true;
    })()`).catch(() => {});
    return clicked;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Profile / identity verification
// ---------------------------------------------------------------------------

/**
 * Ask the attached X page which handle is currently signed in.
 * Reads the profile tab link (`data-testid="AppTabBar_Profile_Link"`),
 * whose href is `/<handle>`. Returns null if the page isn't logged in
 * or the sidebar element isn't present yet.
 *
 * This is the single source of truth for "which account am I about to
 * post from". Anything upstream (profile routing, window management,
 * browserContextId mapping) is an optimization; this is the safety rail.
 */
async function readActiveHandle(page: CdpPage): Promise<string | null> {
  try {
    const raw = await page.evaluate<string | null>(`(() => {
      const link = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
      if (link) {
        const href = link.getAttribute('href') || '';
        const m = href.match(/^\\/([^/?#]+)/);
        if (m) return m[1];
      }
      const anchor = document.querySelector('a[aria-label^="Profile"][href^="/"]');
      if (anchor) {
        const href = anchor.getAttribute('href') || '';
        const m = href.match(/^\\/([^/?#]+)/);
        if (m) return m[1];
      }
      return null;
    })()`);
    return raw ? raw.replace(/^@/, '').toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Refuse to proceed if the attached page isn't signed in as `expected`.
 * Navigates to x.com/home first if the current URL doesn't look like a
 * signed-in page, so the sidebar probe has something to read. Returns a
 * ComposeResult-shaped error when the mismatch is detected.
 */
async function assertSignedInAs(page: CdpPage, expected: string): Promise<ComposeResult | null> {
  const target = expected.replace(/^@/, '').toLowerCase();
  let currentUrl = await page.url();
  if (!/^https:\/\/(x|twitter)\.com/.test(currentUrl)) {
    await page.goto('https://x.com/home');
    await wait(HYDRATION_WAIT_MS);
    currentUrl = await page.url();
  }
  if (isLoginRedirect(currentUrl)) {
    return { success: false, message: `X redirected to login; expected handle @${target} is not signed in on this profile.`, currentUrl };
  }
  // Give the sidebar a couple of beats to render after a fresh navigation.
  let handle: string | null = null;
  for (let i = 0; i < 4; i++) {
    handle = await readActiveHandle(page);
    if (handle) break;
    await wait(750);
  }
  if (!handle) {
    return { success: false, message: 'Could not read the logged-in X handle from the page sidebar. Refusing to post without verifying identity.' };
  }
  if (handle !== target) {
    return {
      success: false,
      message: `Profile mismatch: attached X tab is signed in as @${handle}, but the task expects @${target}. Refusing to post. Open x.com in the "${target}" profile window, or adjust runtime_settings.x_posting_profile.`,
      currentUrl: await page.url(),
    };
  }
  return null;
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

  const page = await getCdpPage('x.com', input.expectedBrowserContextId, 'ours');
  if (!page) return { success: false, message: 'Could not attach to Chrome CDP at :9222 — no x.com tab open in any profile window, or debug Chrome is down. Open x.com in the target profile window and retry.' };

  try {
    if (input.expectedHandle) {
      const mismatch = await assertSignedInAs(page, input.expectedHandle);
      if (mismatch) return mismatch;
    }

    await page.goto(COMPOSE_URL);
    await wait(HYDRATION_WAIT_MS);
    const currentUrl = await page.url();
    if (isLoginRedirect(currentUrl)) {
      return { success: false, message: `X redirected to login (${currentUrl}).`, currentUrl };
    }

    const focused = await focusByTestid(page, 'tweetTextarea_0');
    if (!focused) {
      return {
        success: false,
        message: 'Could not focus tweetTextarea_0',
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }

    // Type via cascading strategy helper. If Input.insertText silently
    // drops characters (which happens when X rotates composer frameworks),
    // this falls through to execCommand then per-char dispatchKeyEvent
    // and verifies ≥50% of the expected chars land before proceeding.
    const typing = await typeIntoRichTextbox(page, '[data-testid="tweetTextarea_0"]', text);
    if (!typing.ok) {
      return {
        success: false,
        message: `Tweet text did not register (expected ~${typing.expectedLen}ch, got ${typing.observedLen}ch). All four typing strategies dropped the text.`,
        screenshotBase64: await captureScreenshot(page),
        tweetsTyped: 0,
        tweetsPublished: 0,
      };
    }
    logger.info(
      { strategy: typing.strategy, observedLen: typing.observedLen, expectedLen: typing.expectedLen },
      '[x-posting] typing strategy that landed',
    );
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
        currentUrl: await page.url(),
      };
    }

    // clickFirstEnabledSubmit polls until a button is enabled + visible
    // before clicking. On /compose/post X renders BOTH tweetButton and
    // tweetButtonInline; only the enabled one lets the post through.
    // Plain clickSelector doesn't check aria-disabled — it would click
    // a disabled button silently, then readPostOutcome reports
    // still_open and the caller thinks X rejected the content.
    const submit = await clickFirstEnabledSubmit(page, {
      testIds: ['tweetButton', 'tweetButtonInline'],
      timeoutMs: 10_000,
      logTag: 'x-posting',
    });
    if (!submit.clicked) {
      return {
        success: false,
        message: `Post button never became clickable within 10s. diag=${JSON.stringify(submit.diagnostic ?? {})}`,
        screenshotBase64,
        tweetsTyped: 1,
        tweetsPublished: 0,
      };
    }
    await wait(POST_SETTLE_MS);

    const postOutcome = await readPostOutcome(page);
    const postShot = await captureScreenshot(page);

    if (postOutcome === 'duplicate') {
      await dismissComposeModal(page);
      logger.warn('[x-posting] X blocked the post as duplicate content');
      return {
        success: false,
        duplicateBlocked: true,
        message: 'X blocked the post as duplicate content ("Whoops! You already said that."). Text is considered already-posted; caller should advance the work item.',
        screenshotBase64: postShot || screenshotBase64,
        tweetsTyped: 1,
        tweetsPublished: 0,
        currentUrl: await page.url(),
      };
    }
    if (postOutcome === 'still_open') {
      // Snapshot what's on the page at the moment we gave up. We've
      // seen this fire after a successful submit-click, which means
      // either (a) the click was intercepted by an overlay, (b) X
      // showed a confirmation dialog on top of the composer, or (c)
      // content was rate-limited and the banner sits alongside the
      // still-open textarea. The diag helps distinguish the three.
      const diag = await page.evaluate<{
        url: string;
        textLen: number;
        btnDisabled: string | null;
        overlayText: string;
        bodySnippet: string;
      }>(
        `(() => {
          const tb = document.querySelector('[data-testid="tweetTextarea_0"]');
          const btn = document.querySelector('[data-testid="tweetButton"]');
          const overlays = Array.from(document.querySelectorAll('[role="dialog"], [role="alert"], [aria-live="polite"]'));
          const overlayText = overlays.map((e) => (e.textContent || '').trim()).filter(Boolean).slice(0, 3).join(' || ');
          return {
            url: location.href,
            textLen: tb ? (tb.textContent || '').length : -1,
            btnDisabled: btn instanceof HTMLElement ? btn.getAttribute('aria-disabled') : null,
            overlayText: overlayText.slice(0, 200),
            bodySnippet: (document.body?.innerText || '').slice(0, 200),
          };
        })()`,
      ).catch(() => ({ url: '?', textLen: -1, btnDisabled: '?', overlayText: '', bodySnippet: '' }));
      logger.warn(diag, '[x-posting] still_open — compose modal did not close after submit');
      await dismissComposeModal(page);
      return {
        success: false,
        message: `Post button clicked but the compose modal did not close within the settle window. diag=${JSON.stringify(diag)}`,
        screenshotBase64: postShot || screenshotBase64,
        tweetsTyped: 1,
        tweetsPublished: 0,
        currentUrl: await page.url(),
      };
    }

    // Positive landing check: modal-closed alone isn't proof the post
    // went through. Poll up to 2.5s for our text in the DOM (timeline
    // or toast). Only flip to failure when we positively see no match
    // — a CDP probe error stays on the legacy success path so transient
    // hiccups don't invent failures.
    const landing = await confirmPostLanded(page, text, 2500);
    if (landing === 'not_visible') {
      logger.warn('[x-posting] modal closed but text not visible within 2.5s — treating as silent failure');
      return {
        success: false,
        message: 'Compose modal closed but the tweet text did not appear on the page within 2.5s. X may have silently dropped the post; re-check in the feed.',
        screenshotBase64: await captureScreenshot(page) || postShot || screenshotBase64,
        tweetsTyped: 1,
        tweetsPublished: 0,
        currentUrl: await page.url(),
      };
    }

    logger.info({ landing }, '[x-posting] Tweet published');
    return {
      success: true,
      message: `Tweet published (${text.length} chars).`,
      screenshotBase64: postShot || screenshotBase64,
      tweetsTyped: 1,
      tweetsPublished: 1,
      currentUrl: await page.url(),
    };
  } finally {
    page.close();
  }
}

/**
 * Read the post-click outcome from the compose modal. Returns:
 *   - 'duplicate'  — X's duplicate-content banner is visible
 *   - 'still_open' — the modal's textarea is still present (post
 *                    failed for some other reason, e.g. rate limit)
 *   - 'published'  — the modal closed cleanly; the post went through
 *
 * Defensive: any evaluate() throw resolves to 'published' so we don't
 * flip real successes into failures on a transient CDP hiccup. The
 * duplicate path is the interesting one; the caller treats 'still_open'
 * as a plain failure.
 */
async function readPostOutcome(page: CdpPage): Promise<'duplicate' | 'still_open' | 'published'> {
  try {
    const result = await page.evaluate<{ duplicate: boolean; modalOpen: boolean }>(`(() => {
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const duplicate = bodyText.includes('you already said that')
        || bodyText.includes('whoops! you already said that');
      const modalOpen = !!document.querySelector('[data-testid="tweetTextarea_0"]');
      return { duplicate, modalOpen };
    })()`);
    if (result.duplicate) return 'duplicate';
    if (result.modalOpen) return 'still_open';
    return 'published';
  } catch {
    return 'published';
  }
}

/**
 * Close the compose modal so the next scheduler tick doesn't find it
 * half-open. Escape twice (first clears focus, second closes); if X
 * opens a discard-draft confirmation, we intentionally click through
 * via the confirm button. Best-effort — ignore failures, the next
 * navigation will clear state anyway.
 */
async function dismissComposeModal(page: CdpPage): Promise<void> {
  try {
    await page.pressKey('Escape');
    await wait(200);
    await page.pressKey('Escape');
    await wait(200);
    // Some X builds pop a "Save as draft / Discard" dialog on
    // Escape. Click "Discard" so we don't leave a pending draft that
    // next tick could accidentally re-use.
    await clickByText(page, 'Discard', 'button, [role="button"]').catch(() => false);
    await wait(200);
  } catch {
    /* best effort */
  }
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

  const page = await getCdpPage('x.com', input.expectedBrowserContextId, 'ours');
  if (!page) return { success: false, message: 'Could not attach to Chrome CDP.' };

  try {
  await page.goto(COMPOSE_URL);
  await wait(HYDRATION_WAIT_MS);
  const afterGoto = await page.url();
  if (isLoginRedirect(afterGoto)) {
    return { success: false, message: `X redirected to login.`, currentUrl: afterGoto };
  }

  if (!await focusByTestid(page, 'tweetTextarea_0')) {
    return {
      success: false,
      message: 'Could not focus first tweet textarea.',
      screenshotBase64: await captureScreenshot(page),
    };
  }
  await page.typeText(' ');
  await page.pressKey('Backspace');
  await page.typeText(tweets[0]);
  let tweetsTyped = 1;

  for (let i = 1; i < tweets.length; i++) {
    const addClicked = await page.clickSelector('[data-testid="addButton"]', 5000);
    if (!addClicked) {
      return {
        success: false,
        message: `Could not click Add Button for row ${i + 1}.`,
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
    await page.typeText(tweets[i]);
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
      currentUrl: await page.url(),
    };
  }

  const submit = await clickFirstEnabledSubmit(page, {
    testIds: ['tweetButton', 'tweetButtonInline'],
    timeoutMs: 10_000,
    logTag: 'x-posting',
  });
  if (!submit.clicked) {
    return {
      success: false,
      message: `Post all button never became clickable within 10s. diag=${JSON.stringify(submit.diagnostic ?? {})}`,
      screenshotBase64,
      tweetsTyped,
      tweetsPublished: 0,
    };
  }
  await wait(POST_SETTLE_MS);

  // Positive landing check against the last tweet in the thread. The
  // first tweet's text could be echoed by the still-hydrating compose
  // modal even on failure; the final tweet is only visible once the
  // whole thread actually posted.
  const probeText = tweets[tweets.length - 1];
  const landing = await confirmPostLanded(page, probeText, 2500);
  if (landing === 'not_visible') {
    logger.warn({ tweetsTyped }, '[x-posting] thread modal closed but last-tweet text not visible — silent failure');
    return {
      success: false,
      message: `Thread compose closed but the last tweet (${probeText.slice(0, 40)}...) did not appear within 2.5s. X may have dropped the thread.`,
      screenshotBase64: await captureScreenshot(page) || screenshotBase64,
      tweetsTyped,
      tweetsPublished: 0,
      currentUrl: await page.url(),
    };
  }

  logger.info({ tweetsTyped, landing }, '[x-posting] Thread published');
  return {
    success: true,
    message: `Thread published (${tweetsTyped} tweets).`,
    screenshotBase64: await captureScreenshot(page) || screenshotBase64,
    tweetsTyped,
    tweetsPublished: tweetsTyped,
    currentUrl: await page.url(),
  };
  } finally {
    page.close();
  }
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

  const page = await getCdpPage('x.com', input.expectedBrowserContextId, 'ours');
  if (!page) return { success: false, message: 'Could not attach to Chrome CDP.' };

  try {
  await page.goto(ARTICLE_LANDING_URL);
  await wait(HYDRATION_WAIT_MS);

  // Click the Write button — testid is `empty_state_button_text` when
  // there are no drafts. If drafts exist, we try the fallback "Write"
  // text-match instead.
  let clickedWrite = await page.clickSelector('[data-testid="empty_state_button_text"]', 3000);
  if (!clickedWrite) {
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
  const draftUrl = await page.url();
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
  await page.typeText(title);
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
  await page.typeText(bodyPlain);
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
  const dialogMounted = await page.waitForSelector('div[role="dialog"]', 8000);
  if (!dialogMounted) {
    return {
      success: false,
      message: 'Publish confirmation dialog did not appear within 8s.',
      screenshotBase64: await captureScreenshot(page),
      currentUrl: await page.url(),
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
      currentUrl: await page.url(),
    };
  }
  const dialogClicked = await page.clickSelector('[data-x-click-target="1"]', 5000);
  if (!dialogClicked) {
    return {
      success: false,
      message: 'Dialog Publish button was not clickable within 5s.',
      screenshotBase64: await captureScreenshot(page),
    };
  }

  // Wait for X to redirect to the published article (/<handle>/status/<id>).
  // The redirect is the ground-truth signal that publish succeeded —
  // otherwise we'd falsely report success on a stalled confirmation.
  const redirectDeadline = Date.now() + POST_SETTLE_MS + 3000;
  let finalUrl = await page.url();
  while (Date.now() < redirectDeadline) {
    await wait(400);
    finalUrl = await page.url();
    if (/\/status\/\d+/.test(finalUrl)) break;
  }
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
  } finally {
    page.close();
  }
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
  const page = await getCdpPage('x.com', input.expectedBrowserContextId);
  if (!page) return { success: false, message: 'Could not attach to Chrome CDP.' };

  try {
  await page.goto(DM_INBOX_URL);
  await wait(HYDRATION_WAIT_MS);

  // Inbox-item DOM (verified 2026-04-16 via scripts/probe-x-dm-dom.mjs):
  //   [testid=dm-conversation-item-<pair>]
  //     div.flex flex-col
  //       div.flex flex-row justify-between          ← name+time row
  //         …
  //         div.font-chirp.…break-all.…              ← (1) NAME
  //         div.font-chirp.…break-words.…            ← (2) TIME (e.g. "7h")
  //       div.flex flex-row …gap-4                   ← preview row
  //         span.font-chirp.…break-words.…           ← (3) PREVIEW
  //
  // The previous selector (`div[dir="ltr"] span, span[dir="ltr"]`) matched
  // the preview span as `nameEl` because X wraps preview text in a
  // dir="ltr" span too. Switch to a positional read of the three
  // .font-chirp text nodes — the one signal that has stayed stable
  // across recent X redesigns.
  const threads = await page.evaluate<DmThreadSummary[]>(`(() => {
    const limit = ${limit};
    const items = Array.from(document.querySelectorAll('[data-testid^="dm-conversation-item-"]'));
    return items.slice(0, limit).map((it) => {
      const testid = it.getAttribute('data-testid') || '';
      const pair = testid.replace(/^dm-conversation-item-/, '');
      const chirps = Array.from(it.querySelectorAll('.font-chirp'))
        .map((el) => (el.textContent || '').trim())
        .filter((t) => t.length > 0);
      const primaryName = chirps[0] || null;
      const preview = chirps[2] || (it.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
      const hasUnread = !!it.querySelector('[data-testid*="unread" i]');
      return { pair, primaryName, preview, hasUnread };
    });
  })()`);

  return {
    success: true,
    message: `Found ${threads.length} DM thread(s).`,
    threads,
    screenshotBase64: await captureScreenshot(page),
  };
  } finally {
    page.close();
  }
}

// ---------------------------------------------------------------------------
// DMs: read messages inside a single conversation
// ---------------------------------------------------------------------------

export interface ReadDmThreadInput {
  /** Conversation pair (colon or hyphen form, same as ListDms returns). */
  conversationPair: string;
  /** Cap on number of messages returned, newest-first after the cap is applied. */
  limit?: number;
  expectedBrowserContextId?: string;
}

export interface DmMessage {
  /**
   * X's stable per-message UUID (from `data-testid="message-<uuid>"`).
   * Use this as the dedup key — it survives reloads and is unique to
   * the message inside this conversation.
   */
  id: string;
  /** Message body, trimmed and capped at 1000 chars. Null for media-only messages. */
  text: string | null;
  /**
   * 'outbound' when the message bubble uses the primary brand color
   * (X's "we sent it" treatment), 'inbound' when it uses the gray
   * background, 'unknown' when neither match (e.g. system messages).
   *
   * X never exposes a sender id in the DM DOM, so this is the most
   * reliable directionality signal available without authenticated API
   * access. Verified 2026-04-16 via probe-x-dm-dom.mjs.
   */
  direction: 'outbound' | 'inbound' | 'unknown';
  /**
   * True when the message appears to be a non-text payload (audio,
   * video, attachment, image) rather than typed prose. Detected by
   * Seek / audio / video aria-labels OR by the presence of an <img>
   * element inside the message bubble.
   */
  isMedia: boolean;
  /**
   * Coarse media category when isMedia is true. 'image' covers
   * screenshots and photos the user shared, which the conversation
   * analyst feeds to a vision LLM. Null when there's no media.
   */
  mediaKind?: 'image' | 'audio' | 'video' | 'other' | null;
  /**
   * Absolute URLs for any media attachments on the message. Captured
   * from <img src>. Note: X image URLs (pbs.twimg.com/dm/...) often
   * require the user's session cookies to fetch, so downstream
   * consumers may need to proxy through the authenticated browser.
   */
  mediaUrls?: string[];
}

export interface ReadDmThreadResult {
  success: boolean;
  message: string;
  /** Counterparty display name from the conversation header, when readable. */
  conversationName: string | null;
  /** Newest-last ordering (matches DOM order, which is also chronological). */
  messages?: DmMessage[];
  currentUrl?: string;
}

const DM_MESSAGE_LIST_TESTID = 'dm-message-list';
const DM_HEADER_USERNAME_TESTID = 'dm-conversation-username';
const DEFAULT_THREAD_READ_LIMIT = 30;
const THREAD_HYDRATION_WAIT_MS = 3500;

export async function readDmThreadViaBrowser(input: ReadDmThreadInput): Promise<ReadDmThreadResult> {
  const pair = (input.conversationPair || '').trim();
  if (!pair) return { success: false, message: 'conversationPair is required', conversationName: null };
  const pairHyphen = pair.replace(/:/g, '-');
  const limit = Math.max(1, Math.min(200, input.limit ?? DEFAULT_THREAD_READ_LIMIT));

  const page = await getCdpPage('x.com', input.expectedBrowserContextId);
  if (!page) return { success: false, message: 'Could not attach to Chrome CDP.', conversationName: null };

  try {
  await page.goto(`https://x.com/i/chat/${pairHyphen}`);
  await wait(THREAD_HYDRATION_WAIT_MS);

  const currentUrl = await page.url();
  if (isLoginRedirect(currentUrl)) {
    return { success: false, message: `X redirected to login (${currentUrl}).`, conversationName: null, currentUrl };
  }

  // Wait for the message list container to mount; retry briefly if X
  // is still hydrating after the initial wait.
  const listReady = await page.waitForSelector(`[data-testid="${DM_MESSAGE_LIST_TESTID}"]`, 5000);
  if (!listReady) {
    return {
      success: false,
      message: 'dm-message-list did not mount within 5s; thread may not have loaded.',
      conversationName: null,
      currentUrl,
    };
  }

  // Read header + messages in one round-trip to avoid a second
  // CDP frame per thread (we may iterate many in a tick).
  const probe = await page.evaluate<{ conversationName: string | null; messages: DmMessage[] }>(`(() => {
    const headerEl = document.querySelector('[data-testid="${DM_HEADER_USERNAME_TESTID}"]');
    const conversationName = headerEl?.textContent?.trim().slice(0, 200) || null;

    // Filter to message containers (testid: message-<uuid>) and exclude
    // the per-message-text child (testid: message-text-<uuid>) which has
    // a UUID-shaped suffix too.
    const roots = Array.from(document.querySelectorAll('[data-testid^="message-"]'))
      .filter((el) => /^message-[0-9a-f-]{8,}$/.test(el.getAttribute('data-testid') || ''));

    const messages = roots.map((root) => {
      const id = (root.getAttribute('data-testid') || '').replace(/^message-/, '');
      const textEl = root.querySelector('[data-testid="message-text-' + id + '"]');
      const rawText = textEl?.textContent?.trim() || null;
      // X concatenates the timestamp tooltip into the same text node;
      // strip a trailing "<time><time>" pair (e.g. "...6:49 AM6:49 AM"
      // appears because the AM/PM hover renders inline). Best-effort:
      // remove a duplicated AM/PM suffix and any trailing absolute time.
      const timeRe = /(\\d{1,2}:\\d{2}\\s?(?:AM|PM))(\\1)?$/i;
      const text = rawText ? rawText.replace(timeRe, '').trim().slice(0, 1000) : null;

      const hasAv = !!root.querySelector('[aria-label="Seek"], [aria-label*="audio" i], [aria-label*="video" i]');
      // Screenshots: look for <img> children that are clearly the
      // message payload (skip emoji/status icons by requiring size).
      const imgEls = Array.from(root.querySelectorAll('img'));
      const mediaUrls = imgEls
        .map((el) => {
          const e = el as HTMLImageElement;
          const src = e.currentSrc || e.src || '';
          const w = e.naturalWidth || e.width || 0;
          const h = e.naturalHeight || e.height || 0;
          // pbs.twimg.com dm URLs are the real payloads; emoji svgs are on twimg CDN too but under /emoji/.
          const looksLikeDmMedia = src.includes('/dm/') || src.includes('ton.twitter.com') || (w * h) >= 64 * 64;
          return src && looksLikeDmMedia && !src.includes('/emoji/') ? src : null;
        })
        .filter((s) => typeof s === 'string' && s.length > 0) as string[];
      const hasImage = mediaUrls.length > 0;
      const isMedia = hasAv || hasImage;
      const mediaKind = hasImage ? 'image' : hasAv ? 'other' : null;

      // Direction: the message bubble's class list carries either
      // bg-primary (we sent) or bg-gray-50 (they sent). Fall back to
      // 'unknown' for system rows or future X redesigns.
      let direction = 'unknown';
      const bubble = root.querySelector('[class*="bg-primary"], [class*="bg-gray-50"]');
      const cls = bubble ? (bubble.className || '').toString() : '';
      if (cls.includes('bg-primary')) direction = 'outbound';
      else if (cls.includes('bg-gray-50')) direction = 'inbound';

      return { id, text, direction, isMedia, mediaKind, mediaUrls };
    });

    return { conversationName, messages };
  })()`);

  // Cap from the newest end so callers don't pay for ancient history.
  const trimmed = (probe.messages ?? []).slice(-limit) as DmMessage[];

  return {
    success: true,
    message: `Read ${trimmed.length} message(s) from ${pairHyphen}.`,
    conversationName: probe.conversationName,
    messages: trimmed,
    currentUrl,
  };
  } finally {
    page.close();
  }
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

  const page = await getCdpPage('x.com', input.expectedBrowserContextId);
  if (!page) return { success: false, message: 'Could not attach to Chrome CDP.' };

  try {
  // Either navigate directly to the thread URL, or open from the inbox.
  if (pairHyphen) {
    await page.goto(`https://x.com/i/chat/${pairHyphen}`);
  } else {
    await page.goto(DM_INBOX_URL);
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
    if (!await page.clickSelector('[data-x-click-target="1"]', 5000)) {
      return { success: false, message: 'Could not open matched conversation within 5s.' };
    }
    await wait(HYDRATION_WAIT_MS);
  }

  // Wait for the composer to appear, then type.
  const composerReady = await page.waitForSelector('textarea[data-testid="dm-composer-textarea"]', 10000);
  if (!composerReady) {
    return {
      success: false,
      message: 'DM composer textarea did not appear. The conversation may not have opened.',
      screenshotBase64: await captureScreenshot(page),
      currentUrl: await page.url(),
    };
  }

  await page.clickSelector('textarea[data-testid="dm-composer-textarea"]', 2000);
  await page.typeText(text);
  await wait(400);

  const screenshotBase64 = await captureScreenshot(page);
  const landedPair = pairColon || pairHyphen || '(handle lookup)';

  if (dryRun) {
    logger.info('[x-posting] DM dry run — composed but not sent');
    return {
      success: true,
      message: `Dry run complete. Composed DM to ${landedPair}: "${text.slice(0, 60)}...". Call again with dry_run=false to send.`,
      screenshotBase64,
      currentUrl: await page.url(),
      landedAt: landedPair,
    };
  }

  const sendClicked = await page.clickSelector('[data-testid="dm-composer-send-button"]', 5000);
  if (!sendClicked) {
    return {
      success: false,
      message: 'DM send button never became clickable within 5s.',
      screenshotBase64,
    };
  }
  await wait(POST_SETTLE_MS);
  logger.info(`[x-posting] DM sent to ${landedPair}`);
  return {
    success: true,
    message: `DM sent to ${landedPair}.`,
    screenshotBase64: await captureScreenshot(page) || screenshotBase64,
    currentUrl: await page.url(),
    landedAt: landedPair,
  };
  } finally {
    page.close();
  }
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

  const page = await getCdpPage('x.com', input.expectedBrowserContextId);
  if (!page) return { success: false, message: 'Could not attach to Chrome CDP.' };

  try {
  await page.goto(`https://x.com/${handle}`);
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

  if (!await page.clickSelector('[data-x-click-target="1"]', 5000)) {
    return { success: false, message: 'Caret button was not clickable within 5s.' };
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

  const confirmPrimary = await page.clickSelector('[data-testid="confirmationSheetConfirm"]', 5000);
  if (!confirmPrimary) {
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
    currentUrl: await page.url(),
  };
  } finally {
    page.close();
  }
}
