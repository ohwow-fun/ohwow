/**
 * Telegram Orchestrator Tools
 * Allows the orchestrator to send messages and list Telegram chats/bots.
 * Supports multi-bot: tools accept optional connection_id or bot_username.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import type { TelegramClient } from '../../integrations/telegram/client.js';

export const TELEGRAM_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'send_telegram_message',
    description:
      'Send a message to a Telegram chat via the connected bot. For multi-bot workspaces, optionally specify which bot to send from.',
    input_schema: {
      type: 'object' as const,
      properties: {
        chat_id: { type: 'string', description: 'The Telegram chat ID' },
        message: { type: 'string', description: 'The message text to send' },
        connection_id: { type: 'string', description: 'Optional: send from a specific Telegram bot connection (use list_telegram_connections to see IDs)' },
        bot_username: { type: 'string', description: 'Optional: send from the bot matching this username (e.g. "company_bot")' },
      },
      required: ['chat_id', 'message'],
    },
  },
  {
    name: 'list_telegram_chats',
    description:
      'Get the Telegram bot connection status.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_telegram_connections',
    description:
      'List all Telegram bot connections in the workspace, showing bot username, label, status per connection. Useful when the workspace has multiple Telegram bots.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

/**
 * Resolve a Telegram client from context.
 * Supports multi-bot: if connection_id or bot_username is provided,
 * finds the matching client. Otherwise returns the default.
 */
function resolveTelegramClient(
  ctx: LocalToolContext,
  opts?: { connection_id?: string; bot_username?: string },
): TelegramClient | undefined {
  if (opts?.connection_id) {
    return ctx.channels.getByConnectionId(opts.connection_id) as TelegramClient | undefined;
  }

  if (opts?.bot_username) {
    const normalized = opts.bot_username.replace(/^@/, '').toLowerCase();
    const all = ctx.channels.getAllOfType('telegram') as TelegramClient[];
    for (const client of all) {
      const status = client.getTelegramStatus();
      if (status.botUsername?.toLowerCase() === normalized) {
        return client;
      }
    }
    return undefined;
  }

  return ctx.channels.get('telegram') as TelegramClient | undefined;
}

/**
 * Send a Telegram message to a chat.
 */
export async function sendTelegramMessage(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const { chat_id, message, connection_id, bot_username } = input as {
    chat_id: string; message: string;
    connection_id?: string; bot_username?: string;
  };

  if (!chat_id || !message) {
    return { success: false, error: 'Need both a chat ID and a message to send.' };
  }

  const channel = resolveTelegramClient(ctx, { connection_id, bot_username });

  if (!channel) {
    if (connection_id || bot_username) {
      return { success: false, error: `No Telegram bot matches ${connection_id ? `connection "${connection_id}"` : `@${bot_username}`}. Use \`list_telegram_connections\` to see available bots.` };
    }
    return { success: false, error: 'Telegram isn\'t set up yet. Connect your bot from the Integrations screen.' };
  }

  const status = channel.getStatus();
  if (!status.connected) {
    return { success: false, error: 'Telegram bot is disconnected. Check the bot token in Integrations.' };
  }

  const sent = await channel.sendResponse(chat_id, message);
  if (!sent) {
    return { success: false, error: 'Couldn\'t send that message. Try again?' };
  }

  return { success: true, data: { sent: true, chat_id } };
}

/**
 * List known Telegram chats (from message history).
 */
export async function listTelegramChats(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  const channel = ctx.channels.get('telegram') as TelegramClient | undefined;

  if (!channel) {
    return { success: false, error: 'Telegram isn\'t set up yet. Connect your bot from the Integrations screen.' };
  }

  const tgStatus = channel.getTelegramStatus();

  return {
    success: true,
    data: {
      status: tgStatus.status,
      botUsername: tgStatus.botUsername,
    },
  };
}

/**
 * List all Telegram bot connections in this workspace.
 */
export async function listTelegramConnections(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  const all = ctx.channels.getAllOfType('telegram') as TelegramClient[];

  if (all.length === 0) {
    return { success: true, data: { connections: [], note: 'No Telegram bots configured.' } };
  }

  const connections = all.map((client) => {
    const status = client.getTelegramStatus();
    return {
      connectionId: status.connectionId,
      botUsername: status.botUsername,
      label: client.identity?.label ?? null,
      isDefault: client.identity?.isDefault ?? false,
      status: status.status,
    };
  });

  return { success: true, data: { connections } };
}
