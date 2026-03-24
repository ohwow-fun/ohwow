/**
 * take_screenshot dispatcher: navigate to a URL and capture a screenshot.
 */

import type { ActionDispatcher } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import { resolveContextTemplate } from '../field-mapper.js';
import { logger } from '../../lib/logger.js';

export const takeScreenshotDispatcher: ActionDispatcher = {
  actionType: 'take_screenshot',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ActionOutput> {
    const urlTemplate = config.url as string;
    const waitSeconds = (config.wait_seconds as number) ?? 0;

    if (!urlTemplate) throw new Error('take_screenshot requires a URL');

    const url = resolveContextTemplate(urlTemplate, context);
    if (!url.startsWith('http')) {
      throw new Error(`Resolved URL is not valid: ${url}`);
    }

    const { LocalBrowserService } = await import('../../execution/browser/local-browser.service.js');
    const { saveScreenshotLocally } = await import('../../execution/browser/screenshot-storage.js');
    const { join } = await import('path');

    const browser = new LocalBrowserService({ headless: true });

    try {
      await browser.ensureBrowser();

      await browser.executeAction({ type: 'navigate', url });

      if (waitSeconds > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      }

      const result = await browser.executeAction({ type: 'screenshot' });

      let screenshotPath = '';
      if (result.screenshot) {
        const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
        const saved = await saveScreenshotLocally(result.screenshot, dataDir);
        screenshotPath = saved.path;
      }

      logger.info(`[ActionExecutor] Screenshot captured: ${url} → ${screenshotPath}`);

      return {
        screenshot_url: screenshotPath,
        page_title: result.content || '',
        page_url: url,
      };
    } finally {
      await browser.close().catch((err: unknown) =>
        logger.warn(`[ActionExecutor] Browser cleanup error: ${err}`)
      );
    }
  },
};
