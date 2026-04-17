/**
 * Email MCP Tools
 * Inbox search, AI summaries, and draft replies.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

export function registerEmailTools(server: McpServer, client: DaemonApiClient): void {
  server.tool(
    'ohwow_search_emails',
    '[Email] Search inbox by sender, subject, or date range. Returns subject, sender, snippet, and read status.',
    {
      search: z.string().optional().describe('Full-text search across subject, sender, and snippet'),
      from: z.string().optional().describe('Filter by sender email (partial match)'),
      subject: z.string().optional().describe('Filter by subject (partial match)'),
      after: z.string().optional().describe('Only emails received after this date (ISO)'),
      before: z.string().optional().describe('Only emails received before this date (ISO)'),
      is_read: z.boolean().optional().describe('Filter by read status'),
      limit: z.number().optional().describe('Max results (default: 50)'),
    },
    async ({ search, from, subject, after, before, is_read, limit }) => {
      try {
        const params = new URLSearchParams();
        if (search) params.set('search', search);
        if (from) params.set('from', from);
        if (subject) params.set('subject', subject);
        if (after) params.set('after', after);
        if (before) params.set('before', before);
        if (is_read !== undefined) params.set('is_read', is_read ? '1' : '0');
        if (limit) params.set('limit', String(limit));
        const query = params.toString();
        const data = await client.get(`/api/email/messages${query ? `?${query}` : ''}`) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data.data || data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_summarize_inbox',
    '[Email] AI summary of unread or recent emails. Groups by priority and highlights action items.',
    {
      hours: z.number().optional().describe('Look back N hours (default: 24)'),
    },
    async ({ hours }) => {
      try {
        const lookback = hours || 24;
        const text = await client.postSSE('/api/chat', {
          message: `Use the list_emails tool to fetch unread emails from the last ${lookback} hours. Then summarize them grouped by priority: urgent items first, then items needing a response, then FYI items. For each email mention the sender, subject, and what action (if any) is needed. Keep it concise.`,
        }, 30_000);
        return { content: [{ type: 'text' as const, text: text || 'No unread emails found' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_draft_reply',
    '[Email] Draft a reply to an email message. The AI writes the reply based on your instructions.',
    {
      message_id: z.string().describe('ID of the email to reply to'),
      instructions: z.string().describe('What to say in the reply (e.g. "Accept the meeting, suggest Tuesday instead")'),
      tone: z.enum(['formal', 'friendly', 'brief']).optional().describe('Tone of the reply (default: friendly)'),
    },
    async ({ message_id, instructions, tone }) => {
      try {
        // Fetch the original message for context
        const original = await client.get(`/api/email/messages/${message_id}`) as Record<string, unknown>;
        const msg = (original as { data?: Record<string, unknown> }).data || original;

        const toneGuide = tone === 'formal' ? 'Use a formal, professional tone.'
          : tone === 'brief' ? 'Keep it very short and direct.'
          : 'Use a warm, friendly tone.';

        const text = await client.postSSE('/api/chat', {
          message: `Draft an email reply. Original email from ${(msg as Record<string, unknown>).from_address} with subject "${(msg as Record<string, unknown>).subject}": "${(msg as Record<string, unknown>).snippet || (msg as Record<string, unknown>).body_text}". Instructions: ${instructions}. ${toneGuide} Return only the reply body text, no subject line.`,
        }, 20_000);

        // Save as draft
        const draft = await client.post('/api/email/drafts', {
          reply_to_id: message_id,
          to_addresses: [(msg as Record<string, unknown>).from_address],
          subject: `Re: ${(msg as Record<string, unknown>).subject || ''}`,
          body_text: text,
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify({ draft, reply_text: text }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );
}
