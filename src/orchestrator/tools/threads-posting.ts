/**
 * Threads (threads.com) browser tools — drive the user's real logged-in
 * Chrome via CDP to post on Threads. No API key: every action goes out
 * from the user's own Chrome session exactly as if they'd done it by hand.
 *
 * Architecture mirrors x-posting.ts: raw CDP connection to debug Chrome,
 * profile pinning via browserContextId, dry-run-by-default safety,
 * identity verification before posting.
 *
 * Proven selectors (verified live on a real Threads account, 2026-04-16):
 *   - Compose open:        svg[aria-label="Create"] → click closest parent
 *   - Compose dialog:      [role="dialog"]
 *   - Compose textbox:     [role="dialog"] [role="textbox"][contenteditable="true"]
 *   - Post button:         button/div with text "Post" inside dialog
 *   - Add to thread:       button/div with text "Add to thread" inside dialog
 *   - Cancel button:       button/div with text "Cancel" inside dialog
 *   - Discard confirm:     button/div with text "Discard" (secondary dialog on cancel-with-text)
 *   - Identity (nav):      svg[aria-label="Profile"] → closest a[href] → /@handle
 *   - Identity (compose):  dialog a[href^="/@"] → /@handle
 *   - Profile page:        https://www.threads.com/@handle
 *   - Post URL:            https://www.threads.com/@handle/post/<shortcode>
 *
 * Gotchas:
 *   - threads.net redirects to threads.com — always match both
 *   - Threads has NO data-testid attributes; everything is aria-label + text-based
 *   - Compose is a modal (role="dialog"), not a URL route
 *   - The "Post" button is a div[role="button"], not a <button>
 *   - Max post length is 500 characters
 *   - "Add to thread" creates additional textboxes inside the same dialog
 *   - When canceling with unsaved text, a "Discard" confirmation dialog appears
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { logger } from '../../lib/logger.js';
import type { RawCdpPage } from '../../execution/browser/raw-cdp.js';
import {
  withCdpTab,
  getCdpPageForPlatform,
  captureScreenshot,
  clickByText,
  clearTextbox,
  wait,
  jitteredWait,
  warmupBrowse,
  confirmPostLanded,
  clickFirstEnabledSubmit,
  HYDRATION_WAIT_MS,
  POST_SETTLE_MS,
  type ComposeResult,
  type CdpPageHandle,
} from './social-cdp-helpers.js';

// ---------------------------------------------------------------------------
// Tool schema definitions
// ---------------------------------------------------------------------------

export const THREADS_POSTING_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'threads_compose_post',
    description: 'Compose a single post (up to 500 chars) on Threads by driving the user\'s real logged-in Chrome. Opens the compose modal, types the text, and optionally publishes. DEFAULTS TO DRY RUN: the tool types the text into compose but does NOT click Post unless you explicitly pass dry_run=false. Use threads_compose_thread for multi-post threads.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description: 'The post text, verbatim, up to 500 characters. Will be typed exactly as provided.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true (default), types the text in compose and screenshots it but does NOT publish. Set to false to actually publish. Always dry-run first unless the user explicitly asked to publish.',
        },
        profile: {
          type: 'string',
          description: 'Chrome profile to use for the real logged-in session. Accepts an email or profile directory name. Defaults to the owner\'s profile.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'threads_compose_thread',
    description: 'Compose a multi-post thread on Threads by driving the user\'s real logged-in Chrome. Opens the compose modal, types each post in sequence, chains them via the "Add to thread" button, and optionally publishes them all. DEFAULTS TO DRY RUN. Each post must be up to 500 chars.',
    input_schema: {
      type: 'object' as const,
      properties: {
        posts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of post strings, in order. Each up to 500 chars. The tool chains them into a thread.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true (default), composes the thread and screenshots it but does NOT publish. Set to false to publish all posts.',
        },
        profile: {
          type: 'string',
          description: 'Chrome profile to use. Same rules as threads_compose_post.',
        },
      },
      required: ['posts'],
    },
  },
  {
    name: 'threads_read_profile',
    description: 'Read the logged-in Threads handle from the browser. Returns the @handle of the account currently signed into Threads in the target Chrome profile. Useful for verifying identity before posting.',
    input_schema: {
      type: 'object' as const,
      properties: {
        profile: {
          type: 'string',
          description: 'Chrome profile to use.',
        },
      },
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComposeThreadsPostInput {
  text: string;
  dryRun?: boolean;
  expectedHandle?: string;
  expectedBrowserContextId?: string;
}

export interface ComposeThreadsThreadInput {
  posts: string[];
  dryRun?: boolean;
  expectedHandle?: string;
  expectedBrowserContextId?: string;
}

export interface ReadThreadsProfileInput {
  expectedBrowserContextId?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_POST_LENGTH = 500;
const LOG_TAG = 'threads-posting';
const THREADS_HOME = 'https://www.threads.com/';

// Selectors
const SEL_DIALOG = '[role="dialog"]';
const SEL_TEXTBOX = `${SEL_DIALOG} [role="textbox"][contenteditable="true"]`;

// ---------------------------------------------------------------------------
// CDP connection
// ---------------------------------------------------------------------------

function isThreadsUrl(url: string): boolean {
  return url.includes('threads.com') || url.includes('threads.net');
}

async function getThreadsCdpPage(expectedContextId?: string): Promise<CdpPageHandle | null> {
  return getCdpPageForPlatform({
    urlMatcher: isThreadsUrl,
    fallbackUrl: THREADS_HOME,
    expectedContextId,
    logTag: LOG_TAG,
    // Compose + reply paths must not touch a human's Threads tab.
    ownershipMode: 'ours',
  });
}

// ---------------------------------------------------------------------------
// Identity verification
// ---------------------------------------------------------------------------

/**
 * Read the active Threads handle from the nav sidebar.
 * The Profile nav item is: svg[aria-label="Profile"] → parent <a href="/@handle">
 */
export async function readActiveThreadsHandle(page: RawCdpPage): Promise<string | null> {
  try {
    const raw = await page.evaluate<string | null>(`(() => {
      // Primary: Profile link in sidebar
      const svg = document.querySelector('svg[aria-label="Profile"]');
      if (svg) {
        let el = svg;
        for (let i = 0; i < 5; i++) {
          el = el.parentElement;
          if (!el) break;
          if (el.tagName === 'A' && el.getAttribute('href')) {
            const m = el.getAttribute('href').match(/^\\/@([^/?#]+)/);
            if (m) return m[1];
          }
        }
      }
      // Fallback: first /@handle link on the page
      const link = document.querySelector('a[href^="/@"]');
      if (link) {
        const m = link.getAttribute('href').match(/^\\/@([^/?#]+)/);
        if (m) return m[1];
      }
      return null;
    })()`);
    return raw ? raw.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Read the handle from an open compose dialog.
 * Inside the dialog, the username appears as an a[href^="/@handle"] link.
 */
async function readHandleFromCompose(page: RawCdpPage): Promise<string | null> {
  try {
    const raw = await page.evaluate<string | null>(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return null;
      const links = dialog.querySelectorAll('a[href^="/@"]');
      for (const l of links) {
        const m = l.getAttribute('href').match(/^\\/@([^/?#]+)/);
        if (m) return m[1];
      }
      return null;
    })()`);
    return raw ? raw.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Refuse to proceed if the active Threads account doesn't match `expected`.
 */
async function assertSignedInAs(page: RawCdpPage, expected: string): Promise<ComposeResult | null> {
  const target = expected.replace(/^@/, '').toLowerCase();
  const currentUrl = await page.url();

  // If not on threads, navigate there
  if (!isThreadsUrl(currentUrl)) {
    await page.goto(THREADS_HOME);
    await wait(HYDRATION_WAIT_MS);
  }

  // Check for login redirect
  const url = await page.url();
  if (url.includes('/login') || url.includes('/accounts/login')) {
    return {
      success: false,
      message: `Threads redirected to login; expected handle @${target} is not signed in on this profile.`,
      currentUrl: url,
    };
  }

  // Read handle with retries
  let handle: string | null = null;
  for (let i = 0; i < 4; i++) {
    handle = await readActiveThreadsHandle(page);
    if (handle) break;
    await wait(750);
  }

  if (!handle) {
    return {
      success: false,
      message: 'Could not read the logged-in Threads handle from the page. Refusing to post without verifying identity.',
    };
  }

  if (handle !== target) {
    return {
      success: false,
      message: `Profile mismatch: Threads is signed in as @${handle}, but expected @${target}. Refusing to post.`,
      currentUrl: await page.url(),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Compose helpers
// ---------------------------------------------------------------------------

/**
 * Open the Threads compose dialog by clicking the Create nav button.
 * Dismisses any existing dialog first to ensure a clean slate.
 * Returns true if the dialog appeared within timeout.
 */
async function openComposeDialog(page: RawCdpPage): Promise<boolean> {
  // Dismiss any stale dialog (leftover from a previous session/crash)
  const hasStaleDialog = await page.evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`);
  if (hasStaleDialog) {
    await dismissComposeDialog(page);
    await wait(500);
  }

  // Click the Create button (SVG in the nav)
  const clicked = await page.evaluate<boolean>(`(() => {
    const svg = document.querySelector('svg[aria-label="Create"]');
    if (!svg) return false;
    let el = svg;
    for (let i = 0; i < 5; i++) {
      el = el.parentElement;
      if (!el) break;
      if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
        el.click();
        return true;
      }
    }
    // Fallback: click the SVG's immediate parent
    if (svg.parentElement) { svg.parentElement.click(); return true; }
    return false;
  })()`);

  if (!clicked) return false;

  // Wait for dialog to mount
  return page.waitForSelector(SEL_DIALOG, 5000);
}

/**
 * Dismiss any open compose dialog. Handles the "Discard" confirmation
 * that appears when canceling with unsaved text.
 */
async function dismissComposeDialog(page: RawCdpPage): Promise<void> {
  try {
    // Try Cancel button first
    await clickByText(page, 'Cancel');
    await wait(500);

    // Handle "Discard" confirmation dialog if it appeared
    const hasDiscard = await page.evaluate<boolean>(`(() => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      for (const d of dialogs) {
        const btns = Array.from(d.querySelectorAll('button, [role="button"], div[role="button"]'));
        const discard = btns.find(b => (b.textContent || '').trim() === 'Discard');
        if (discard) { discard.click(); return true; }
      }
      return false;
    })()`);
    if (hasDiscard) {
      await wait(300);
    }
  } catch {
    /* best effort */
  }
}

/**
 * Focus the Nth textbox inside the compose dialog (0-indexed).
 * Returns true if focused.
 */
async function focusComposeTextbox(page: RawCdpPage, index = 0): Promise<boolean> {
  try {
    const ok = await page.evaluate<boolean>(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return false;
      const boxes = dialog.querySelectorAll('[role="textbox"][contenteditable="true"]');
      const el = boxes[${index}];
      if (!(el instanceof HTMLElement)) return false;
      el.scrollIntoView({ block: 'center' });
      el.focus();
      return document.activeElement === el;
    })()`);
    return ok === true;
  } catch {
    return false;
  }
}

/**
 * Read the post outcome after clicking Post. Returns:
 *   - 'still_open' — dialog is still showing (post failed)
 *   - 'published'  — dialog closed (post went through)
 */
async function readPostOutcome(page: RawCdpPage): Promise<'still_open' | 'published'> {
  try {
    const dialogOpen = await page.evaluate<boolean>(`(() => {
      return !!document.querySelector('[role="dialog"] [role="textbox"][contenteditable="true"]');
    })()`);
    return dialogOpen ? 'still_open' : 'published';
  } catch {
    return 'published';
  }
}

// ---------------------------------------------------------------------------
// Single post compose
// ---------------------------------------------------------------------------

export async function composeThreadsPostViaBrowser(input: ComposeThreadsPostInput): Promise<ComposeResult> {
  const text = (input.text || '').trim();
  const dryRun = input.dryRun !== false;

  if (!text) return { success: false, message: 'text is required' };
  if (text.length > MAX_POST_LENGTH) {
    return {
      success: false,
      message: `Post is ${text.length} chars, Threads limit is ${MAX_POST_LENGTH}. Trim or use threads_compose_thread.`,
    };
  }

  const handle = await getThreadsCdpPage(input.expectedBrowserContextId);
  if (!handle) {
    return {
      success: false,
      message: 'Could not attach to Chrome CDP at :9222. No threads.com tab open, or debug Chrome is down. Open threads.com in the target profile window and retry.',
    };
  }

  const { page, created } = handle;
  try {
    // Ensure we're on Threads
    const currentUrl = await page.url();
    if (!isThreadsUrl(currentUrl)) {
      await page.goto(THREADS_HOME);
      await jitteredWait(HYDRATION_WAIT_MS, 0.3);
      await warmupBrowse(page);
    }

    // Identity verification
    if (input.expectedHandle) {
      const mismatch = await assertSignedInAs(page, input.expectedHandle);
      if (mismatch) return mismatch;
    }

    // Open compose dialog
    const dialogOpened = await openComposeDialog(page);
    if (!dialogOpened) {
      return {
        success: false,
        message: 'Could not open Threads compose dialog. The Create button may not be visible.',
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }

    await jitteredWait(500, 0.5);

    // Focus textbox
    const focused = await focusComposeTextbox(page, 0);
    if (!focused) {
      await dismissComposeDialog(page);
      return {
        success: false,
        message: 'Could not focus the Threads compose textbox.',
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }

    // Clear any residual text (e.g., from a saved draft or a stale dialog)
    await clearTextbox(page, SEL_TEXTBOX);
    await jitteredWait(200, 0.4);

    // Re-focus after clear (selectAll+delete may have moved focus)
    await focusComposeTextbox(page, 0);

    // Warmup: space + backspace to avoid first-keystroke-dropped glitch
    await page.typeText(' ');
    await page.pressKey('Backspace');

    // Type the post text
    await page.typeText(text);
    await jitteredWait(400, 0.4);

    const screenshotBase64 = await captureScreenshot(page);

    if (dryRun) {
      logger.info(`[${LOG_TAG}] Post dry run — composed but did not publish`);
      return {
        success: true,
        message: `Dry run complete. Composed ${text.length} chars in Threads compose modal. Call again with dry_run=false to publish.`,
        screenshotBase64,
        postsTyped: 1,
        postsPublished: 0,
        currentUrl: await page.url(),
      };
    }

    // Click Post — scoped to the dialog so we don't hit the nav-rail
    // "Post" launcher. clickFirstEnabledSubmit polls until a Post
    // button inside [role="dialog"] is enabled + visible. Without the
    // enablement poll, Threads' Post button is aria-disabled=true
    // right after typing (internal state sync is async); clicking a
    // disabled submit registers nothing and readPostOutcome then
    // reports still_open, which the caller interprets as rejection.
    const submit = await clickFirstEnabledSubmit(page, {
      textMatch: 'Post',
      containerSelector: '[role="dialog"]',
      timeoutMs: 10_000,
      logTag: LOG_TAG,
    });
    if (!submit.clicked) {
      await dismissComposeDialog(page);
      return {
        success: false,
        message: `Post button was not clickable within 10s. diag=${JSON.stringify(submit.diagnostic ?? {})}`,
        screenshotBase64,
        postsTyped: 1,
        postsPublished: 0,
      };
    }

    await jitteredWait(POST_SETTLE_MS, 0.25);

    const outcome = await readPostOutcome(page);
    const postShot = await captureScreenshot(page);

    if (outcome === 'still_open') {
      const diag = await page.evaluate<{
        url: string;
        dialogCount: number;
        dialogTexts: string[];
        overlayAlert: string;
      }>(
        `(() => {
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
          const alerts = Array.from(document.querySelectorAll('[role="alert"], [aria-live="polite"]'));
          return {
            url: location.href,
            dialogCount: dialogs.length,
            dialogTexts: dialogs.map((d) => (d.textContent || '').trim().slice(0, 120)),
            overlayAlert: alerts.map((a) => (a.textContent || '').trim()).filter(Boolean).slice(0, 2).join(' || ').slice(0, 200),
          };
        })()`,
      ).catch(() => ({ url: '?', dialogCount: -1, dialogTexts: [], overlayAlert: '' }));
      logger.warn(diag, `[${LOG_TAG}] still_open — compose dialog did not close after submit`);
      await dismissComposeDialog(page);
      return {
        success: false,
        message: `Post button clicked but the compose dialog did not close. diag=${JSON.stringify(diag)}`,
        screenshotBase64: postShot || screenshotBase64,
        postsTyped: 1,
        postsPublished: 0,
        currentUrl: await page.url(),
      };
    }

    // Positive landing check: dialog-closed is necessary but not
    // sufficient. We've seen the dialog close without publish (race on
    // focus/escape, auto-dismissed error toast). Poll 2.5s for our
    // text in the feed before committing to success. Only flip to
    // failure on a confident "not visible" — a probe error stays on
    // the legacy success path to avoid inventing failures.
    const landing = await confirmPostLanded(page, text, 2500);
    if (landing === 'not_visible') {
      logger.warn(`[${LOG_TAG}] dialog closed but text not visible within 2.5s — treating as silent failure`);
      return {
        success: false,
        message: 'Compose dialog closed but the post text did not appear on the page within 2.5s. Threads may have silently dropped the post; re-check the profile.',
        screenshotBase64: await captureScreenshot(page) || postShot || screenshotBase64,
        postsTyped: 1,
        postsPublished: 0,
        currentUrl: await page.url(),
      };
    }

    logger.info({ landing }, `[${LOG_TAG}] Post published`);
    return {
      success: true,
      message: `Threads post published (${text.length} chars).`,
      screenshotBase64: postShot || screenshotBase64,
      postsTyped: 1,
      postsPublished: 1,
      currentUrl: await page.url(),
    };
  } finally {
    if (created) {
      await page.closeAndCleanup();
    } else {
      page.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Thread compose (multi-post)
// ---------------------------------------------------------------------------

export async function composeThreadsThreadViaBrowser(input: ComposeThreadsThreadInput): Promise<ComposeResult> {
  const posts = (input.posts || []).map((t) => (t || '').trim()).filter((t) => t.length > 0);
  const dryRun = input.dryRun !== false;

  if (posts.length === 0) return { success: false, message: 'posts must be a non-empty array' };
  for (let i = 0; i < posts.length; i++) {
    if (posts[i].length > MAX_POST_LENGTH) {
      return {
        success: false,
        message: `Post ${i + 1}/${posts.length} is ${posts[i].length} chars — over ${MAX_POST_LENGTH} limit.`,
      };
    }
  }

  const handle2 = await getThreadsCdpPage(input.expectedBrowserContextId);
  if (!handle2) return { success: false, message: 'Could not attach to Chrome CDP.' };

  const { page, created } = handle2;
  try {
    // Ensure we're on Threads
    const currentUrl = await page.url();
    if (!isThreadsUrl(currentUrl)) {
      await page.goto(THREADS_HOME);
      await jitteredWait(HYDRATION_WAIT_MS, 0.3);
      await warmupBrowse(page);
    }

    // Identity verification
    if (input.expectedHandle) {
      const mismatch = await assertSignedInAs(page, input.expectedHandle);
      if (mismatch) return mismatch;
    }

    // Open compose dialog
    const dialogOpened = await openComposeDialog(page);
    if (!dialogOpened) {
      return {
        success: false,
        message: 'Could not open Threads compose dialog.',
        screenshotBase64: await captureScreenshot(page),
      };
    }

    await jitteredWait(500, 0.5);

    // Type first post
    if (!await focusComposeTextbox(page, 0)) {
      await dismissComposeDialog(page);
      return {
        success: false,
        message: 'Could not focus the first Threads compose textbox.',
        screenshotBase64: await captureScreenshot(page),
      };
    }

    // Clear any residual text from drafts
    await clearTextbox(page, SEL_TEXTBOX);
    await jitteredWait(200, 0.4);
    await focusComposeTextbox(page, 0);

    await page.typeText(' ');
    await page.pressKey('Backspace');
    await page.typeText(posts[0]);
    let postsTyped = 1;

    // Add subsequent posts
    for (let i = 1; i < posts.length; i++) {
      const addClicked = await clickByText(page, 'Add to thread');
      if (!addClicked) {
        return {
          success: false,
          message: `Could not click "Add to thread" for post ${i + 1}.`,
          screenshotBase64: await captureScreenshot(page),
          postsTyped,
        };
      }
      await jitteredWait(800, 0.4);

      if (!await focusComposeTextbox(page, i)) {
        return {
          success: false,
          message: `Could not focus thread post ${i + 1}.`,
          screenshotBase64: await captureScreenshot(page),
          postsTyped,
        };
      }

      await page.typeText(posts[i]);
      postsTyped++;
    }

    await jitteredWait(400, 0.4);
    const screenshotBase64 = await captureScreenshot(page);

    if (dryRun) {
      logger.info(`[${LOG_TAG}] Thread dry run — typed ${postsTyped} posts`);
      return {
        success: true,
        message: `Dry run complete. Composed ${postsTyped}-post thread. Call again with dry_run=false to publish.`,
        screenshotBase64,
        postsTyped,
        postsPublished: 0,
        currentUrl: await page.url(),
      };
    }

    const submit = await clickFirstEnabledSubmit(page, {
      textMatch: 'Post',
      containerSelector: '[role="dialog"]',
      timeoutMs: 10_000,
      logTag: LOG_TAG,
    });
    if (!submit.clicked) {
      await dismissComposeDialog(page);
      return {
        success: false,
        message: `Post all button was not clickable within 10s. diag=${JSON.stringify(submit.diagnostic ?? {})}`,
        screenshotBase64,
        postsTyped,
        postsPublished: 0,
      };
    }

    await jitteredWait(POST_SETTLE_MS, 0.25);

    const outcome = await readPostOutcome(page);
    if (outcome === 'still_open') {
      await dismissComposeDialog(page);
      return {
        success: false,
        message: 'Post button clicked but compose dialog did not close. Threads likely rejected the content.',
        screenshotBase64: await captureScreenshot(page) || screenshotBase64,
        postsTyped,
        postsPublished: 0,
        currentUrl: await page.url(),
      };
    }

    // Positive landing check against the last post in the thread. The
    // first post could be echoed by lingering compose state; the final
    // post only lands once the whole thread is actually submitted.
    const probeText = posts[posts.length - 1];
    const landing = await confirmPostLanded(page, probeText, 2500);
    if (landing === 'not_visible') {
      logger.warn({ postsTyped }, `[${LOG_TAG}] thread dialog closed but last-post text not visible — silent failure`);
      return {
        success: false,
        message: `Threads thread dialog closed but the last post (${probeText.slice(0, 40)}...) did not appear within 2.5s. Threads may have dropped the thread.`,
        screenshotBase64: await captureScreenshot(page) || screenshotBase64,
        postsTyped,
        postsPublished: 0,
        currentUrl: await page.url(),
      };
    }

    logger.info({ postsTyped, landing }, `[${LOG_TAG}] Thread published`);
    return {
      success: true,
      message: `Threads thread published (${postsTyped} posts).`,
      screenshotBase64: await captureScreenshot(page) || screenshotBase64,
      postsTyped,
      postsPublished: postsTyped,
      currentUrl: await page.url(),
    };
  } finally {
    if (created) {
      await page.closeAndCleanup();
    } else {
      page.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Read profile
// ---------------------------------------------------------------------------

export async function readThreadsProfileViaBrowser(input: ReadThreadsProfileInput): Promise<ComposeResult & { handle?: string }> {
  const profileHandle = await getThreadsCdpPage(input.expectedBrowserContextId);
  if (!profileHandle) {
    return { success: false, message: 'Could not attach to Chrome CDP. No threads.com tab open, or debug Chrome is down.' };
  }

  const { page, created } = profileHandle;
  try {
    const currentUrl = await page.url();
    if (!isThreadsUrl(currentUrl)) {
      await page.goto(THREADS_HOME);
      await wait(HYDRATION_WAIT_MS);
    }

    let handle: string | null = null;
    for (let i = 0; i < 4; i++) {
      handle = await readActiveThreadsHandle(page);
      if (handle) break;
      await wait(750);
    }

    if (!handle) {
      return {
        success: false,
        message: 'Could not read the logged-in Threads handle. The user may not be signed in.',
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }

    return {
      success: true,
      message: `Signed in to Threads as @${handle}.`,
      handle,
      currentUrl: await page.url(),
    };
  } finally {
    if (created) {
      await page.closeAndCleanup();
    } else {
      page.close();
    }
  }
}
