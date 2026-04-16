/**
 * Daemon messaging channels phase
 *
 * Enumerates whatsapp_connections + telegram_connections for the active
 * workspace and registers/auto-connects one client per row (multi-number
 * and multi-bot support). When no rows exist, falls back to a single
 * legacy-mode client. Registers each client with the channel registry and
 * attaches the relay message handler so worker devices forward inbound
 * messages to the primary.
 *
 * Populates ctx.waClient (the default/first WhatsApp client, kept for
 * backward-compat shutdown) and ctx.tgClient (the default/first Telegram
 * client).
 */

import { WhatsAppClient } from '../whatsapp/client.js';
import { TelegramClient } from '../integrations/telegram/client.js';
import { logger } from '../lib/logger.js';
import type { DaemonContext } from './context.js';

export async function initializeMessagingChannels(ctx: Partial<DaemonContext>): Promise<void> {
  const { rawDb, db, bus, workspaceId, channelRegistry, messageRouter } = ctx as DaemonContext;

  // Import relay handler for worker devices (messageRouter is null on workers)
  const { createChannelMessageHandler } = await import('../integrations/relay-handler.js');
  const waMessageHandler = createChannelMessageHandler('whatsapp', messageRouter, db);
  const tgMessageHandler = createChannelMessageHandler('telegram', messageRouter, db);

  let waClient: WhatsAppClient | null = null;
  let tgClient: TelegramClient | null = null;

  // WhatsApp — create one client per connection row (multi-number support)
  const waConnections = rawDb.prepare(
    'SELECT id, label, is_default, auth_state FROM whatsapp_connections WHERE workspace_id = ?',
  ).all(workspaceId) as { id: string; label: string | null; is_default: number; auth_state: string | null }[];

  if (waConnections.length > 0) {
    for (const conn of waConnections) {
      const client = WhatsAppClient.forConnection(rawDb, workspaceId, bus, conn.id, {
        label: conn.label ?? undefined,
        isDefault: conn.is_default === 1,
      });
      channelRegistry.register(client);
      client.setMessageHandler(waMessageHandler);

      if (conn.auth_state) {
        client.connect().then(() => {
          logger.info({ connectionId: conn.id, label: conn.label }, '[daemon] WhatsApp auto-connected');
        }).catch(err => {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('locked by another device')) {
            logger.info({ connectionId: conn.id }, '[daemon] WhatsApp connection locked by another device, skipping');
          } else {
            logger.warn(`[daemon] WhatsApp auto-connect failed (${conn.label || conn.id}): ${msg}`);
          }
        });
      }
    }
    // Keep waClient pointing to the default/first for backward-compat shutdown
    waClient = channelRegistry.get('whatsapp') as WhatsAppClient | null;
  } else {
    // No connections yet — create a single client (legacy single-instance mode)
    waClient = new WhatsAppClient(rawDb, workspaceId, bus);
    channelRegistry.register(waClient);
    waClient.setMessageHandler(waMessageHandler);
  }

  // Telegram — create one client per connection row (multi-bot support)
  const tgConnections = rawDb.prepare(
    'SELECT id, label, is_default FROM telegram_connections WHERE workspace_id = ?',
  ).all(workspaceId) as { id: string; label: string | null; is_default: number }[];

  if (tgConnections.length > 0) {
    for (const conn of tgConnections) {
      const client = TelegramClient.forConnection(rawDb, workspaceId, bus, conn.id, {
        label: conn.label ?? undefined,
        isDefault: conn.is_default === 1,
      });
      channelRegistry.register(client);
      client.setMessageHandler((connectionId, chatId, sender, text) => {
        tgMessageHandler(connectionId ?? '', chatId, sender, text);
      });

      client.connect().then(() => {
        logger.info({ connectionId: conn.id, label: conn.label }, '[daemon] Telegram auto-connected');
      }).catch(err => {
        logger.warn(`[daemon] Telegram auto-connect failed (${conn.label || conn.id}): ${err instanceof Error ? err.message : err}`);
      });
    }
    tgClient = channelRegistry.get('telegram') as TelegramClient | null;
  } else {
    // No connections yet — create a single client (legacy single-instance mode)
    tgClient = new TelegramClient(rawDb, workspaceId, bus);
    channelRegistry.register(tgClient);
    tgClient.setMessageHandler((connectionId, chatId, sender, text) => {
      tgMessageHandler(connectionId ?? '', chatId, sender, text);
    });

    if (tgClient.isConfigured()) {
      tgClient.connect().then(() => {
        logger.info('[daemon] Telegram auto-connected');
      }).catch(err => {
        logger.warn(`[daemon] Telegram auto-connect failed: ${err instanceof Error ? err.message : err}`);
      });
    }
  }

  ctx.waClient = waClient;
  ctx.tgClient = tgClient;
}
