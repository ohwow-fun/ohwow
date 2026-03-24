/**
 * send_notification dispatcher: send a notification via configured channels.
 */

import type { ActionDispatcher, DispatcherDeps } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import { resolveContextTemplate } from '../field-mapper.js';
import { logger } from '../../lib/logger.js';

export const sendNotificationDispatcher: ActionDispatcher = {
  actionType: 'send_notification',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
    deps: DispatcherDeps,
  ): Promise<ActionOutput> {
    const messageTemplate = config.message_template as string;
    if (!messageTemplate) {
      throw new Error('send_notification requires message_template');
    }

    const message = resolveContextTemplate(messageTemplate, context);
    const channel = config.channel as string | undefined;
    const chatId = config.chat_id as string | undefined;
    const sent: string[] = [];

    if (!deps.channels) {
      throw new Error('send_notification: no channel registry available');
    }

    // WhatsApp
    if (!channel || channel === 'all' || channel === 'whatsapp') {
      const wa = deps.channels.get('whatsapp');
      if (wa) {
        const status = wa.getStatus();
        if (status.connected) {
          const configRecipients = config.recipients as string[] | undefined;
          if (configRecipients && configRecipients.length > 0) {
            let anySent = false;
            for (const recipientChatId of configRecipients) {
              const ok = await wa.sendResponse(recipientChatId, message);
              if (ok) anySent = true;
            }
            if (anySent) sent.push('whatsapp');
          } else {
            const targetChatId = chatId
              || wa.getAllowedChats?.()[0]?.chat_id;
            if (targetChatId) {
              const ok = await wa.sendResponse(targetChatId, message);
              if (ok) sent.push('whatsapp');
            }
          }
        }
      }
    }

    // Telegram
    if (!channel || channel === 'all' || channel === 'telegram') {
      const tg = deps.channels.get('telegram');
      if (tg) {
        const status = tg.getStatus();
        if (status.connected) {
          const configRecipients = config.recipients as string[] | undefined;

          if (configRecipients && configRecipients.length > 0) {
            const allRecipients = (status.details?.recipients as Array<{ chat_id: string; username: string }> | undefined) || [];
            let anySent = false;
            for (const target of configRecipients) {
              let resolvedChatId: string | undefined;
              if (target.startsWith('id:')) {
                resolvedChatId = target.slice(3);
              } else {
                resolvedChatId = allRecipients.find((r) => r.username === target)?.chat_id;
              }
              if (resolvedChatId) {
                const ok = await tg.sendResponse(resolvedChatId, message);
                if (ok) anySent = true;
              }
            }
            if (anySent) sent.push('telegram');
          } else if (!configRecipients) {
            const allRecipients = (status.details?.recipients as Array<{ chat_id: string }> | undefined) || [];
            if (allRecipients.length > 0) {
              let anySent = false;
              for (const r of allRecipients) {
                const ok = await tg.sendResponse(r.chat_id, message);
                if (ok) anySent = true;
              }
              if (anySent) sent.push('telegram');
            } else {
              const targetChatId = chatId
                || tg.getDefaultChatId?.()
                || (status.details?.chatId as string | undefined);
              if (targetChatId) {
                const ok = await tg.sendResponse(targetChatId, message);
                if (ok) sent.push('telegram');
              }
            }
          }
        }
      }
    }

    logger.info(`[ActionExecutor] Sent notification to: ${sent.join(', ') || 'none'}`);
    return { sent: sent.length > 0, channels: sent };
  },
};
