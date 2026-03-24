/**
 * WhatsApp Routes
 * API endpoints to control the local WhatsApp client from the dashboard.
 * Supports multi-connection: pass ?connectionId= to target a specific instance.
 */

import { Router } from 'express';
import type { WhatsAppClient } from '../../whatsapp/client.js';
import type { ChannelRegistry } from '../../integrations/channel-registry.js';
import { logger } from '../../lib/logger.js';

type GetWhatsAppClient = () => WhatsAppClient | null;

export function createWhatsAppRouter(
  getClient: GetWhatsAppClient,
  channelRegistry?: ChannelRegistry,
): Router {
  const router = Router();

  /**
   * Resolve the WhatsApp client for a request.
   * If channelRegistry is available and ?connectionId is set, uses exact lookup.
   * Otherwise falls back to the legacy getClient() accessor.
   */
  function resolveClient(req: import('express').Request): WhatsAppClient | null {
    const connectionId = req.query.connectionId as string | undefined;
    if (connectionId && channelRegistry) {
      return channelRegistry.getByConnectionId(connectionId) as WhatsAppClient | null ?? null;
    }
    return getClient();
  }

  /** Helper: get client or return 503 */
  function withClient(
    req: import('express').Request,
    res: import('express').Response,
    fn: (client: WhatsAppClient) => Promise<void> | void,
  ) {
    const client = resolveClient(req);
    if (!client) {
      res.status(503).json({ error: 'WhatsApp requires a connected workspace. Set up your license key first.' });
      return;
    }
    Promise.resolve(fn(client)).catch((err) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    });
  }

  // GET /api/whatsapp/status
  router.get('/api/whatsapp/status', (req, res) => {
    withClient(req, res, (client) => {
      const { status, phoneNumber, connectionId } = client.getWaStatus();
      const allowedChats = client.getAllowedChats();
      res.json({ data: { status, phoneNumber, connectionId, allowedChats } });
    });
  });

  // GET /api/whatsapp/connections — list all WhatsApp connections
  router.get('/api/whatsapp/connections', (_req, res) => {
    if (!channelRegistry) {
      const client = getClient();
      if (!client) {
        res.json({ data: { connections: [] } });
        return;
      }
      const status = client.getWaStatus();
      res.json({ data: { connections: [{
        connectionId: status.connectionId,
        phoneNumber: status.phoneNumber,
        label: client.identity?.label ?? null,
        isDefault: true,
        status: status.status,
      }] } });
      return;
    }

    const all = channelRegistry.getAllOfType('whatsapp') as WhatsAppClient[];
    const connections = all.map((client) => {
      const status = client.getWaStatus();
      return {
        connectionId: status.connectionId,
        phoneNumber: status.phoneNumber,
        label: client.identity?.label ?? null,
        isDefault: client.identity?.isDefault ?? false,
        status: status.status,
      };
    });
    res.json({ data: { connections } });
  });

  // POST /api/whatsapp/connect
  router.post('/api/whatsapp/connect', (req, res) => {
    withClient(req, res, async (client) => {
      // Fire-and-forget: connect runs async, QR arrives via WebSocket
      client.connect().catch((err) => {
        logger.error({ err }, '[WhatsApp API] connect error');
      });
      res.status(202).json({ data: { message: 'Connecting. Watch for QR code via WebSocket.' } });
    });
  });

  // POST /api/whatsapp/disconnect
  router.post('/api/whatsapp/disconnect', (req, res) => {
    withClient(req, res, async (client) => {
      await client.disconnect();
      res.json({ data: { message: 'Disconnected' } });
    });
  });

  // POST /api/whatsapp/chats — add an allowed chat
  router.post('/api/whatsapp/chats', (req, res) => {
    withClient(req, res, (client) => {
      const { chatId, chatName, chatType } = req.body as {
        chatId?: string;
        chatName?: string;
        chatType?: 'individual' | 'group';
      };
      if (!chatId) {
        res.status(400).json({ error: 'chatId is required' });
        return;
      }
      client.addAllowedChat(chatId, chatName || null, chatType || 'individual');
      const allowedChats = client.getAllowedChats();
      res.status(201).json({ data: { allowedChats } });
    });
  });

  // DELETE /api/whatsapp/chats — remove an allowed chat
  router.delete('/api/whatsapp/chats', (req, res) => {
    withClient(req, res, (client) => {
      const { chatId } = req.body as { chatId?: string };
      if (!chatId) {
        res.status(400).json({ error: 'chatId is required' });
        return;
      }
      client.removeAllowedChat(chatId);
      const allowedChats = client.getAllowedChats();
      res.json({ data: { allowedChats } });
    });
  });

  return router;
}
