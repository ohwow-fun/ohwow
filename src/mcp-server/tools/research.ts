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
    '[Research] Scrape a web page and return its structured content. Automatically handles anti-bot protection. Note: for X/Twitter posts use ohwow_fetch_x_post instead — ohwow_scrape_url renders the accessibility tree and X loads post text client-side, so the body usually comes back empty.',
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

  // ohwow_fetch_x_post — pulls a tweet via the public syndication endpoint
  server.tool(
    'ohwow_fetch_x_post',
    "[Research] Fetch a single X (Twitter) post's body, author, media, and engagement metrics. Use this instead of ohwow_scrape_url whenever you need the actual text of a tweet — tweets render client-side, so generic scraping returns the chrome, not the content. Critical for grounding an outreach DM (ohwow_draft_x_dm) in a specific idea the contact wrote, which is the voice rule for outbound X messaging. Accepts either a permalink (https://x.com/handle/status/123 or /handle/status/123) or a bare numeric tweet id.",
    {
      permalink_or_id: z
        .string()
        .min(1)
        .describe('Tweet permalink, URL, or bare numeric id. Examples: "https://x.com/user/status/2044523795206029525", "/user/status/2044523795206029525", "2044523795206029525".'),
    },
    async ({ permalink_or_id }) => {
      try {
        // Use ?permalink=... so Express doesn't try to route the slashes
        // in a full URL as path segments.
        const url = `/api/x/tweet/lookup?permalink=${encodeURIComponent(permalink_or_id)}`;
        const result = (await client.get(url)) as { data?: unknown; error?: string };
        if (result.error) {
          return {
            content: [{ type: 'text' as const, text: `Couldn't fetch tweet: ${result.error}` }],
            isError: true,
          };
        }
        if (!result.data) {
          return {
            content: [{ type: 'text' as const, text: 'Tweet not found (private, deleted, or unparseable id).' }],
            isError: true,
          };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    },
  );
}
