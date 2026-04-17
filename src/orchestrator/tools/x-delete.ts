/**
 * x-delete.ts — delete one of my own replies under an X tweet.
 *
 * Same safety model as threads-delete: requires authorHandle, refuses
 * ambiguous matches without contains_text, defaults to dry_run=true.
 *
 * X DOM is easier than Threads because everything has data-testid:
 *   - Each tweet / reply: article[data-testid="tweet"]
 *   - Author handle:      [data-testid="User-Name"] contains an @handle link
 *   - Overflow trigger:   [data-testid="caret"]
 *   - Delete menu item:   role="menuitem" with text "Delete"
 *   - Confirm delete:     role="dialog" with [data-testid="confirmationSheetConfirm"]
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { logger } from '../../lib/logger.js';
import {
  getCdpPage,
  captureScreenshot,
  isLoginRedirect,
  wait,
  type CdpPage,
  X_HYDRATION_WAIT_MS,
} from './x-posting.js';

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

export const X_DELETE_REPLY_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'x_delete_reply',
    description:
      'Delete one of your own replies under an X tweet. Safety: requires author_handle; will refuse to delete anyone else\'s content. If multiple replies from the handle exist under the tweet and no contains_text filter is given, returns ambiguous. DEFAULTS TO DRY RUN — set dry_run=false to actually delete.',
    input_schema: {
      type: 'object' as const,
      properties: {
        post_url: {
          type: 'string',
          description: 'URL of the parent tweet whose replies we\'ll scan. e.g. https://x.com/user/status/XXX',
        },
        author_handle: {
          type: 'string',
          description: 'Required. Only replies authored by this handle are eligible for deletion.',
        },
        contains_text: {
          type: 'string',
          description: 'Optional substring filter to disambiguate when multiple replies from author_handle exist.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true (default), finds the reply and screenshots but does NOT delete. Set to false to actually delete.',
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

export interface DeleteXReplyInput {
  postUrl: string;
  authorHandle: string;
  containsText?: string;
  dryRun?: boolean;
  expectedBrowserContextId?: string;
}

export interface DeleteXReplyOutput {
  success: boolean;
  message: string;
  matchedCount?: number;
  deletedCount?: number;
  matchedPreview?: string;
  screenshotBase64?: string;
  currentUrl?: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function deleteXReplyViaBrowser(
  input: DeleteXReplyInput,
): Promise<DeleteXReplyOutput> {
  const handle = input.authorHandle.replace(/^@/, '').toLowerCase();
  if (!handle) return { success: false, message: 'author_handle is required' };
  const dryRun = input.dryRun !== false;
  const containsText = input.containsText?.toLowerCase() ?? null;

  const page = await getCdpPage('x.com', input.expectedBrowserContextId);
  if (!page) {
    return { success: false, message: 'Could not attach to Chrome CDP at :9222 — no x.com tab open, or debug Chrome is down.' };
  }

  try {
    await page.goto(input.postUrl);
    await wait(X_HYDRATION_WAIT_MS);
    const currentUrl = await page.url();
    if (isLoginRedirect(currentUrl)) {
      return { success: false, message: `X redirected to login (${currentUrl}).`, currentUrl };
    }

    // Scroll to load replies.
    for (let i = 0; i < 3; i++) {
      await page.evaluate(`window.scrollBy(0, Math.round(window.innerHeight * 0.9))`);
      await wait(500);
    }
    await page.evaluate('window.scrollTo(0, 0)');
    await wait(300);

    // Find reply articles where User-Name link matches @handle.
    const scanResult = await page.evaluate<{
      matches: Array<{ previewText: string; idx: number }>;
    }>(`(() => {
      const want = ${JSON.stringify(handle)};
      const arts = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
      const matches = [];
      let idx = 0;
      for (const art of arts) {
        // Find author handle via User-Name link. The link is
        // a[href="/@handle"] or a[href="/handle"] depending on tier.
        const userName = art.querySelector('[data-testid="User-Name"]');
        if (!userName) continue;
        const links = Array.from(userName.querySelectorAll('a[href]'));
        const matchLink = links.find((a) => {
          const href = (a.getAttribute('href') || '').toLowerCase();
          return href === '/' + want || href === '/@' + want;
        });
        if (!matchLink) continue;
        // Skip the parent tweet itself (detail page primary) — identify by
        // checking if the status URL in this article's timestamp link
        // matches the page's pathname.
        const statusAnchor = art.querySelector('a[href*="/status/"] time')?.parentElement;
        const statusHref = statusAnchor?.getAttribute('href') || '';
        const isPrimary = location.pathname === statusHref;
        if (isPrimary) continue;
        art.setAttribute('data-x-own-reply', String(idx));
        const textEl = art.querySelector('[data-testid="tweetText"]');
        const previewText = (textEl ? textEl.textContent : art.innerText || '').trim().slice(0, 180);
        matches.push({ previewText, idx });
        idx++;
      }
      return { matches };
    })()`);

    if (scanResult.matches.length === 0) {
      return {
        success: false,
        message: `No reply from @${handle} found under ${input.postUrl}.`,
        matchedCount: 0,
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }

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
      const snippets = candidates.map((c) => `  idx=${c.idx}: ${c.previewText.slice(0, 80)}`).join('\n');
      return {
        success: false,
        message: `${candidates.length} replies from @${handle} match. Narrow with contains_text. Candidates:\n${snippets}`,
        matchedCount: candidates.length,
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }

    const target = candidates[0];

    if (dryRun) {
      logger.info({ postUrl: input.postUrl, handle, idx: target.idx }, '[x-delete] dry run — would delete');
      return {
        success: true,
        message: `Dry run: would delete 1 reply from @${handle} (preview: "${target.previewText.slice(0, 100)}"). Call with dry_run=false to actually delete.`,
        matchedCount: 1,
        deletedCount: 0,
        matchedPreview: target.previewText,
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }

    // Open overflow menu inside target article.
    const menuOpened = await page.evaluate<boolean>(`(() => {
      const art = document.querySelector('article[data-x-own-reply="${target.idx}"]');
      if (!art) return false;
      art.scrollIntoView({ block: 'center' });
      const caret = art.querySelector('[data-testid="caret"]');
      if (caret instanceof HTMLElement && typeof caret.click === 'function') {
        caret.click();
        return true;
      }
      return false;
    })()`);

    if (!menuOpened) {
      return {
        success: false,
        message: 'Could not find or click the overflow (caret) menu on the target reply.',
        matchedCount: 1,
        deletedCount: 0,
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }
    await wait(700);

    // Click Delete in dropdown.
    const deleteClicked = await page.evaluate<boolean>(`(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
      const match = items.find((e) => (e.textContent || '').trim().startsWith('Delete') && !!e.offsetParent);
      if (match instanceof HTMLElement && typeof match.click === 'function') {
        match.click();
        return true;
      }
      return false;
    })()`);

    if (!deleteClicked) {
      return {
        success: false,
        message: 'Overflow menu opened but no Delete menuitem found.',
        matchedCount: 1,
        deletedCount: 0,
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }
    await wait(700);

    // Confirm in the sheet.
    const confirmClicked = await page.evaluate<boolean>(`(() => {
      const btn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
      if (btn instanceof HTMLElement && typeof btn.click === 'function') {
        btn.click();
        return true;
      }
      // Fallback: any dialog with a Delete button
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      for (const d of dialogs) {
        const btns = Array.from(d.querySelectorAll('[role="button"], button'));
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
        message: 'Delete click accepted but confirmation button not found.',
        matchedCount: 1,
        deletedCount: 0,
        screenshotBase64: await captureScreenshot(page),
        currentUrl: await page.url(),
      };
    }
    await wait(2000);

    const stillThere = await page.evaluate<boolean>(
      `!!document.querySelector('article[data-x-own-reply="${target.idx}"]')`,
    ).catch(() => true);

    logger.info({ postUrl: input.postUrl, handle, stillThere }, '[x-delete] delete attempt completed');

    return {
      success: !stillThere,
      message: stillThere
        ? 'Delete confirmation clicked but the reply article is still in the DOM. X may have rejected the delete.'
        : `Reply from @${handle} deleted.`,
      matchedCount: 1,
      deletedCount: stillThere ? 0 : 1,
      matchedPreview: target.previewText,
      screenshotBase64: await captureScreenshot(page),
      currentUrl: await page.url(),
    };
  } finally {
    page.close();
  }
}
