/**
 * Knowledge Base MCP Tools
 * List, search, and add documents to the knowledge base.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

export function registerKnowledgeTools(server: McpServer, client: DaemonApiClient): void {
  // ohwow_list_knowledge — Via orchestrator
  server.tool(
    'ohwow_list_knowledge',
    '[Knowledge] List all documents in the knowledge base. Returns document titles, sources, chunk counts, and sync status. Routes through orchestrator (~15s).',
    {},
    async () => {
      try {
        const text = await client.postSSE('/api/chat', {
          message: 'Use the list_knowledge tool. Return the results as-is.',
        }, 15_000);
        return { content: [{ type: 'text' as const, text: text || 'No knowledge documents found' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // ohwow_search_knowledge — Via orchestrator (RAG search)
  server.tool(
    'ohwow_search_knowledge',
    '[Knowledge] Semantic (RAG) search across the knowledge base. Returns relevant document chunks ranked by similarity, with source attribution. Routes through orchestrator (~15s).',
    {
      query: z.string().describe('The search query'),
    },
    async ({ query }) => {
      try {
        const text = await client.postSSE('/api/chat', {
          message: `Use the search_knowledge tool with query: "${query}". Return the results as-is.`,
        }, 15_000);
        return { content: [{ type: 'text' as const, text: text || 'No results found' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // ohwow_add_knowledge_url — Via orchestrator
  server.tool(
    'ohwow_add_knowledge_url',
    '[Knowledge] Add a web page to the knowledge base. Fetches, chunks, and embeds the content for later search.',
    {
      url: z.string().describe('The URL to ingest'),
      title: z.string().optional().describe('Optional title for the document'),
    },
    async ({ url, title }) => {
      try {
        const titleStr = title ? ` with title: "${title}"` : '';
        const text = await client.postSSE('/api/chat', {
          message: `Use the add_knowledge_from_url tool with url: "${url}"${titleStr}.`,
        }, 30_000);
        return { content: [{ type: 'text' as const, text: text || 'Knowledge document added' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );
}
