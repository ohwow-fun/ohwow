/**
 * threads-delete.ts — delete one of my own replies under a Threads post.
 *
 * Safety rails:
 *   - Refuses to touch anything not authored by `authorHandle`. The
 *     handle is required, not optional. We scan for reply blocks whose
 *     author-link href is `/@<handle>` and ignore everything else.
 *   - If multiple matches and no `containsText` filter is supplied,
 *     returns ambiguous — caller must narrow.
 *   - Default dry_run=true. No destructive click without explicit opt-in.
 *
 * DOM lessons from threads-reply (applied here):
 *   - Use element.click() via evaluate. CDP coordinate clicks are eaten
 *     by invisible hit-target overlays on Threads.
 *   - After the overflow menu opens, the Delete item is a role="menuitem"
 *     with textContent "Delete" (or "Borrar" in localized renders — we
 *     only match English for now).
 *   - Confirmation dialog: "Delete post?" with a Delete button. Use
 *     element.click() on the red Delete button.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { logger } from '../../lib/logger.js';
import type { RawCdpPage } from '../../execution/browser/raw-cdp.js';
import {
  getCdpPageForPlatform,
  captureScreenshot,
  wait,
  HYDRATION_WAIT_MS,
  type CdpPageHandle,
} from './social-cdp-helpers.js';

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

export const THREADS_DELETE_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'threads_delete_reply',
    description:
      'Delete one of your own replies under a Threads post. Safety: requires author_handle; will refuse to delete anyone else\'s content. If multiple replies from the handle exist under the post and no contains_text filter is given, returns ambiguous. DEFAULTS TO DRY RUN — set dry_run=false to actually delete.',
    input_schema: {
      type: 'object' as const,
      properties: {
        post_url: {
          type: 'string',
          description: 'URL of the parent Threads post whose replies we\'ll scan. e.g. https://www.threads.com/@user/post/XXX',
        },
        author_handle: {
          type: 'string',
          description: 'Required. Only replies authored by this handle are eligible for deletion. Prevents accidental deletes of other people\'s content.',
        },
        contains_text: {
          type: 'string',
          description: 'Optional substring filter. When multiple replies from author_handle exist, use this to pick one (case-insensitive substring match against reply text).',
        },
        index: {
          type: 'number',
          description: 'Optional 0-based index when multiple identical replies exist (duplicates). 0 = oldest visible, N-1 = newest.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true (default), finds the reply and screenshots but does NOT click Delete. Set to false to actually delete.',
        },
        profile: {
          type: 'string',
          description: 'Chrome profile to use.',
        },
      },
      required: ['post_url', 'author_handle'],
    },
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeleteThreadsReplyInput {
  postUrl: string;
  authorHandle: string;
  containsText?: string;
  /** When multiple replies match and contains_text can't disambiguate (e.g. identical duplicates), pick by index. 0 = oldest visible, N-1 = newest. */
  index?: number;
  dryRun?: boolean;
  expectedBrowserContextId?: string;
}

export interface DeleteThreadsReplyOutput {
  success: boolean;
  message: string;
  matchedCount?: number;
  deletedCount?: number;
  matchedPreview?: string;
  screenshotBase64?: string;
  currentUrl?: string;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const THREADS_HOME = 'https://www.threads.com/';
const LOG_TAG = 'threads-delete';

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
// Main
// ---------------------------------------------------------------------------

export async function deleteThreadsReplyViaBrowser(
  input: DeleteThreadsReplyInput,
): Promise<DeleteThreadsReplyOutput> {
  const handle = input.authorHandle.replace(/^@/, '').toLowerCase();
  if (!handle) return { success: false, message: 'author_handle is required' };
  const dryRun = input.dryRun !== false;
  const containsText = input.containsText?.toLowerCase() ?? null;

  const cdpHandle = await getThreadsCdpPage(input.expectedBrowserContextId);
  if (!cdpHandle) {
    return { success: false, message: 'Could not attach to Chrome CDP at :9222 — no threads.com tab open, or debug Chrome is down.' };
  }
  const { page, created } = cdpHandle;

  try {
    await page.goto(input.postUrl);
    await wait(HYDRATION_WAIT_MS);
    const currentUrl = await page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/accounts/login')) {
      return { success: false, message: `Threads redirected to login (${currentUrl}).`, currentUrl };
    }

    // Scroll to load all replies in the thread.
    for (let i = 0; i < 3; i++) {
      await page.evaluate(`window.scrollBy(0, Math.round(window.innerHeight * 0.9))`);
      await wait(500);
    }
    await page.evaluate('window.scrollTo(0, 0)');
    await wait(300);

    // Find reply blocks by handle. For each link to /@<handle>, climb to
    // the containing reply card and tag it for later overflow-menu click.
    const scanResult = await page.evaluate<{
      matches: Array<{ previewText: string; idx: number }>;
      handleNormalized: string;
    }>(`(() => {
      const want = ${JSON.stringify(handle)};
      // All anchors to /@want. Each reply card has one such anchor per author tag.
      const links = Array.from(document.querySelectorAll('a[href^="/@"]'));
      const mine = links.filter((a) => {
        const href = (a.getAttribute('href') || '').toLowerCase();
        return href === '/@' + want || href.startsWith('/@' + want + '/') || href.startsWith('/@' + want + '?');
      });
      function climbToPost(link) {
        // Walk up, but only accept a card whose FIRST /@handle link
        // matches 'want'. Otherwise we collect false positives from
        // ancestor cards (e.g. parent post cards whose DOM nests our
        // reply inside them, surfacing our handle link deep in their
        // subtree without them being authored by us).
        let el = link;
        for (let i = 0; i < 14; i++) {
          if (!el.parentElement) break;
          el = el.parentElement;
          const hasTime = el.querySelector('time');
          const hasReplyBtn = Array.from(el.querySelectorAll('div, [role="button"]')).some(
            (b) => (b.textContent || '').trim() === 'Reply',
          );
          const txtLen = (el.innerText || '').length;
          if (!hasTime || !hasReplyBtn || txtLen < 20 || txtLen > 2500) continue;
          const firstAuthor = el.querySelector('a[href^="/@"]');
          if (!firstAuthor) continue;
          const authorHref = (firstAuthor.getAttribute('href') || '').toLowerCase();
          const primary = authorHref === '/@' + want
            || authorHref.startsWith('/@' + want + '/')
            || authorHref.startsWith('/@' + want + '?');
          if (!primary) {
            // Found a valid card but it belongs to someone else — the
            // link we started from is nested. Keep climbing to skip
            // parent cards; our own card must be at an inner level.
            continue;
          }
          return el;
        }
        return null;
      }
      const cards = new Map();
      for (const link of mine) {
        const card = climbToPost(link);
        if (!card) continue;
        // Dedup by card reference (multiple author links per card).
        if (cards.has(card)) continue;
        cards.set(card, true);
      }
      const all = Array.from(cards.keys());
      // Tag each with an index attribute for later targeting.
      let idx = 0;
      const matches = [];
      for (const card of all) {
        card.setAttribute('data-threads-own-reply', String(idx));
        const text = (card.innerText || '').trim();
        matches.push({ previewText: text.slice(0, 180), idx });
        idx++;
      }
      return { matches, handleNormalized: want };
    })()`);

    if (scanResult.matches.length === 0) {
      return {
        success: false,
        message: `No reply from @${handle} found under ${input.postUrl}. The reply may not have loaded, or the handle is wrong.`,
        matchedCount: 0,
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }

    // Narrow by containsText if provided.
    let candidates = scanResult.matches;
    if (containsText) {
      candidates = candidates.filter((m) => m.previewText.toLowerCase().includes(containsText));
      if (candidates.length === 0) {
        return {
          success: false,
          message: `${scanResult.matches.length} reply(ies) from @${handle} found, but none contain "${containsText}".`,
          matchedCount: 0,
          screenshotBase64: await captureScreenshot(page),
          currentUrl: await page.url(),
        };
      }
    }
    if (candidates.length > 1) {
      if (typeof input.index === 'number' && input.index >= 0 && input.index < candidates.length) {
        candidates = [candidates[input.index]];
      } else {
        const snippets = candidates.map((c, i) => `  position=${i} idx=${c.idx}: ${c.previewText.slice(0, 80)}`).join('\n');
        return {
          success: false,
          message: `${candidates.length} replies from @${handle} match. Narrow with contains_text OR pass index=N (0-based) to pick one. Candidates:\n${snippets}`,
          matchedCount: candidates.length,
          screenshotBase64: await captureScreenshot(page),
          currentUrl: await page.url(),
        };
      }
    }

    const target = candidates[0];

    if (dryRun) {
      logger.info({ postUrl: input.postUrl, handle, idx: target.idx }, `[${LOG_TAG}] dry run — would delete`);
      return {
        success: true,
        message: `Dry run: would delete 1 reply from @${handle} (preview: "${target.previewText.slice(0, 100)}"). Call again with dry_run=false to actually delete.`,
        matchedCount: 1,
        deletedCount: 0,
        matchedPreview: target.previewText,
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }

    // Open the overflow menu inside the target card.
    const menuOpened = await page.evaluate<boolean>(`(() => {
      const card = document.querySelector('[data-threads-own-reply="${target.idx}"]');
      if (!card) return false;
      card.scrollIntoView({ block: 'center' });
      // Try svg[aria-label="More"] first.
      const svg = card.querySelector('svg[aria-label="More"]');
      if (svg) {
        let el = svg;
        for (let i = 0; i < 6; i++) {
          el = el.parentElement;
          if (!el) break;
          const role = el.getAttribute('role');
          if (el.tagName === 'BUTTON' || el.tagName === 'A' || role === 'button') {
            if (typeof el.click === 'function') { el.click(); return true; }
          }
        }
      }
      // Fallback: a role=button whose textContent is empty or just "⋯" near the
      // card's top-right corner. Skip for now if svg wasn't found — safer to fail.
      return false;
    })()`);

    if (!menuOpened) {
      return {
        success: false,
        message: 'Could not open overflow (More) menu on the target reply.',
        matchedCount: 1,
        deletedCount: 0,
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }
    await wait(700);

    // Click "Delete" in the dropdown. The dropdown is rendered outside the
    // card as a role=menu / role=dialog floating panel — don't scope to card.
    const deleteClicked = await page.evaluate<boolean>(`(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="button"], button, div'));
      const match = items
        .filter((e) => (e.textContent || '').trim() === 'Delete')
        .filter((e) => !!e.offsetParent);
      if (match.length === 0) return false;
      // Prefer role=menuitem if present
      const target = match.find((e) => e.getAttribute('role') === 'menuitem') || match[0];
      if (typeof target.click === 'function') { target.click(); return true; }
      return false;
    })()`);

    if (!deleteClicked) {
      return {
        success: false,
        message: 'Overflow menu opened but no "Delete" item found.',
        matchedCount: 1,
        deletedCount: 0,
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }
    await wait(700);

    // Confirm delete. Threads shows a "Delete post?" modal with Cancel/Delete.
    const confirmClicked = await page.evaluate<boolean>(`(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
      for (const d of dialogs) {
        const txt = (d.textContent || '').toLowerCase();
        if (!/delete\\s+post|delete\\s+this\\s+post|are you sure/.test(txt)) continue;
        const btns = Array.from(d.querySelectorAll('[role="button"], button'));
        // Find the red Delete button (not Cancel).
        const del = btns.find((b) => (b.textContent || '').trim() === 'Delete');
        if (del instanceof HTMLElement && typeof del.click === 'function') {
          del.click();
          return true;
        }
      }
      return false;
    })()`);

    if (!confirmClicked) {
      return {
        success: false,
        message: 'Delete click accepted but the confirmation dialog did not appear or had no Delete button.',
        matchedCount: 1,
        deletedCount: 0,
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }
    await wait(2000);

    // Verify: the data-threads-own-reply attribute should be gone if card
    // was removed from DOM. (If Threads only hides it visually, we'd still
    // count as success — but empirically the card unmounts.)
    const stillThere = await page.evaluate<boolean>(
      `!!document.querySelector('[data-threads-own-reply="${target.idx}"]')`,
    ).catch(() => true);

    logger.info({ postUrl: input.postUrl, handle, stillThere }, `[${LOG_TAG}] delete attempt completed`);

    return {
      success: !stillThere,
      message: stillThere
        ? 'Delete confirmation clicked but the reply card is still in the DOM. Threads may have rejected the delete.'
        : `Reply from @${handle} deleted.`,
      matchedCount: 1,
      deletedCount: stillThere ? 0 : 1,
      matchedPreview: target.previewText,
      screenshotBase64: await captureScreenshot(page),
      currentUrl: await page.url(),
    };
  } finally {
    if (created) await page.closeAndCleanup(); else page.close();
  }
}
