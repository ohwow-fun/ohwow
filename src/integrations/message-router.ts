/**
 * Unified Message Router
 * Single code path for all incoming messaging channel messages.
 * Replaces the duplicated orchestrator loop from whatsapp/message-handler.ts.
 */

import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import type { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';
import type { ChannelAddress, ChannelType } from './channel-types.js';
import type { ChannelRegistry } from './channel-registry.js';
import { MessageQueue } from './message-queue.js';
import type { LocalOrchestrator } from '../orchestrator/local-orchestrator.js';
import type { LocalTriggerEvaluator } from '../triggers/local-trigger-evaluator.js';
import { logger } from '../lib/logger.js';

/** Allowed table names per channel type — prevents SQL injection via dynamic table names */
export const TABLE_MAP: Record<ChannelType, string> = {
  tui: 'tui_chat_messages',
  whatsapp: 'whatsapp_chat_messages',
  telegram: 'telegram_chat_messages',
  voice: 'voice_chat_messages',
};

interface MessageRouterDeps {
  orchestrator: LocalOrchestrator;
  channelRegistry: ChannelRegistry;
  rawDb: Database.Database;
  triggerEvaluator?: LocalTriggerEvaluator;
  eventBus?: TypedEventBus<RuntimeEvents>;
}

export class MessageRouter {
  private orchestrator: LocalOrchestrator;
  private channelRegistry: ChannelRegistry;
  private rawDb: Database.Database;
  private triggerEvaluator: LocalTriggerEvaluator | null;
  private eventBus: TypedEventBus<RuntimeEvents> | null;
  private queue = new MessageQueue();

  constructor(deps: MessageRouterDeps) {
    this.orchestrator = deps.orchestrator;
    this.channelRegistry = deps.channelRegistry;
    this.rawDb = deps.rawDb;
    this.triggerEvaluator = deps.triggerEvaluator ?? null;
    this.eventBus = deps.eventBus ?? null;
  }

  handleIncomingMessage(
    address: ChannelAddress,
    sender: string,
    text: string,
  ): void {
    const key = `${address.channel}:${address.chatId}`;
    this.queue.enqueue(key, () =>
      this.processMessage(address, sender, text),
    ).catch((err) => {
      logger.error({ err, key }, '[MessageRouter] Error processing message');
    });
  }

  private async processMessage(
    address: ChannelAddress,
    sender: string,
    text: string,
  ): Promise<void> {
    // Resolve channel: prefer exact connectionId lookup, fall back to type default
    const channel = address.connectionId
      ? this.channelRegistry.getByConnectionId(address.connectionId) ?? this.channelRegistry.get(address.channel)
      : this.channelRegistry.get(address.channel);
    if (!channel) {
      logger.error({ channel: address.channel }, '[MessageRouter] No channel registered');
      return;
    }

    const tableName = TABLE_MAP[address.channel];
    if (!tableName) throw new Error(`Unknown channel: ${address.channel}`);
    const connectionIdCol = address.connectionId ? 'connection_id' : null;

    try {
      // Handle commands
      const trimmedText = text.trim().toLowerCase();

      if (trimmedText === '/clear') {
        if (connectionIdCol) {
          this.rawDb.prepare(
            `DELETE FROM ${tableName} WHERE ${connectionIdCol} = ? AND chat_id = ?`,
          ).run(address.connectionId, address.chatId);
        } else {
          this.rawDb.prepare(
            `DELETE FROM ${tableName} WHERE chat_id = ?`,
          ).run(address.chatId);
        }
        await channel.sendResponse(address.chatId, 'Conversation history cleared.');
        return;
      }

      if (trimmedText === '/start') {
        const welcomeMessage = [
          '*Welcome to OHWOW AI Runtime*',
          '',
          "I'm your AI orchestrator. Here's what I can do:",
          '',
          'Manage and run your AI agents',
          'Check task status and approve work',
          'Answer questions about your workspace',
          '',
          '*Commands:*',
          '`/clear` — Clear conversation history',
          '`/start` — Show this welcome message',
          '',
          'Just send me a message to get started!',
        ].join('\n');
        await channel.sendResponse(address.chatId, welcomeMessage);
        return;
      }

      // Always include sender context so the orchestrator knows who is speaking
      const contextPrefix = `[${address.channel} from ${sender}]: `;

      const sessionId = this.deriveSessionId(address);

      // Save history rows temporarily to session so orchestrator can pick them up
      // Actually, chatForChannel handles its own history via sessionId.
      // We just need to pass the channel-specific history as the user message context.
      const userMsg = `${contextPrefix}${text}`;

      // Build channel options from the channel interface
      const channelOptions = {
        excludedTools: channel.excludedTools(),
        transformToolInput: channel.transformToolInput?.bind(channel),
        platform: channel.type,
      };

      // Run through orchestrator
      const response = await this.orchestrator.chatForChannel(
        userMsg,
        sessionId,
        channelOptions,
      );

      // Save messages to channel-specific history table
      if (response) {
        const insertCols = connectionIdCol
          ? `(${connectionIdCol}, chat_id, sender, role, content)`
          : '(chat_id, sender, role, content)';

        const insertPlaceholders = connectionIdCol
          ? '(?, ?, ?, ?, ?)'
          : '(?, ?, ?, ?)';

        const userParams = connectionIdCol
          ? [address.connectionId, address.chatId, sender, 'user', text]
          : [address.chatId, sender, 'user', text];

        const assistantParams = connectionIdCol
          ? [address.connectionId, address.chatId, null, 'assistant', response]
          : [address.chatId, null, 'assistant', response];

        this.rawDb.prepare(
          `INSERT INTO ${tableName} ${insertCols} VALUES ${insertPlaceholders}`,
        ).run(...userParams);

        this.rawDb.prepare(
          `INSERT INTO ${tableName} ${insertCols} VALUES ${insertPlaceholders}`,
        ).run(...assistantParams);

        // Send response via channel
        await channel.sendResponse(address.chatId, response);

        // Emit message:stored for cross-device sync
        this.eventBus?.emit('message:stored', {
          channel: address.channel,
          chatId: address.chatId,
          connectionId: address.connectionId,
          timestamp: new Date().toISOString(),
        });
      }

      // Fire-and-forget: evaluate automation triggers for this message
      if (this.triggerEvaluator) {
        this.triggerEvaluator.evaluate(address.channel, 'message', {
          chatId: address.chatId,
          sender,
          text,
          connectionId: address.connectionId,
        }).catch(() => {
          // Trigger errors are non-fatal
        });
      }
    } catch (err) {
      logger.error({ err, channel: address.channel, chatId: address.chatId }, '[MessageRouter] Error handling message');
      try {
        await channel.sendResponse(
          address.chatId,
          'Sorry, I encountered an error processing your message.',
        );
      } catch {
        // Silently fail — can't send error message
      }
    }
  }

  private deriveSessionId(address: ChannelAddress): string {
    // Include connectionId when present so the same contact on different
    // numbers/bots gets separate sessions (avoids cross-connection bleed)
    const input = address.connectionId
      ? `${address.channel}:${address.connectionId}:${address.chatId}`
      : `${address.channel}:${address.chatId}`;
    return createHash('sha256').update(input).digest('hex');
  }
}
