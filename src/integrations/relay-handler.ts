/**
 * Relay Handler
 * Creates message handlers that either route to the local MessageRouter
 * (if running as primary) or relay to the primary peer (if running as worker).
 */

import type { ChannelType } from './channel-types.js';
import type { MessageRouter } from './message-router.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { relayMessage, parsePeerRow } from '../peers/peer-client.js';
import { logger } from '../lib/logger.js';

/**
 * Create a message handler that routes locally or relays to the primary peer.
 * When messageRouter is non-null (primary device), messages are handled locally.
 * When messageRouter is null (worker device), messages are relayed to the primary.
 */
export function createChannelMessageHandler(
  channel: ChannelType,
  messageRouter: MessageRouter | null,
  db: DatabaseAdapter,
): (connectionId: string, chatId: string, sender: string, text: string) => void {
  return (connectionId, chatId, sender, text) => {
    if (messageRouter) {
      messageRouter.handleIncomingMessage(
        { channel, chatId, connectionId },
        sender,
        text,
      );
    } else {
      relayToPrimary(channel, db, { connectionId, chatId, sender, text });
    }
  };
}

async function relayToPrimary(
  channel: ChannelType,
  db: DatabaseAdapter,
  payload: { connectionId: string; chatId: string; sender: string; text: string },
): Promise<void> {
  try {
    const { data: peers } = await db.from('workspace_peers').select('*').eq('status', 'connected');
    if (!peers?.length) {
      logger.warn({ channel }, '[relay] No connected peers to relay to');
      return;
    }

    // Relay to the first connected peer (primary has lowest machine_id, but any peer with
    // a messageRouter will process it via the relay-message endpoint)
    const primary = parsePeerRow(peers[0] as Record<string, unknown>);
    const result = await relayMessage(primary, { channel, ...payload });
    if (!result.relayed) {
      logger.warn({ channel, error: result.error }, '[relay] Relay to primary failed');
    }
  } catch (err) {
    logger.error({ err, channel }, '[relay] Error relaying to primary');
  }
}
