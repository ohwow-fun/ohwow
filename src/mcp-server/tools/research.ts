/**
 * Research & Scraping MCP Tools
 * Web research and URL scraping.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

export function registerResearchTools(server: McpServer, client: DaemonApiClient): void {
  // ohwow_deep_research — Via orchestrator (long-running)
  server.tool(
    'ohwow_deep_research',
    '[Research] Multi-source web research with synthesis. Timing: quick ~30s, thorough ~60s, comprehensive ~120s.',
    {
      question: z.string().describe('The research question'),
      depth: z.enum(['quick', 'thorough', 'comprehensive']).optional().describe('Research depth (default: thorough)'),
    },
    async ({ question, depth }) => {
      try {
        const depthStr = depth ? ` with depth: "${depth}"` : '';
        const text = await client.postSSE('/api/chat', {
          message: `Use the deep_research tool with question: "${question}"${depthStr}. Return the full research report.`,
        }, 180_000);
        return { content: [{ type: 'text' as const, text: text || 'No research results' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // ohwow_scrape_url — Via orchestrator
  server.tool(
    'ohwow_scrape_url',
    '[Research] Scrape a web page and return its structured content. Automatically handles anti-bot protection.',
    {
      url: z.string().describe('The URL to scrape'),
    },
    async ({ url }) => {
      try {
        const text = await client.postSSE('/api/chat', {
          message: `Use the scrape_url tool with url: "${url}". Return the scraped content.`,
        }, 30_000);
        return { content: [{ type: 'text' as const, text: text || 'No content scraped' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );
}
