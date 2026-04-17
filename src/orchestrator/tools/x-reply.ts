/**
 * x-reply.ts — scan X feeds for posts + reply to a specific post.
 *
 * Two deterministic tools the agent (or any caller) can compose:
 *
 *   scanXPostsViaBrowser({ source, limit })
 *     Navigate a feed / profile / search / mentions / direct URL,
 *     parse the rendered tweets, return a structured list the caller
 *     can filter on.
 *
 *   composeTweetReplyViaBrowser({ replyToUrl, text, dryRun })
 *     Navigate to a specific tweet, open its reply composer, type
 *     text, and submit (or skip the submit in dry-run).
 *
 * Built on top of x-posting's getCdpPage + focusByTestid + identity
 * helpers so profile pinning and handle verification match the
 * compose path exactly. DOM access uses data-testid wherever
 * possible — X's class names churn, testids are the stable surface.
 *
 * Source string grammar (deliberately simple):
 *   home               → https://x.com/home
 *   following          → https://x.com/home (caller clicks the tab inside if needed)
 *   mentions           → https://x.com/notifications/mentions
 *   user:@handle       → https://x.com/<handle>
 *   user:handle        → https://x.com/<handle> (@ is optional)
 *   search:<query>     → https://x.com/search?q=<query>&f=live
 *   search:<q>:<tab>   → …&f=<tab>  (tab ∈ top|live|people|media|lists)
 *   url:<exact>        → <exact>
 *
 * Filter predicates run in Node after the scrape, so the caller stays
 * in control. For a "scan → pick by criteria → reply" pipeline:
 *
 *   const { tweets } = await scanXPostsViaBrowser({ source: 'user:@foo', limit: 20 });
 *   const pick = tweets.find(t => !t.isReply && t.likes < 20);
 *   if (pick) await composeTweetReplyViaBrowser({ replyToUrl: pick.url, text, dryRun: true });
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { logger } from '../../lib/logger.js';
import {
  getCdpPage,
  focusByTestid,
  captureScreenshot,
  clickByText,
  isLoginRedirect,
  wait,
  type CdpPage,
  MAX_TWEET_LENGTH,
  X_HYDRATION_WAIT_MS,
} from './x-posting.js';

// ---------------------------------------------------------------------------
// Tool schema definitions
// ---------------------------------------------------------------------------

export const X_REPLY_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'x_scan_posts',
    description:
      'Scan a feed / profile / search / mentions on x.com and return a structured list of posts the caller can filter and pick from. No writes. Source formats: "home" | "following" | "mentions" | "user:@handle" | "search:<query>[:top|live|people|media|lists]" | "url:<direct>". Use this before x_compose_reply to pick which post to reply to.',
    input_schema: {
      type: 'object' as const,
      properties: {
        source: {
          type: 'string',
          description:
            'Where to scan. "home" (For You timeline), "following", "mentions", "user:@handle", "search:<query>" (defaults to live tab), "search:<query>:top|live|people|media|lists", or "url:<exact-x.com-url>".',
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
          description: 'Chrome profile to use. Same rules as x_compose_tweet.',
        },
      },
      required: ['source'],
    },
  },
  {
    name: 'x_compose_reply',
    description:
      'Reply to a specific tweet on x.com by driving the user\'s real logged-in Chrome. Navigates to the tweet, clicks Reply, types the text, and optionally publishes. DEFAULTS TO DRY RUN. Pair with x_scan_posts to pick a target.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reply_to_url: {
          type: 'string',
          description:
            'URL of the tweet to reply to. Full URL (https://x.com/<user>/status/<id>), twitter.com URL, "user/status/id" short form, or bare numeric id.',
        },
        text: {
          type: 'string',
          description: 'Reply text, verbatim, ≤280 characters.',
        },
        dry_run: {
          type: 'boolean',
          description:
            'When true (default), composes the reply but does NOT click the Reply button. Set to false to actually publish.',
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

export interface ScanXInput {
  /** Source URI (see top-of-file grammar). */
  source: string;
  /** Max tweets to return after scrolling + parsing. Default 20. Cap 100. */
  limit?: number;
  /** Context pin from the executor. */
  expectedBrowserContextId?: string;
  /** How far to scroll (in page heights) to force more hydration. Default 3. */
  scrollRounds?: number;
}

export interface ScannedTweet {
  /** Numeric tweet id (last path segment of /status/<id>). */
  id: string;
  /** Canonical URL (https://x.com/<author>/status/<id>). */
  url: string;
  /** Author handle without @. */
  authorHandle: string;
  /** Author display name. */
  authorName: string;
  /** Tweet text — null if not renderable (images-only, spaces, etc.). */
  text: string | null;
  /** Reply count. 0 when X renders the empty state; null if not visible. */
  replies: number | null;
  /** Repost (retweet) count. */
  reposts: number | null;
  /** Like count. */
  likes: number | null;
  /** View count. X renders this as a separate testid. */
  views: number | null;
  /** ISO timestamp from the <time datetime="..."> element, or null. */
  postedAt: string | null;
  /** True when this row is a reply (has the "Replying to @x" line). */
  isReply: boolean;
  /** True when this row is a repost banner from the feed ("X reposted"). */
  isRepost: boolean;
}

export interface ScanXResult {
  success: boolean;
  message: string;
  source: string;
  resolvedUrl: string;
  tweets: ScannedTweet[];
  currentUrl?: string;
  screenshotBase64?: string;
}

export interface ReplyXInput {
  /** URL of the tweet to reply to — any format X accepts (/status/<id>). */
  replyToUrl: string;
  /** Reply text. Subject to MAX_TWEET_LENGTH. */
  text: string;
  /** When true (default), compose but do NOT click the Reply button. */
  dryRun?: boolean;
  /** Handle verification — bail if sidebar disagrees. */
  expectedHandle?: string;
  /** Context pin from the executor. */
  expectedBrowserContextId?: string;
}

export interface ReplyXResult {
  success: boolean;
  message: string;
  screenshotBase64?: string;
  currentUrl?: string;
  /** 1 when we typed text into the composer, 0 otherwise. */
  replyTyped?: number;
  /** 1 when the reply was actually published, 0 on dry-run or failure. */
  replyPublished?: number;
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

const SEARCH_TABS = new Set(['top', 'live', 'people', 'media', 'lists']);

export function resolveXSourceUrl(source: string): string {
  const s = source.trim();
  if (s === 'home' || s === 'following') return 'https://x.com/home';
  if (s === 'mentions') return 'https://x.com/notifications/mentions';
  if (s.startsWith('user:')) {
    const handle = s.slice(5).replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!handle) throw new Error(`scanXPosts: empty user handle in "${source}"`);
    return `https://x.com/${handle}`;
  }
  if (s.startsWith('search:')) {
    const rest = s.slice(7);
    const colonIdx = rest.lastIndexOf(':');
    let query = rest;
    let tab = 'live';
    if (colonIdx >= 0) {
      const maybeTab = rest.slice(colonIdx + 1);
      if (SEARCH_TABS.has(maybeTab)) {
        query = rest.slice(0, colonIdx);
        tab = maybeTab;
      }
    }
    if (!query.trim()) throw new Error(`scanXPosts: empty search query in "${source}"`);
    return `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=${tab}`;
  }
  if (s.startsWith('url:')) return s.slice(4).trim();
  throw new Error(
    `scanXPosts: unknown source "${source}". Supported: home | following | mentions | user:@handle | search:<query>[:top|live|people|media|lists] | url:<direct>`,
  );
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export async function scanXPostsViaBrowser(input: ScanXInput): Promise<ScanXResult> {
  const source = input.source?.trim() ?? '';
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const scrollRounds = Math.max(0, Math.min(input.scrollRounds ?? 3, 10));

  let resolvedUrl: string;
  try {
    resolvedUrl = resolveXSourceUrl(source);
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
      source,
      resolvedUrl: '',
      tweets: [],
    };
  }

  const page = await getCdpPage('x.com', input.expectedBrowserContextId);
  if (!page) {
    return {
      success: false,
      message: 'Could not attach to Chrome CDP at :9222 — no x.com tab open in any profile window, or debug Chrome is down.',
      source,
      resolvedUrl,
      tweets: [],
    };
  }

  try {
    await page.goto(resolvedUrl);
    await wait(X_HYDRATION_WAIT_MS);
    const currentUrl = await page.url();
    if (isLoginRedirect(currentUrl)) {
      return {
        success: false,
        message: `X redirected to login (${currentUrl}).`,
        source,
        resolvedUrl,
        tweets: [],
        currentUrl,
      };
    }

    // Scroll to force hydration of more tweets. X lazy-loads aggressively.
    for (let i = 0; i < scrollRounds; i++) {
      await page.evaluate(`window.scrollBy(0, Math.round(window.innerHeight * 0.9))`);
      await wait(700);
    }
    // Scroll back to top so subsequent reply flows start clean.
    await page.evaluate(`window.scrollTo(0, 0)`);
    await wait(250);

    const parsed = (await page.evaluate<ScannedTweet[]>(`(() => {
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
      function testidCount(article, testid) {
        const el = article.querySelector('[data-testid="' + testid + '"]');
        if (!el) return null;
        // X renders the number as aria-label "N replies/reposts/likes" or visible text.
        const aria = el.getAttribute('aria-label') || '';
        const mAria = aria.match(/([\\d,.KMB]+)/i);
        if (mAria) return parseCount(mAria[1]);
        const txt = (el.textContent || '').trim();
        return parseCount(txt);
      }
      const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
      const out = [];
      for (const a of articles) {
        try {
          // Tweet URL lives on the <time>'s parent link.
          const timeEl = a.querySelector('time');
          const postedAt = timeEl ? timeEl.getAttribute('datetime') : null;
          let url = null, id = null, authorHandle = null;
          const statusLink = a.querySelector('a[href*="/status/"]');
          if (statusLink) {
            const href = statusLink.getAttribute('href') || '';
            const m = href.match(/^\\/(\\w+)\\/status\\/(\\d+)/);
            if (m) {
              authorHandle = m[1];
              id = m[2];
              url = 'https://x.com/' + authorHandle + '/status/' + id;
            }
          }
          if (!url || !id) continue;
          // Author display name.
          const userNameEl = a.querySelector('[data-testid="User-Name"]');
          let authorName = '';
          if (userNameEl) {
            const firstSpan = userNameEl.querySelector('span');
            authorName = (firstSpan && firstSpan.textContent || '').trim();
          }
          // Body text (may be absent on image-only posts).
          const textEl = a.querySelector('[data-testid="tweetText"]');
          const text = textEl ? (textEl.textContent || '').trim() : null;
          // Reply / repost / like / view counts.
          const replies = testidCount(a, 'reply');
          const reposts = testidCount(a, 'retweet');
          const likes = testidCount(a, 'like');
          // Views sit under analytics link.
          let views = null;
          const analytics = a.querySelector('a[href*="/analytics"]');
          if (analytics) {
            const v = (analytics.getAttribute('aria-label') || '').match(/([\\d,.KMB]+)/i);
            views = v ? parseCount(v[1]) : null;
          }
          // isReply: "Replying to" header inside the article.
          const replyBadge = a.textContent && a.textContent.includes('Replying to');
          // isRepost: "reposted" social context at top of article.
          const socialContext = a.querySelector('[data-testid="socialContext"]');
          const isRepost = !!(socialContext && /reposted/i.test(socialContext.textContent || ''));
          out.push({
            id, url, authorHandle: authorHandle || '', authorName, text,
            replies, reposts, likes, views, postedAt,
            isReply: !!replyBadge, isRepost,
          });
        } catch (e) { /* skip broken article */ }
      }
      return out;
    })()`)) ?? [];

    // Dedupe by id (X sometimes renders the same tweet twice in the virtual scroller).
    const seen = new Set<string>();
    const unique: ScannedTweet[] = [];
    for (const t of parsed) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      unique.push(t);
      if (unique.length >= limit) break;
    }

    return {
      success: true,
      message: `scanned ${unique.length} tweet(s) from ${resolvedUrl}`,
      source,
      resolvedUrl,
      tweets: unique,
      currentUrl: await page.url(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, source, resolvedUrl }, '[x-reply] scan failed');
    return {
      success: false,
      message: `scan failed: ${msg}`,
      source,
      resolvedUrl,
      tweets: [],
      screenshotBase64: await captureScreenshot(page),
      currentUrl: await page.url().catch(() => undefined),
    };
  } finally {
    page.close();
  }
}

// ---------------------------------------------------------------------------
// Reply
// ---------------------------------------------------------------------------

function normalizeTweetUrl(raw: string): string | null {
  const s = raw.trim();
  // Accept /i/status/, /user/status/, twitter.com/…, full URLs, or bare id.
  const mFull = s.match(/https?:\/\/(?:mobile\.|www\.)?(?:x|twitter)\.com\/(\w+)\/status\/(\d+)/i);
  if (mFull) return `https://x.com/${mFull[1]}/status/${mFull[2]}`;
  const mBare = s.match(/^(\w+)\/status\/(\d+)/);
  if (mBare) return `https://x.com/${mBare[1]}/status/${mBare[2]}`;
  const mIdOnly = s.match(/^\d{8,}$/);
  if (mIdOnly) return `https://x.com/i/status/${s}`;
  return null;
}

export async function composeTweetReplyViaBrowser(input: ReplyXInput): Promise<ReplyXResult> {
  const text = (input.text || '').trim();
  const dryRun = input.dryRun !== false;

  if (!text) return { success: false, message: 'text is required' };
  if (text.length > MAX_TWEET_LENGTH) {
    return {
      success: false,
      message: `Reply is ${text.length} chars, X limit is ${MAX_TWEET_LENGTH}. Trim it.`,
    };
  }
  const normalized = normalizeTweetUrl(input.replyToUrl);
  if (!normalized) {
    return {
      success: false,
      message: `replyToUrl "${input.replyToUrl}" is not a recognizable X status URL.`,
    };
  }

  const page = await getCdpPage('x.com', input.expectedBrowserContextId);
  if (!page) {
    return {
      success: false,
      message: 'Could not attach to Chrome CDP at :9222 — no x.com tab open in any profile window, or debug Chrome is down.',
    };
  }

  try {
    await page.goto(normalized);
    await wait(X_HYDRATION_WAIT_MS);
    const currentUrl = await page.url();
    if (isLoginRedirect(currentUrl)) {
      return { success: false, message: `X redirected to login (${currentUrl}).`, currentUrl };
    }

    // Click the reply button on the primary tweet. The detail page shows
    // the target tweet's action bar with a data-testid="reply" button.
    const replyOpen = await clickReplyButton(page);
    if (!replyOpen) {
      return {
        success: false,
        message: 'Could not find or click the Reply button on the tweet detail page.',
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }
    await wait(900);

    // Reply composer is same textarea as compose.
    const focused = await focusByTestid(page, 'tweetTextarea_0');
    if (!focused) {
      return {
        success: false,
        message: 'Could not focus reply textarea (tweetTextarea_0) after clicking Reply.',
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }

    // Warm the input so React's first keystroke isn't swallowed.
    await page.typeText(' ');
    await page.pressKey('Backspace');
    await page.typeText(text);
    await wait(400);

    const screenshotBase64 = await captureScreenshot(page);

    if (dryRun) {
      logger.info(
        { replyToUrl: normalized, chars: text.length },
        '[x-reply] Reply dry run — composed but did not publish',
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

    // In the reply modal, the submit button's testid is still "tweetButton".
    // X labels it "Reply" but the testid is stable.
    const clicked = await page.clickSelector('[data-testid="tweetButton"]', 10000);
    if (!clicked) {
      // Fall back to clicking by the visible text "Reply".
      const fallback = await clickByText(page, 'Reply');
      if (!fallback) {
        return {
          success: false,
          message: 'Reply submit button never became clickable within 10s.',
          screenshotBase64,
          replyTyped: 1,
          replyPublished: 0,
        };
      }
    }
    await wait(2500);

    // Confirm the composer actually closed — if tweetTextarea_0 is still
    // visible we probably didn't publish (rate limit, policy, etc.).
    const stillOpen = await page.evaluate<boolean>(
      `!!document.querySelector('[data-testid="tweetTextarea_0"]')`,
    ).catch(() => false);

    if (stillOpen) {
      return {
        success: false,
        message: 'Reply button clicked but the composer stayed open. X likely rejected the content.',
        screenshotBase64: await captureScreenshot(page),
        replyTyped: 1,
        replyPublished: 0,
        currentUrl: await page.url(),
      };
    }

    logger.info({ replyToUrl: normalized, chars: text.length }, '[x-reply] reply published');
    return {
      success: true,
      message: `Reply published to ${normalized} (${text.length} chars).`,
      screenshotBase64: await captureScreenshot(page),
      replyTyped: 1,
      replyPublished: 1,
      currentUrl: await page.url(),
    };
  } finally {
    page.close();
  }
}

/**
 * Click the primary tweet's Reply button on the status page. X renders
 * the tweet detail as a stack of tweets (context + target + thread), and
 * the target's action bar is the first `[data-testid="reply"]` in DOM order
 * that sits inside an `article[data-testid="tweet"]` that ALSO contains
 * the `socialContext` marker-less main tweet. In practice picking the
 * first reply button on /status/<id> lands on the right action bar
 * because X renders the target tweet first in the detail stack.
 */
async function clickReplyButton(page: CdpPage): Promise<boolean> {
  try {
    const tagged = await page.evaluate<boolean>(`(() => {
      const btn = document.querySelector('article[data-testid="tweet"] [data-testid="reply"]');
      if (!(btn instanceof HTMLElement)) return false;
      btn.setAttribute('data-x-reply-target', '1');
      btn.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    if (!tagged) return false;
    const clicked = await page.clickSelector('[data-x-reply-target="1"]', 5000);
    await page.evaluate(`(() => {
      const el = document.querySelector('[data-x-reply-target="1"]');
      if (el) el.removeAttribute('data-x-reply-target');
      return true;
    })()`).catch(() => {});
    return clicked;
  } catch {
    return false;
  }
}
