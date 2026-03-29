/**
 * Messaging MCP Tools
 * Send messages and list chats via WhatsApp and Telegram.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

export function registerMessagingTools(server: McpServer, client: DaemonApiClient): void {
  // ohwow_send_message — Via orchestrator
  server.tool(
    'ohwow_send_message',
    '[Messaging] Send a message via WhatsApp or Telegram. Use ohwow_list_chats to find chat IDs. The channel must be connected in the ohwow dashboard first.',
    {
      channel: z.enum(['whatsapp', 'telegram']).describe('Messaging channel'),
      chatId: z.string().describe('Chat or contact ID to send to'),
      message: z.string().describe('Message text to send'),
    },
    async ({ channel, chatId, message }) => {
      try {
        const toolName = channel === 'whatsapp' ? 'send_whatsapp_message' : 'send_telegram_message';
        const text = await client.postSSE('/api/chat', {
          message: `Use the ${toolName} tool to send this message to chat "${chatId}": ${message}`,
        }, 15_000);
        return { content: [{ type: 'text' as const, text: text || 'Message sent' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // ohwow_list_chats — Via orchestrator
  server.tool(
    'ohwow_list_chats',
    '[Messaging] List connected chats for WhatsApp or Telegram.',
    {
      channel: z.enum(['whatsapp', 'telegram']).describe('Messaging channel'),
    },
    async ({ channel }) => {
      try {
        const toolName = channel === 'whatsapp' ? 'list_whatsapp_chats' : 'list_telegram_chats';
        const text = await client.postSSE('/api/chat', {
          message: `Use the ${toolName} tool. Return the results as-is.`,
        }, 15_000);
        return { content: [{ type: 'text' as const, text: text || 'No chats found' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );
}
