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
import {
  getCdpPageForPlatform,
  captureScreenshot,
  clickByText,
  clearTextbox,
  wait,
  HYDRATION_WAIT_MS,
  type CdpPageHandle,
} from './social-cdp-helpers.js';

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
    return `${THREADS_HOME}search?q=${encodeURIComponent(query)}`;
  }
  if (s.startsWith('url:')) return s.slice(4).trim();
  throw new Error(
    `scanThreadsPosts: unknown source "${source}". Supported: home | following | user:@handle | search:<query> | url:<direct>`,
  );
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

    // Click the reply button on the target post. Threads renders an
    // SVG with aria-label="Reply" inside the primary post's action bar.
    // Walk up to the clickable ancestor and click it.
    const opened = await clickReplyIcon(page);
    if (!opened) {
      return {
        success: false,
        message: 'Could not find or click Threads Reply icon on the post detail page.',
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }

    // Dialog should appear. Textbox is [role="textbox"][contenteditable="true"].
    const dialogReady = await page.waitForSelector(
      '[role="dialog"] [role="textbox"][contenteditable="true"]',
      5000,
    );
    if (!dialogReady) {
      return {
        success: false,
        message: 'Threads reply dialog did not appear within 5s after clicking Reply.',
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }

    // Clear any residual / draft text.
    await clearTextbox(page, '[role="dialog"] [role="textbox"][contenteditable="true"]');
    await wait(200);

    // Focus + warmup + type.
    await page.evaluate<boolean>(`(() => {
      const tb = document.querySelector('[role="dialog"] [role="textbox"][contenteditable="true"]');
      if (!(tb instanceof HTMLElement)) return false;
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

    // Submit — Threads labels the button "Post" inside the reply dialog too.
    const clicked = await clickByText(page, 'Post');
    if (!clicked) {
      return {
        success: false,
        message: 'Reply submit button ("Post") was not clickable.',
        screenshotBase64,
        replyTyped: 1,
        replyPublished: 0,
      };
    }
    await wait(2500);

    // Confirm dialog closed.
    const stillOpen = await page.evaluate<boolean>(
      `!!document.querySelector('[role="dialog"] [role="textbox"][contenteditable="true"]')`,
    ).catch(() => false);

    if (stillOpen) {
      return {
        success: false,
        message: 'Reply Post click accepted but the dialog stayed open. Threads likely rejected the content.',
        screenshotBase64: await captureScreenshot(page),
        replyTyped: 1,
        replyPublished: 0,
        currentUrl: await page.url(),
      };
    }

    logger.info({ replyToUrl: normalized, chars: text.length }, `[${LOG_TAG}] reply published`);
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
 * Click the primary post's Reply icon. Threads renders it as
 * svg[aria-label="Reply"] inside the action bar. Walk up to the
 * clickable ancestor (a or button or role=button).
 */
async function clickReplyIcon(page: RawCdpPage): Promise<boolean> {
  try {
    const tagged = await page.evaluate<boolean>(`(() => {
      const svgs = Array.from(document.querySelectorAll('svg[aria-label="Reply"]'));
      // Prefer the first one inside an article-like container at the
      // top of the page (the target post's action bar).
      for (const svg of svgs) {
        let el = svg;
        for (let i = 0; i < 6; i++) {
          el = el.parentElement;
          if (!el) break;
          const role = el.getAttribute('role');
          if (el.tagName === 'BUTTON' || el.tagName === 'A' || role === 'button' || role === 'link') {
            el.setAttribute('data-threads-reply-target', '1');
            el.scrollIntoView({ block: 'center' });
            return true;
          }
        }
      }
      return false;
    })()`);
    if (!tagged) return false;
    const clicked = await page.clickSelector('[data-threads-reply-target="1"]', 5000);
    await page.evaluate(`(() => {
      const el = document.querySelector('[data-threads-reply-target="1"]');
      if (el) el.removeAttribute('data-threads-reply-target');
      return true;
    })()`).catch(() => {});
    return clicked;
  } catch {
    return false;
  }
}
