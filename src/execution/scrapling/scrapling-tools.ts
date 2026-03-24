/**
 * Scrapling Agent Tools
 * Tool definitions and dispatcher for agent web scraping capabilities.
 * These tools are available to agents in the RuntimeEngine tool-use loop.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ScraplingService } from './scrapling.service.js';
import type { ScraplingToolResult } from './scrapling-types.js';
import { autoEscalateFetch } from './auto-escalate.js';
import { cleanContent } from './content-cleaner.js';

/** Ensure a URL has a protocol prefix. Defaults to https://. */
function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const SCRAPLING_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'web_fetch',
    description:
      'Fetch a web page using fast HTTP with TLS impersonation. Best for public/static pages, APIs, and RSS feeds. Use this first; escalate to stealth or dynamic only if blocked.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        selector: { type: 'string', description: 'Optional CSS selector to extract specific elements' },
        format: { type: 'string', enum: ['html', 'markdown', 'text'], description: 'Output format (default: markdown)' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_fetch_stealth',
    description:
      'Fetch a web page with anti-bot bypass using a modified Firefox browser (Camoufox). Use for sites with Cloudflare, bot detection, or CAPTCHAs.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        selector: { type: 'string', description: 'Optional CSS selector to extract specific elements' },
        format: { type: 'string', enum: ['html', 'markdown', 'text'], description: 'Output format (default: markdown)' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_fetch_dynamic',
    description:
      'Fetch a web page with full browser JS rendering (Chromium). Use for SPAs, React/Vue apps, or pages that load content via JavaScript.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        selector: { type: 'string', description: 'Optional CSS selector to extract specific elements' },
        format: { type: 'string', enum: ['html', 'markdown', 'text'], description: 'Output format (default: markdown)' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_bulk_fetch',
    description:
      'Fetch multiple URLs concurrently using fast HTTP. Use for data collection across many pages.',
    input_schema: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of URLs to fetch (max 20)',
        },
        selector: { type: 'string', description: 'Optional CSS selector to extract from each page' },
        format: { type: 'string', enum: ['html', 'markdown', 'text'], description: 'Output format (default: markdown)' },
        timeout: { type: 'number', description: 'Timeout per URL in seconds (default: 30)' },
      },
      required: ['urls'],
    },
  },
  {
    name: 'web_extract_data',
    description:
      'Fetch a page and extract specific elements using CSS selectors. Returns clean structured data. Use when you need specific data points from a page.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        selector: { type: 'string', description: 'CSS selector for elements to extract' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
      },
      required: ['url', 'selector'],
    },
  },
  {
    name: 'web_smart_fetch',
    description:
      'Fetch a URL with automatic escalation. Tries fast HTTP first, then stealth if blocked, then dynamic as last resort. Use when you are unsure which tier is needed.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        selector: { type: 'string', description: 'Optional CSS selector to extract specific elements' },
        format: { type: 'string', enum: ['html', 'markdown', 'text'], description: 'Output format (default: markdown)' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
      },
      required: ['url'],
    },
  },
];

export const SCRAPLING_TOOL_NAMES = SCRAPLING_TOOL_DEFINITIONS.map(t => t.name);

// ============================================================================
// DISPATCHER
// ============================================================================

/** Check if a tool name is a scrapling tool. */
export function isScraplingTool(toolName: string): boolean {
  return SCRAPLING_TOOL_NAMES.includes(toolName);
}

/** Execute a scrapling tool call. */
export async function executeScraplingTool(
  service: ScraplingService,
  toolName: string,
  input: Record<string, unknown>,
): Promise<ScraplingToolResult> {
  const format = (input.format as string) || 'markdown';
  const selector = input.selector as string | undefined;
  const timeout = input.timeout as number | undefined;

  try {
    switch (toolName) {
      case 'web_fetch': {
        const url = normalizeUrl(input.url as string);
        const response = await service.fetch(url, { selector, timeout });
        if (response.error) return { success: false, error: response.error, url };
        return {
          success: true,
          content: cleanContent(response, format),
          tier: 'fast',
          url,
        };
      }

      case 'web_fetch_stealth': {
        const url = normalizeUrl(input.url as string);
        const response = await service.stealthFetch(url, { selector, timeout });
        if (response.error) return { success: false, error: response.error, url };
        return {
          success: true,
          content: cleanContent(response, format),
          tier: 'stealth',
          url,
        };
      }

      case 'web_fetch_dynamic': {
        const url = normalizeUrl(input.url as string);
        const response = await service.dynamicFetch(url, { selector, timeout });
        if (response.error) return { success: false, error: response.error, url };
        return {
          success: true,
          content: cleanContent(response, format),
          tier: 'dynamic',
          url,
        };
      }

      case 'web_bulk_fetch': {
        const rawUrls = input.urls as string[] | undefined;
        if (!rawUrls || !Array.isArray(rawUrls) || rawUrls.length === 0) {
          return { success: false, error: 'urls must be a non-empty array of strings' };
        }
        const urls = rawUrls.slice(0, 20).map(normalizeUrl); // Cap at 20
        const BULK_PER_PAGE_LIMIT = 5000;
        const BULK_TOTAL_LIMIT = 50000;
        const responses = await service.bulkFetch(urls, { selector, timeout });
        const results = responses.map(r => ({
          url: r.url,
          content: r.error
            ? `Error: ${r.error}`
            : cleanContent(r, format, BULK_PER_PAGE_LIMIT),
          error: r.error,
        }));

        // Build combined content with total size cap
        let combined = '';
        for (const r of results) {
          const section = `## ${r.url}\n${r.content}`;
          if (combined.length + section.length > BULK_TOTAL_LIMIT) {
            combined += `\n\n---\n\n[Remaining ${results.length - results.indexOf(r)} pages truncated to fit context]`;
            break;
          }
          if (combined) combined += '\n\n---\n\n';
          combined += section;
        }

        return {
          success: true,
          content: combined,
          data: results,
          tier: 'fast',
        };
      }

      case 'web_extract_data': {
        const url = normalizeUrl(input.url as string);
        const response = await service.fetch(url, { selector: selector!, timeout });
        if (response.error) return { success: false, error: response.error, url };
        return {
          success: true,
          content: response.selected
            ? response.selected.join('\n')
            : 'No elements matched the selector.',
          data: { selected: response.selected, title: response.title },
          tier: 'fast',
          url,
        };
      }

      case 'web_smart_fetch': {
        const url = normalizeUrl(input.url as string);
        const result = await autoEscalateFetch(service, url, { selector, timeout });
        return {
          success: !result.error,
          content: result.error ? undefined : cleanContent(result.response!, format),
          error: result.error,
          tier: result.tier,
          url,
        };
      }

      default:
        return { success: false, error: `Unknown scrapling tool: ${toolName}` };
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Scrapling fetch failed',
    };
  }
}

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

export const SCRAPLING_SYSTEM_PROMPT = `
## Web Scraping
You have powerful web scraping tools. Choose the right one:
- **web_fetch**: Fast HTTP fetch. Use first for public/static pages and APIs.
- **web_fetch_stealth**: Anti-bot bypass (Cloudflare, etc.). Use when web_fetch gets blocked.
- **web_fetch_dynamic**: Full browser JS rendering. Use for SPAs and JS-heavy sites.
- **web_bulk_fetch**: Fetch many URLs at once. Use for data collection.
- **web_extract_data**: Fetch + extract specific elements via CSS selector.
- **web_smart_fetch**: Auto-escalates through tiers. Use when unsure which tier is needed.

Strategy: Start with web_fetch. If you get a 403, empty content, or Cloudflare challenge, escalate to stealth. Use dynamic only for JS-rendered content.
`;
