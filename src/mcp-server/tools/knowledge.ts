/**
 * Knowledge Base MCP Tools
 * List, search, get, and add documents to the knowledge base.
 *
 * list + get go straight to the daemon's /api/knowledge HTTP endpoints
 * (no orchestrator round-trip) — that path is fast (~50ms) and lets
 * embedding benchmarks, RAG evals, and any other batch consumer pull
 * compiled body text directly. search + add_url keep the orchestrator
 * route because they rely on server-side scraping / retrieval logic
 * that's only wired through the chat pipeline.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

interface KnowledgeListRow {
  id: string;
  title: string;
  type: 'url' | 'file';
  status: string;
  chunk_count: number;
  created_at: string;
}

interface KnowledgeFullRow extends KnowledgeListRow {
  filename: string | null;
  fileType: string | null;
  fileSize: number | null;
  tokens: number;
  contentHash: string | null;
  sourceUrl: string | null;
  processedAt: string | null;
  body: string;
}

export function registerKnowledgeTools(server: McpServer, client: DaemonApiClient): void {
  // ohwow_list_knowledge — Direct HTTP (fast). Optional include_bodies for
  // callers that want to embed or analyse the full corpus in one call.
  server.tool(
    'ohwow_list_knowledge',
    '[Knowledge] List documents in the knowledge base. Returns id, title, type, status, chunk count, and created_at by default. Hits the daemon directly over HTTP (~50ms), no orchestrator round-trip. Set `include_bodies=true` to also get the compiled text for every document — useful for embedding benchmarks and RAG evals. Be aware: body payload scales with doc size; use `limit` to cap the batch when bodies are requested.',
    {
      include_bodies: z
        .boolean()
        .optional()
        .describe('When true, each entry also includes `body` (compiled text), `tokens`, `contentHash`, `filename`, `sourceUrl`, and `processedAt`. Default: false — metadata only. The bodies payload can be large (hundreds of KB to a few MB for 100 docs), so always pair with `limit` for predictable response sizes.'),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Cap the number of rows returned. Defaults to no cap (all active documents). The server hard-caps at 500. Apply this whenever `include_bodies` is true.'),
    },
    async ({ include_bodies, limit }) => {
      try {
        const params = new URLSearchParams();
        if (include_bodies) params.set('include_bodies', '1');
        if (limit !== undefined) params.set('limit', String(limit));
        const qs = params.toString();
        const result = (await client.get(`/api/knowledge${qs ? `?${qs}` : ''}`)) as {
          data?: Array<KnowledgeListRow | KnowledgeFullRow>;
          error?: string;
        };
        if (result.error) {
          return {
            content: [{ type: 'text' as const, text: `Couldn't list knowledge: ${result.error}` }],
            isError: true,
          };
        }
        const docs = result.data ?? [];
        const payload = {
          count: docs.length,
          includeBodies: !!include_bodies,
          documents: docs,
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    },
  );

  // ohwow_get_knowledge — Direct HTTP. Single document by id, always with body.
  server.tool(
    'ohwow_get_knowledge',
    "[Knowledge] Fetch a single knowledge base document by id, including the compiled body text. Returns metadata (title, filename, fileType, fileSize, tokens, chunk_count, contentHash, status, sourceUrl, createdAt, processedAt) plus `body` (the full compiled text). Returns an error result when the id doesn't match an active document — use ohwow_list_knowledge to discover ids. Hits the daemon directly over HTTP (~50ms).",
    {
      id: z.string().describe('Document id from ohwow_list_knowledge.'),
    },
    async ({ id }) => {
      try {
        const result = (await client.get(`/api/knowledge/${encodeURIComponent(id)}`)) as {
          data?: KnowledgeFullRow;
          error?: string;
        };
        if (result.error || !result.data) {
          return {
            content: [{ type: 'text' as const, text: result.error ?? `No knowledge document with id "${id}".` }],
            isError: true,
          };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        // Daemon 404 bubbles up as a thrown error from client.get — surface
        // it as a clean not-found instead of a generic "daemon error".
        if (/\b404\b/.test(message)) {
          return {
            content: [{ type: 'text' as const, text: `No knowledge document with id "${id}". Use ohwow_list_knowledge to discover ids.` }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
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
