/**
 * Orchestrator Scraping Tools
 * User-facing scraping tools for interactive use via the orchestrator chat.
 * Uses the shared ScraplingService instance from LocalToolContext.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import {
  ScraplingService,
  autoEscalateFetch,
  cleanContent,
} from '../../execution/scrapling/index.js';
import { logger } from '../../lib/logger.js';

/** Ensure a URL has a protocol prefix. Defaults to https://. */
function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * Get the ScraplingService from context, or create a fallback instance.
 */
function getService(ctx: LocalToolContext): ScraplingService {
  if (ctx.scraplingService) return ctx.scraplingService;
  // Fallback: create an instance (should not happen with proper wiring)
  logger.warn('[Scraping] No shared ScraplingService in context, creating fallback instance');
  return new ScraplingService();
}

/**
 * Fetch and extract content from a URL.
 * Auto-escalates: fast HTTP -> stealth -> dynamic.
 */
export async function scrapeUrl(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const rawUrl = input.url as string;
  if (!rawUrl) return { success: false, error: 'url is required' };
  const url = normalizeUrl(rawUrl);

  const selector = input.selector as string | undefined;
  const format = (input.format as string) || 'markdown';

  try {
    const service = getService(ctx);
    const result = await autoEscalateFetch(service, url, { selector });

    if (result.error || !result.response) {
      return { success: false, error: result.error || 'Fetch failed' };
    }

    const content = cleanContent(result.response, format);

    return {
      success: true,
      data: {
        content,
        title: result.response.title,
        url: result.response.url,
        status: result.response.status,
        tier: result.tier,
        escalated: result.escalated,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Scraping failed',
    };
  }
}

/**
 * Fetch multiple URLs and return combined results.
 */
export async function scrapeBulk(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const rawUrls = input.urls as string[];
  if (!rawUrls || rawUrls.length === 0) return { success: false, error: 'urls is required (array of strings)' };
  const urls = rawUrls.slice(0, 20).map(normalizeUrl);

  const selector = input.selector as string | undefined;
  const format = (input.format as string) || 'markdown';

  try {
    const service = getService(ctx);
    const responses = await service.bulkFetch(urls, { selector });

    const results = responses.map(r => ({
      url: r.url,
      title: r.title,
      status: r.status,
      content: r.error ? `Error: ${r.error}` : cleanContent(r, format),
      error: r.error,
    }));

    const successCount = results.filter(r => !r.error).length;

    return {
      success: true,
      data: {
        results,
        summary: `Fetched ${successCount}/${results.length} URLs successfully`,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Bulk scraping failed',
    };
  }
}

/**
 * Search the web and scrape top results for detailed info.
 * Uses stealth fetch for search engines.
 */
export async function scrapeSearch(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const query = input.query as string;
  if (!query) return { success: false, error: 'query is required' };

  const maxResults = Math.min((input.max_results as number) || 5, 10);

  try {
    const service = getService(ctx);

    // Search via Google using stealth fetch
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${maxResults}`;
    const searchResponse = await service.stealthFetch(searchUrl, {
      selector: 'a[href^="/url?q="], a[href^="http"]',
    });

    if (searchResponse.error) {
      return { success: false, error: `Search failed: ${searchResponse.error}` };
    }

    // Extract URLs from search results
    const urlPattern = /https?:\/\/[^\s"'<>]+/g;
    const allUrls = searchResponse.html.match(urlPattern) || [];

    // Filter out Google-internal URLs
    const resultUrls = allUrls
      .filter(u =>
        !u.includes('google.com') &&
        !u.includes('googleapis.com') &&
        !u.includes('gstatic.com') &&
        !u.includes('schema.org')
      )
      .filter((u, i, arr) => arr.indexOf(u) === i) // dedupe
      .slice(0, maxResults);

    if (resultUrls.length === 0) {
      return {
        success: true,
        data: { query, results: [], summary: 'No results found' },
      };
    }

    // Fetch each result page
    const responses = await service.bulkFetch(resultUrls);
    const results = responses.map(r => ({
      url: r.url,
      title: r.title,
      content: r.error ? null : cleanContent(r, 'markdown', 5000),
      error: r.error,
    }));

    return {
      success: true,
      data: {
        query,
        results,
        summary: `Found ${results.filter(r => !r.error).length} results for "${query}"`,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Search scraping failed',
    };
  }
}
