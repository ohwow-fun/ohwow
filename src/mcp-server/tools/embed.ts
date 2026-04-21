/**
 * Embedding MCP Tool
 *
 * ohwow_embed — thin direct-HTTP verb over the daemon's POST /api/embed,
 * which in turn runs the in-process Qwen3-Embedding-0.6B ONNX model. No
 * orchestrator round-trip, no cloud call — everything stays on the local
 * daemon.
 *
 * Currently useful for: batch embedding benchmarks, RAG eval harnesses,
 * ad-hoc semantic experiments. Not yet wired into a retrieval path.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

interface EmbedResponse {
  model: string;
  dim: number;
  count: number;
  vectors: number[][];
  latency_ms: number;
  error?: string;
}

export function registerEmbedTools(server: McpServer, client: DaemonApiClient): void {
  server.tool(
    'ohwow_embed',
    '[Embeddings] Embed one or more texts into dense vectors using the daemon\'s in-process Qwen3-Embedding-0.6B model (1024-dim, L2-normalized). Direct HTTP, no orchestrator round-trip. First call after process start may block up to ~30s waiting on model warmup; subsequent calls are sub-second. Pass is_query=true with an optional instruction for asymmetric query encoding. Hard cap: 256 texts per call.',
    {
      texts: z
        .array(z.string().min(1))
        .min(1)
        .max(256)
        .describe('1-256 non-empty strings to embed. Order is preserved in the returned vectors array.'),
      is_query: z
        .boolean()
        .optional()
        .describe('When true, treat the texts as retrieval queries (applies Qwen3-style asymmetric encoding). Default: false (document/passage encoding).'),
      instruction: z
        .string()
        .optional()
        .describe('Qwen3-style task instruction applied only when is_query=true. Example: "Given a web search query, retrieve relevant passages that answer the query".'),
    },
    async ({ texts, is_query, instruction }) => {
      try {
        const body: Record<string, unknown> = { texts };
        if (is_query !== undefined) body.is_query = is_query;
        if (instruction !== undefined) body.instruction = instruction;

        const result = (await client.post('/api/embed', body)) as EmbedResponse;

        if (result.error) {
          return {
            content: [{ type: 'text' as const, text: `Couldn't embed: ${result.error}` }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  model: result.model,
                  dim: result.dim,
                  count: result.count,
                  latency_ms: result.latency_ms,
                  vectors: result.vectors,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
