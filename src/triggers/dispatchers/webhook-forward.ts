/**
 * webhook_forward dispatcher: forward data to an external URL.
 */

import type { ActionDispatcher } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import { resolveContextTemplate, resolveContextFieldMapping } from '../field-mapper.js';
import { logger } from '../../lib/logger.js';

export const webhookForwardDispatcher: ActionDispatcher = {
  actionType: 'webhook_forward',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ActionOutput> {
    const url = config.url as string;
    if (!url) {
      throw new Error('webhook_forward requires url in action_config');
    }

    const method = ((config.method as string) || 'POST').toUpperCase();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(config.headers as Record<string, string> || {}),
    };

    let body: string;
    const data = context.trigger;
    if (config.body_template === 'passthrough') {
      body = JSON.stringify(data);
    } else if (typeof config.body_template === 'string') {
      body = resolveContextTemplate(config.body_template, context);
    } else if (config.body_mapping && typeof config.body_mapping === 'object') {
      const mapped = resolveContextFieldMapping(context, config.body_mapping as Record<string, string>);
      body = JSON.stringify(mapped);
    } else {
      body = JSON.stringify(data);
    }

    const response = await fetch(url, { method, headers, body });

    if (!response.ok) {
      throw new Error(`webhook_forward: ${method} ${url} returned ${response.status}`);
    }

    let responseBody: unknown = null;
    try { responseBody = await response.text(); } catch { /* empty */ }

    logger.info(`[ActionExecutor] Forwarded webhook to ${url} (${response.status})`);
    return { status_code: response.status, response_body: responseBody };
  },
};
