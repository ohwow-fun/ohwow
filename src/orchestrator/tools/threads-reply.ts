/**
 * threads-reply.ts — scan Threads feeds and reply to a specific post.
 *
 * Mirrors x-reply.ts in shape. Two deterministic tools:
 *
 *   scanThreadsPostsViaBrowser({ source, limit })
 *     Navigates home / user / search / url, parses rendered posts,
 *     returns a structured list.
 *
 *   composeThreadsReplyViaBrowser({ replyToUrl, text, dryRun })
 *     Navigates to the target post, opens its reply composer, types,
 *     and submits (or stops at dry-run).
 *
 * Threads' DOM doesn't carry X-style data-testid markers on feed
 * cards, so the scraper anchors on the canonical post link pattern
 * `a[href^="/@"][href*="/post/"]`. That link uniquely identifies a
 * post; from there we walk up to the post container and read the
 * text + metric aria-labels.
 *
 * Source string grammar:
 *   home               → https://www.threads.com/
 *   following          → https://www.threads.com/?feed=following
 *   user:@handle       → https://www.threads.com/@handle
 *   search:<query>     → https://www.threads.com/search?q=<q>
 *   url:<exact>        → <exact>
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { logger } from '../../lib/logger.js';
import type { RawCdpPage } from '../../execution/browser/raw-cdp.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import {
  getCdpPageForPlatform,
  captureScreenshot,
  clickByText,
  clearTextbox,
  wait,
  HYDRATION_WAIT_MS,
  type CdpPageHandle,
} from './social-cdp-helpers.js';
import { hashText, hasIdenticalPublished, recordPost } from './posted-log-helpers.js';

// ---------------------------------------------------------------------------
// Tool schema definitions
// ---------------------------------------------------------------------------

export const THREADS_REPLY_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'threads_scan_posts',
    description:
      'Scan a feed / profile / search on Threads and return a structured list of posts the caller can filter and pick from. No writes. Source formats: "home" | "following" | "user:@handle" | "search:<query>" | "url:<direct>". Use this before threads_compose_reply to pick a target.',
    input_schema: {
      type: 'object' as const,
      properties: {
        source: {
          type: 'string',
          description:
            'Where to scan. "home", "following", "user:@handle", "search:<query>", or "url:<exact-threads.com-url>".',
        },
        limit: {
          type: 'number',
          description: 'Max posts to return. Default 20, cap 100.',
        },
        scroll_rounds: {
          type: 'number',
          description: 'Scroll passes to hydrate more posts. Default 3, cap 10.',
        },
        profile: {
          type: 'string',
          description: 'Chrome profile to use.',
        },
      },
      required: ['source'],
    },
  },
  {
    name: 'threads_compose_reply',
    description:
      'Reply to a specific Threads post by driving the user\'s real logged-in Chrome. Navigates to the post, clicks Reply, types the text, and optionally publishes. DEFAULTS TO DRY RUN. Pair with threads_scan_posts to pick a target.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reply_to_url: {
          type: 'string',
          description:
            'URL of the Threads post to reply to. Full URL (https://www.threads.com/@<handle>/post/<id>) or short form "handle/post/id".',
        },
        text: {
          type: 'string',
          description: 'Reply text, verbatim, ≤500 characters.',
        },
        dry_run: {
          type: 'boolean',
          description:
            'When true (default), composes the reply but does NOT click Post. Set to false to actually publish.',
        },
        profile: {
          type: 'string',
          description: 'Chrome profile to use.',
        },
      },
      required: ['reply_to_url', 'text'],
    },
  },
];

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface ScanThreadsInput {
  source: string;
  limit?: number;
  expectedBrowserContextId?: string;
  scrollRounds?: number;
}

export interface ScannedThread {
  /** Post id (last path segment of /@<handle>/post/<id>). */
  id: string;
  /** Canonical URL (https://www.threads.com/@<handle>/post/<id>). */
  url: string;
  /** Author handle without @. */
  authorHandle: string;
  /** Post body text — null when not renderable (image-only). */
  text: string | null;
  /** Reply count (null if not visible on this render). */
  replies: number | null;
  /** Like count. */
  likes: number | null;
  /** Repost count. */
  reposts: number | null;
  /** ISO timestamp from <time> element if present. */
  postedAt: string | null;
  /** True if this post is rendered as a reply (has "Replying to" context). */
  isReply: boolean;
}

export interface ScanThreadsResult {
  success: boolean;
  message: string;
  source: string;
  resolvedUrl: string;
  posts: ScannedThread[];
  currentUrl?: string;
  screenshotBase64?: string;
}

export interface ReplyThreadsInput {
  replyToUrl: string;
  text: string;
  dryRun?: boolean;
  expectedHandle?: string;
  expectedBrowserContextId?: string;
  /** Optional. When provided, enables deterministic dedup via posted_log. */
  db?: DatabaseAdapter;
  /** Workspace id for posted_log row. Resolved positionally if null. */
  workspaceId?: string;
}

export interface ReplyThreadsResult {
  success: boolean;
  message: string;
  screenshotBase64?: string;
  currentUrl?: string;
  replyTyped?: number;
  replyPublished?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THREADS_HOME = 'https://www.threads.com/';
const MAX_POST_LENGTH = 500;
const LOG_TAG = 'threads-reply';

function isThreadsUrl(url: string): boolean {
  return url.includes('threads.com') || url.includes('threads.net');
}

async function getThreadsCdpPage(expectedContextId?: string): Promise<CdpPageHandle | null> {
  return getCdpPageForPlatform({
    urlMatcher: isThreadsUrl,
    fallbackUrl: THREADS_HOME,
    expectedContextId,
    logTag: LOG_TAG,
    // Reply path must not touch a human's Threads tab.
    ownershipMode: 'ours',
  });
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

export function resolveThreadsSourceUrl(source: string): string {
  const s = source.trim();
  if (s === 'home') return THREADS_HOME;
  if (s === 'following') return `${THREADS_HOME}?feed=following`;
  if (s.startsWith('user:')) {
    const handle = s.slice(5).replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '');
    if (!handle) throw new Error(`scanThreadsPosts: empty user handle in "${source}"`);
    return `${THREADS_HOME}@${handle}`;
  }
  if (s.startsWith('search:')) {
    const query = s.slice(7).trim();
    if (!query) throw new Error(`scanThreadsPosts: empty search query in "${source}"`);
    // Append filter=recent so Threads returns the "Recent" tab instead of
    // the default "Top". Recent is what we want for reply automation —
    // fresh posts that can actually receive a reply before the thread
    // becomes a feed graveyard.
    return `${THREADS_HOME}search?q=${encodeURIComponent(query)}&filter=recent`;
  }
  if (s.startsWith('url:')) return s.slice(4).trim();
  throw new Error(
    `scanThreadsPosts: unknown source "${source}". Supported: home | following | user:@handle | search:<query> | url:<direct>`,
  );
}

// ---------------------------------------------------------------------------
// Full-text fetcher — use after selection to enrich a candidate with the
// full primary-post text that the feed/search scan truncated.
// ---------------------------------------------------------------------------

/**
 * Navigate to a Threads post detail URL and return its full primary
 * post text. Search/feed scans show truncated previews (Threads itself
 * ships a ~180-char preview for long posts); the detail page renders
 * the whole text in a single span[dir="auto"]. Use this for each top-N
 * candidate right before drafting so the LLM sees the full post.
 *
 * Identifies the primary post by walking from the permalink anchor
 * (a[href*="/post/<id>"]) up to the containing card, then picks the
 * longest visible span/div[dir="auto"] inside that card — excludes
 * replies (which live in separate cards farther down the DOM).
 */
export async function fetchThreadsPostFullText(
  url: string,
  expectedBrowserContextId?: string,
): Promise<string | null> {
  const m = url.match(/\/post\/([^/?#]+)/);
  if (!m) return null;
  const postId = m[1];

  const handle = await getThreadsCdpPage(expectedBrowserContextId);
  if (!handle) return null;
  const { page, created } = handle;
  try {
    await page.goto(url);
    await wait(HYDRATION_WAIT_MS);

    const text = await page.evaluate<string | null>(`(() => {
      const postId = ${JSON.stringify(postId)};
      // Permalink anchor inside the primary post card.
      const link = document.querySelector('a[href*="/post/' + postId + '"]');
      if (!link) return null;
      // Climb to the containing post card (has time + Reply action bar).
      let el = link;
      for (let i = 0; i < 14; i++) {
        if (!el.parentElement) break;
        el = el.parentElement;
        const hasTime = el.querySelector('time');
        const hasReplyBtn = Array.from(el.querySelectorAll('div, [role="button"]')).some(
          (b) => (b.textContent || '').trim() === 'Reply',
        );
        const txtLen = (el.innerText || '').length;
        if (!hasTime || !hasReplyBtn || txtLen < 20 || txtLen > 4500) continue;
        // Found a valid card. Extract its longest text block.
        const textNodes = Array.from(el.querySelectorAll('span[dir="auto"], div[dir="auto"]'))
          .filter((n) => !!n.offsetParent)
          .map((n) => (n.textContent || '').trim())
          .filter((t) => {
            if (t.length <= 10) return false;
            if (t.startsWith('@')) return false;
            if (/^\\d+[smhdwMy]\\b/.test(t)) return false;
            if (/^(like|reply|repost|share)s?$/i.test(t)) return false;
            return true;
          });
        if (textNodes.length === 0) continue;
        textNodes.sort((a, b) => b.length - a.length);
        return textNodes[0];
      }
      return null;
    })()`).catch(() => null);

    return text;
  } finally {
    if (created) await page.closeAndCleanup(); else page.close();
  }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export async function scanThreadsPostsViaBrowser(
  input: ScanThreadsInput,
): Promise<ScanThreadsResult> {
  const source = input.source?.trim() ?? '';
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const scrollRounds = Math.max(0, Math.min(input.scrollRounds ?? 3, 10));

  let resolvedUrl: string;
  try {
    resolvedUrl = resolveThreadsSourceUrl(source);
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
      source,
      resolvedUrl: '',
      posts: [],
    };
  }

  const handle = await getThreadsCdpPage(input.expectedBrowserContextId);
  if (!handle) {
    return {
      success: false,
      message: 'Could not attach to Chrome CDP at :9222 — no threads.com tab open, or debug Chrome is down.',
      source,
      resolvedUrl,
      posts: [],
    };
  }

  const { page, created } = handle;
  try {
    await page.goto(resolvedUrl);
    await wait(HYDRATION_WAIT_MS);
    const currentUrl = await page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/accounts/login')) {
      return {
        success: false,
        message: `Threads redirected to login (${currentUrl}).`,
        source,
        resolvedUrl,
        posts: [],
        currentUrl,
      };
    }

    // Scroll to hydrate more posts.
    for (let i = 0; i < scrollRounds; i++) {
      await page.evaluate(`window.scrollBy(0, Math.round(window.innerHeight * 0.9))`);
      await wait(700);
    }
    await page.evaluate(`window.scrollTo(0, 0)`);
    await wait(250);

    const parsed = (await page.evaluate<ScannedThread[]>(`(() => {
      function parseCount(raw) {
        if (raw == null) return null;
        const s = String(raw).trim().replace(/,/g, '');
        if (!s) return 0;
        const m = s.match(/^([\\d.]+)\\s*([KMB])?/i);
        if (!m) return null;
        const n = parseFloat(m[1]);
        if (isNaN(n)) return null;
        const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
        return Math.round(n * mult);
      }
      function findMetric(container, keyword) {
        const labels = container.querySelectorAll('[aria-label]');
        for (const l of labels) {
          const aria = (l.getAttribute('aria-label') || '').toLowerCase();
          if (aria.includes(keyword)) {
            const match = aria.match(/([\\d,.KMB]+)\\s*' + keyword + '|' + keyword + '\\s*([\\d,.KMB]+)/i);
            if (match) return parseCount(match[1] || match[2]);
            // Fallback: number is in sibling/child text content.
            const txt = (l.textContent || '').trim();
            const mNum = txt.match(/^([\\d,.KMB]+)/i);
            if (mNum) return parseCount(mNum[1]);
          }
        }
        return null;
      }
      function climbToPostContainer(link) {
        // Walk up until we find the ancestor that contains the post's
        // text body AND action row. Heuristic: the first ancestor whose
        // innerText is ~<= 1000 chars (excludes the whole feed) and has
        // both a <time> descendant AND an element with aria-label for
        // a metric (reply/like/repost), OR contains multiple paragraphs.
        let el = link;
        let best = null;
        for (let i = 0; i < 14; i++) {
          if (!el || !el.parentElement) break;
          el = el.parentElement;
          const hasTime = el.querySelector('time');
          const textLen = (el.innerText || '').length;
          const metrics = el.querySelectorAll('[aria-label]').length;
          if (hasTime && textLen > 20 && textLen < 1500 && metrics > 0) {
            best = el;
            break;
          }
        }
        return best || link.parentElement || link;
      }
      const seen = new Set();
      const out = [];
      const links = document.querySelectorAll('a[href*="/post/"]');
      for (const link of links) {
        try {
          const href = link.getAttribute('href') || '';
          const m = href.match(/^\\/@([^/]+)\\/post\\/([^/?#]+)/);
          if (!m) continue;
          const authorHandle = m[1];
          const id = m[2];
          const key = authorHandle + '/' + id;
          if (seen.has(key)) continue;
          seen.add(key);

          const url = 'https://www.threads.com/@' + authorHandle + '/post/' + id;
          const container = climbToPostContainer(link);

          // Extract body text: pick the longest visible text chunk in the
          // container that isn't the handle, timestamp, or action label.
          // Threads renders post bodies inside span[dir=auto] OR plain
          // div[dir=auto] depending on the layout variant.
          let text = null;
          const textNodes = Array.from(
            container.querySelectorAll('span[dir="auto"], div[dir="auto"]'),
          );
          if (textNodes.length > 0) {
            const candidates = textNodes
              .map((s) => (s.textContent || '').trim())
              .filter((t) => {
                if (t.length <= 10) return false;
                if (t.startsWith('@')) return false;
                if (/^\\d+[smhdwMy]\\b/.test(t)) return false;
                if (/^(like|reply|repost|share)s?$/i.test(t)) return false;
                return true;
              });
            if (candidates.length > 0) {
              text = candidates.sort((a, b) => b.length - a.length)[0];
            }
          }

          // Time
          const timeEl = container.querySelector('time');
          const postedAt = timeEl ? timeEl.getAttribute('datetime') : null;

          // Metrics — Threads renders counts inside aria-labels like
          // "3 replies" or "12 likes" or "2 reposts" on the icon buttons.
          const replies = findMetric(container, 'repl');
          const likes = findMetric(container, 'like');
          const reposts = findMetric(container, 'repost');

          // isReply: "Replying to" header block somewhere in the container.
          const containerText = container.textContent || '';
          const isReply = /replying to/i.test(containerText);

          out.push({ id, url, authorHandle, text, replies, likes, reposts, postedAt, isReply });
        } catch (e) { /* skip broken post */ }
      }
      return out;
    })()`)) ?? [];

    const unique = parsed.slice(0, limit);

    return {
      success: true,
      message: `scanned ${unique.length} post(s) from ${resolvedUrl}`,
      source,
      resolvedUrl,
      posts: unique,
      currentUrl: await page.url(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, source, resolvedUrl }, `[${LOG_TAG}] scan failed`);
    return {
      success: false,
      message: `scan failed: ${msg}`,
      source,
      resolvedUrl,
      posts: [],
      screenshotBase64: await captureScreenshot(page).catch(() => undefined),
      currentUrl: await page.url().catch(() => undefined),
    };
  } finally {
    if (created) await page.closeAndCleanup(); else page.close();
  }
}

// ---------------------------------------------------------------------------
// Reply
// ---------------------------------------------------------------------------

function normalizeThreadsUrl(raw: string): string | null {
  const s = raw.trim();
  const mFull = s.match(/https?:\/\/(?:www\.)?threads\.(?:com|net)\/@([^/]+)\/post\/([^/?#]+)/i);
  if (mFull) return `https://www.threads.com/@${mFull[1]}/post/${mFull[2]}`;
  const mBare = s.match(/^@?([^/]+)\/post\/([^/?#]+)/);
  if (mBare) return `https://www.threads.com/@${mBare[1]}/post/${mBare[2]}`;
  return null;
}

export async function composeThreadsReplyViaBrowser(
  input: ReplyThreadsInput,
): Promise<ReplyThreadsResult> {
  const text = (input.text || '').trim();
  const dryRun = input.dryRun !== false;

  if (!text) return { success: false, message: 'text is required' };
  if (text.length > MAX_POST_LENGTH) {
    return {
      success: false,
      message: `Reply is ${text.length} chars, Threads limit is ${MAX_POST_LENGTH}. Trim it.`,
    };
  }
  const normalized = normalizeThreadsUrl(input.replyToUrl);
  if (!normalized) {
    return {
      success: false,
      message: `replyToUrl "${input.replyToUrl}" is not a recognizable Threads post URL.`,
    };
  }

  // Deterministic dedup: refuse to re-publish an identical text to the
  // same target. Prevents the retry-after-false-negative class of bug.
  const source = `reply_to:${normalized}`;
  const textHash = hashText(text);
  if (input.db && !dryRun) {
    const already = await hasIdenticalPublished(input.db, 'threads', textHash, source);
    if (already) {
      logger.info({ replyToUrl: normalized }, `[${LOG_TAG}] duplicate blocked by posted_log`);
      return {
        success: false,
        message: `Already replied to this post with identical text. Skipped to avoid duplicate (posted_log guard).`,
        replyTyped: 0,
        replyPublished: 0,
      };
    }
  }

  const handle = await getThreadsCdpPage(input.expectedBrowserContextId);
  if (!handle) {
    return {
      success: false,
      message: 'Could not attach to Chrome CDP at :9222 — no threads.com tab open, or debug Chrome is down.',
    };
  }

  const { page, created } = handle;
  try {
    await page.goto(normalized);
    await wait(HYDRATION_WAIT_MS);
    const currentUrl = await page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/accounts/login')) {
      return { success: false, message: `Threads redirected to login (${currentUrl}).`, currentUrl };
    }

    // Threads renders the reply composer two ways depending on layout:
    //   A) modal: click Reply → [role="dialog"] [role="textbox"] appears
    //   B) inline: post-detail page shows an always-visible textbox at
    //      the bottom. No click needed. The DOM already has
    //      [role="textbox"][contenteditable="true"] on load.
    // Accept either. Prefer dialog-scoped selector when both exist.
    const TEXTBOX_SEL_INLINE = '[role="textbox"][contenteditable="true"]';
    const TEXTBOX_SEL_DIALOG = '[role="dialog"] [role="textbox"][contenteditable="true"]';

    const alreadyOpen = await page.evaluate<boolean>(
      `!!document.querySelector('${TEXTBOX_SEL_INLINE}')`,
    );

    if (!alreadyOpen) {
      const opened = await clickReplyIcon(page);
      if (!opened) {
        return {
          success: false,
          message: 'Could not find an inline reply textbox OR a clickable Reply icon on the post detail page.',
          screenshotBase64: await captureScreenshot(page),
          currentUrl: await page.url(),
        };
      }
      // Wait for the textbox to mount (either layout).
      const ready = await page.waitForSelector(TEXTBOX_SEL_INLINE, 5000);
      if (!ready) {
        return {
          success: false,
          message: 'Threads reply textbox did not appear within 5s after clicking Reply.',
          screenshotBase64: await captureScreenshot(page),
          currentUrl: await page.url(),
        };
      }
    }

    // If a dialog version also exists, prefer it — the modal composer
    // is what Threads uses when you click Reply on the primary post.
    const hasDialog = await page.evaluate<boolean>(
      `!!document.querySelector('${TEXTBOX_SEL_DIALOG}')`,
    );
    const textboxSel = hasDialog ? TEXTBOX_SEL_DIALOG : TEXTBOX_SEL_INLINE;

    // Clear any residual / draft text.
    await clearTextbox(page, textboxSel);
    await wait(200);

    // Focus + warmup + type.
    await page.evaluate<boolean>(`(() => {
      const tb = document.querySelector('${textboxSel}');
      if (!(tb instanceof HTMLElement)) return false;
      tb.scrollIntoView({ block: 'center' });
      tb.focus();
      return true;
    })()`);
    await page.typeText(' ');
    await page.pressKey('Backspace');
    await page.typeText(text);
    await wait(400);

    const screenshotBase64 = await captureScreenshot(page);

    if (dryRun) {
      logger.info(
        { replyToUrl: normalized, chars: text.length },
        `[${LOG_TAG}] Reply dry run — composed but did not publish`,
      );
      return {
        success: true,
        message: `Dry run complete. Composed ${text.length}-char reply to ${normalized}. Call again with dry_run=false to publish.`,
        screenshotBase64,
        replyTyped: 1,
        replyPublished: 0,
        currentUrl: await page.url(),
      };
    }

    // Submit. Threads labels the composer submit "Post". The dialog
    // renders 3 overlapping DIVs with that text (wrapper / role=button
    // / label span). clickByText has ambiguously picked the wrapper or
    // label, which either missed the handler OR was interpreted as a
    // cancel by adjacent listeners — leading to the "Discard thread?"
    // confirmation overwriting the publish intent.
    //
    // Direct fix: in an evaluate(), find the node that has role="button"
    // AND textContent==="Post" AND is inside [role="dialog"], then call
    // .click() on that exact node. No text click, no keyboard fallback.
    const submitted = await page.evaluate<boolean>(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const scope = dialog || document;
      const candidates = Array.from(scope.querySelectorAll('[role="button"]'));
      for (const el of candidates) {
        if ((el.textContent || '').trim() !== 'Post') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (el.getAttribute('aria-disabled') === 'true') continue;
        if (typeof el.click === 'function') {
          el.click();
          return true;
        }
      }
      return false;
    })()`).catch(() => false);

    await wait(1500);

    // If Threads threw up a "Discard thread?" confirmation (which can
    // happen when a competing click landed on Cancel earlier), preserve
    // the draft by clicking Cancel on that dialog — NOT Discard.
    await page.evaluate(`(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      for (const d of dialogs) {
        const hasDiscardPrompt = /discard thread/i.test(d.textContent || '');
        if (!hasDiscardPrompt) continue;
        const btns = Array.from(d.querySelectorAll('[role="button"], button'));
        const cancel = btns.find((b) => (b.textContent || '').trim() === 'Cancel');
        if (cancel instanceof HTMLElement) cancel.click();
      }
      return true;
    })()`).catch(() => {});

    // Check if the composer published: textbox cleared OR composer gone.
    let composerCleared = await page.evaluate<boolean>(`(() => {
      const tb = document.querySelector('${textboxSel}');
      if (!tb) return true;
      return ((tb.textContent || '').trim().length === 0);
    })()`).catch(() => false);

    if (!composerCleared) {
      // Try one more time — sometimes Threads needs a second click.
      await wait(800);
      await page.evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const scope = dialog || document;
        const candidates = Array.from(scope.querySelectorAll('[role="button"]'));
        for (const el of candidates) {
          if ((el.textContent || '').trim() !== 'Post') continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (el.getAttribute('aria-disabled') === 'true') continue;
          el.click();
          return true;
        }
        return false;
      })()`).catch(() => {});
      await wait(2000);
      composerCleared = await page.evaluate<boolean>(`(() => {
        const tb = document.querySelector('${textboxSel}');
        if (!tb) return true;
        return ((tb.textContent || '').trim().length === 0);
      })()`).catch(() => false);
    }

    if (!composerCleared && !submitted) {
      return {
        success: false,
        message: 'Reply submit: could not find a clickable Post button inside the dialog.',
        screenshotBase64,
        replyTyped: 1,
        replyPublished: 0,
      };
    }
    await wait(1000);

    // Confirm publish. Composer-clearance alone gave false negatives
    // (observed twice — ralph42x and robin.ebers) because Threads is
    // slow to clear the textbox on network-heavy posts. Stronger
    // positive signal: our reply text appears in the rendered feed.
    // Poll up to 10s for EITHER composer-clear OR text-visible.
    const textProbe = text.trim().slice(0, 60).replace(/"/g, '\\"');
    let publishConfirmed = false;
    for (let i = 0; i < 20; i++) {
      publishConfirmed = await page.evaluate<boolean>(`(() => {
        // Signal A: composer textbox cleared.
        const tb = document.querySelector('[role="dialog"] [role="textbox"][contenteditable="true"]')
                 || document.querySelector('[role="textbox"][contenteditable="true"]');
        if (!tb || ((tb.textContent || '').trim().length === 0)) return true;
        // Signal B: our reply text is visible somewhere on the page
        // (the feed has rendered the new post). Cheaper than waiting
        // for Threads to finish the composer cleanup animation.
        const body = document.body?.innerText || '';
        if (body.includes("${textProbe}")) return true;
        return false;
      })()`).catch(() => false);
      if (publishConfirmed) break;
      await wait(500);
    }

    const stillLooksUnpublished = !publishConfirmed;

    if (stillLooksUnpublished) {
      return {
        success: false,
        message: 'Reply Post click accepted but the composer did not clear. Threads likely rejected the content.',
        screenshotBase64: await captureScreenshot(page),
        replyTyped: 1,
        replyPublished: 0,
        currentUrl: await page.url(),
      };
    }

    logger.info({ replyToUrl: normalized, chars: text.length }, `[${LOG_TAG}] reply published`);

    // Record in posted_log so future calls with the same (platform,
    // text_hash, source) skip via the dedup gate above.
    if (input.db) {
      await recordPost(input.db, input.workspaceId ?? null, {
        platform: 'threads',
        textHash,
        textPreview: text,
        textLength: text.length,
        source,
      });
    }

    return {
      success: true,
      message: `Reply published to ${normalized} (${text.length} chars).`,
      screenshotBase64: await captureScreenshot(page),
      replyTyped: 1,
      replyPublished: 1,
      currentUrl: await page.url(),
    };
  } finally {
    if (created) await page.closeAndCleanup(); else page.close();
  }
}

/**
 * Click the Reply trigger that opens the composer on a Threads post
 * detail page.
 *
 * Strategy, in priority order:
 *   1. Visible element whose textContent is exactly "Reply". Threads
 *      renders this as a DIV wrapper with role=button styling, sitting
 *      under the post (not in the fold). Picks the one closest to the
 *      top of the page (= for the target post, not a nested reply).
 *   2. Fallback: svg[aria-label="Reply"] inside an article[data-*], walk
 *      up to the clickable ancestor. Most svgs are hidden decorations on
 *      the current layout but left as a safety net for older renders.
 */
async function clickReplyIcon(page: RawCdpPage): Promise<boolean> {
  try {
    // Find + click in a SINGLE evaluate(). We use element.click() (synthetic
    // MouseEvent dispatch on the exact node) rather than CDP coordinate
    // clicks, because Threads overlays an invisible hit-target layer above
    // the action bar that intercepts coordinate-based clicks without
    // forwarding them to React's handler. Synthetic .click() bypasses the
    // overlay entirely and fires the handler on the real target element.
    // Empirically confirmed 2026-04-17: CDP clickSelector → no composer;
    // .click() via evaluate → composer mounts within 500ms.
    const clicked = await page.evaluate<boolean>(`(() => {
      // Strategy 1: visible "Reply" text button, preferring role="button".
      // Threads renders the Reply trigger as 3 stacked DIVs (wrapper /
      // role=button / label) sharing the same rect. Only the role="button"
      // node has React's click handler bound.
      const all = Array.from(document.querySelectorAll('[role="button"], button, a, div'));
      const visibleReply = all
        .filter((e) => (e.textContent || '').trim() === 'Reply')
        .filter((e) => !!e.offsetParent)
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
      const groups = new Map();
      for (const el of visibleReply) {
        const r = el.getBoundingClientRect();
        const key = Math.round(r.top) + ':' + Math.round(r.left) + ':' + Math.round(r.width);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(el);
      }
      // Sort groups top → bottom so the target post's action bar wins.
      const sortedGroups = Array.from(groups.values()).sort((a, b) =>
        a[0].getBoundingClientRect().top - b[0].getBoundingClientRect().top
      );
      for (const group of sortedGroups) {
        const target = group.find((e) => e.getAttribute('role') === 'button') || group[0];
        target.scrollIntoView({ block: 'center' });
        if (typeof target.click === 'function') {
          target.click();
          return true;
        }
      }
      // Strategy 2 fallback: svg[aria-label="Reply"] → walk up to clickable.
      const svgs = Array.from(document.querySelectorAll('svg[aria-label="Reply"]'));
      for (const svg of svgs) {
        let el = svg;
        for (let i = 0; i < 6; i++) {
          el = el.parentElement;
          if (!el) break;
          const role = el.getAttribute('role');
          if (el.tagName === 'BUTTON' || el.tagName === 'A' || role === 'button' || role === 'link') {
            el.scrollIntoView({ block: 'center' });
            if (typeof el.click === 'function') { el.click(); return true; }
          }
        }
      }
      return false;
    })()`);
    return clicked;
  } catch {
    return false;
  }
}
