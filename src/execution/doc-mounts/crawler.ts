/**
 * Doc Site Crawler
 *
 * Crawls a documentation site and yields pages as CrawledPage objects.
 * Strategy: llms.txt → sitemap.xml → BFS spider.
 *
 * Uses the existing ScraplingService for fetching, and the existing
 * content-cleaner for HTML → markdown conversion.
 */

import { createHash } from 'crypto';
import type { ScraplingService } from '../scrapling/index.js';
import type { CrawledPage, CrawlOptions } from './types.js';
import { logger } from '../../lib/logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_MAX_PAGES = 500;
const MAX_PAGES_LIMIT = 2000;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_PAGE_TIMEOUT = 30;
/** Delay between page fetches to avoid rate limiting (ms) */
const CRAWL_DELAY_MS = 75;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// MAIN CRAWLER
// ============================================================================

/**
 * Crawl a documentation site and yield pages.
 *
 * Tries discovery strategies in order:
 * 1. llms.txt — standard AI-readable doc listing
 * 2. sitemap.xml — standard sitemap
 * 3. BFS spider — follow internal links from the base URL
 */
export async function* crawlDocSite(
  baseUrl: string,
  scraplingService: ScraplingService,
  options: CrawlOptions = {},
): AsyncGenerator<CrawledPage> {
  const maxPages = Math.min(options.maxPages ?? DEFAULT_MAX_PAGES, MAX_PAGES_LIMIT);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const pageTimeout = options.pageTimeout ?? DEFAULT_PAGE_TIMEOUT;

  // Normalize base URL
  const base = normalizeBaseUrl(baseUrl);
  const origin = new URL(base).origin;

  let pageCount = 0;

  // Strategy 1: Try llms.txt
  const llmsUrls = await tryLlmsTxt(base, scraplingService, pageTimeout);
  if (llmsUrls.length > 0) {
    logger.info({ count: llmsUrls.length, url: base }, '[doc-mount] Using llms.txt discovery');
    for (const url of llmsUrls) {
      if (pageCount >= maxPages) break;
      if (pageCount > 0) await delay(CRAWL_DELAY_MS);
      const page = await fetchAndConvert(url, scraplingService, pageTimeout);
      if (page) {
        pageCount++;
        yield page;
      }
    }
    return;
  }

  // Strategy 2: Try sitemap.xml
  const sitemapUrls = await trySitemap(base, scraplingService, pageTimeout);
  if (sitemapUrls.length > 0) {
    logger.info({ count: sitemapUrls.length, url: base }, '[doc-mount] Using sitemap.xml discovery');
    for (const url of sitemapUrls) {
      if (pageCount >= maxPages) break;
      if (pageCount > 0) await delay(CRAWL_DELAY_MS);
      const page = await fetchAndConvert(url, scraplingService, pageTimeout);
      if (page) {
        pageCount++;
        yield page;
      }
    }
    return;
  }

  // Strategy 3: BFS spider
  logger.info({ url: base, maxDepth, maxPages }, '[doc-mount] Using BFS spider discovery');
  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: base, depth: 0 }];

  while (queue.length > 0 && pageCount < maxPages) {
    const item = queue.shift()!;
    const normalized = normalizePageUrl(item.url);

    if (visited.has(normalized)) continue;
    visited.add(normalized);

    // Only follow same-origin links
    try {
      if (new URL(normalized).origin !== origin) continue;
    } catch {
      continue;
    }

    // Skip non-doc URLs
    if (isNonDocUrl(normalized)) continue;

    // Rate limiting delay
    if (pageCount > 0) await delay(CRAWL_DELAY_MS);

    // Fetch the page (get raw HTML for link extraction)
    let html: string | null = null;
    try {
      const response = await scraplingService.fetch(normalized, { timeout: pageTimeout });
      if (response.error || !response.html) continue;
      html = response.html;
    } catch {
      continue;
    }

    // Convert to markdown and yield
    const markdown = htmlToMarkdownBasic(html);
    if (markdown.length < 50) continue; // Skip near-empty pages

    const content = markdown;
    pageCount++;
    yield {
      sourceUrl: normalized,
      filePath: '', // Will be set by path normalizer in mount-manager
      content,
      contentHash: hashContent(content),
      tokenCount: estimateTokens(content),
      byteSize: Buffer.byteLength(content, 'utf-8'),
    };

    // Extract links for BFS (only if within depth limit)
    if (item.depth < maxDepth) {
      const links = extractInternalLinks(html, origin);
      for (const link of links) {
        if (!visited.has(normalizePageUrl(link))) {
          queue.push({ url: link, depth: item.depth + 1 });
        }
      }
    }
  }

  logger.info({ pageCount, url: base }, '[doc-mount] Crawl complete');
}

// ============================================================================
// DISCOVERY STRATEGIES
// ============================================================================

/** Try fetching llms.txt from the site root */
async function tryLlmsTxt(
  baseUrl: string,
  service: ScraplingService,
  timeout: number,
): Promise<string[]> {
  const origin = new URL(baseUrl).origin;
  const llmsUrl = `${origin}/llms.txt`;

  try {
    const response = await service.fetch(llmsUrl, { timeout });
    if (response.error || !response.html || response.status >= 400) return [];

    // llms.txt is plain text with URLs, one per line
    // Some formats have markdown links: [Title](url)
    const text = response.html.replace(/<[^>]+>/g, ''); // Strip any HTML wrapper
    const urls: string[] = [];

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Extract URL from markdown link syntax
      const mdMatch = trimmed.match(/\[.*?\]\((https?:\/\/[^\s)]+)\)/);
      if (mdMatch) {
        urls.push(mdMatch[1]);
        continue;
      }

      // Plain URL
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        urls.push(trimmed);
      }
    }

    return urls;
  } catch {
    return [];
  }
}

/** Try fetching and parsing sitemap.xml */
async function trySitemap(
  baseUrl: string,
  service: ScraplingService,
  timeout: number,
): Promise<string[]> {
  const origin = new URL(baseUrl).origin;
  const sitemapUrl = `${origin}/sitemap.xml`;

  try {
    const response = await service.fetch(sitemapUrl, { timeout });
    if (response.error || !response.html || response.status >= 400) return [];

    const xml = response.html;
    const urls: string[] = [];

    // Simple regex extraction of <loc> tags
    const locRegex = /<loc>\s*(.*?)\s*<\/loc>/gi;
    let match;
    while ((match = locRegex.exec(xml)) !== null) {
      const url = match[1].trim();
      if (url.startsWith('http')) {
        urls.push(url);
      }
    }

    // Filter to same-origin URLs that look like doc pages
    return urls.filter((url) => {
      try {
        const parsed = new URL(url);
        return parsed.origin === origin && !isNonDocUrl(url);
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

// ============================================================================
// HELPERS
// ============================================================================

/** Fetch a single page and convert to CrawledPage */
async function fetchAndConvert(
  url: string,
  service: ScraplingService,
  timeout: number,
): Promise<CrawledPage | null> {
  try {
    const response = await service.fetch(url, { timeout });
    if (response.error || !response.html) return null;

    const content = htmlToMarkdownBasic(response.html);
    if (content.length < 50) return null;

    return {
      sourceUrl: url,
      filePath: '', // Set by path normalizer
      content,
      contentHash: hashContent(content),
      tokenCount: estimateTokens(content),
      byteSize: Buffer.byteLength(content, 'utf-8'),
    };
  } catch {
    return null;
  }
}

/** Extract same-origin internal links from HTML */
function extractInternalLinks(html: string, origin: string): string[] {
  const links: string[] = [];
  const hrefRegex = /href="([^"]*?)"/gi;
  let match;

  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1].trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) {
      continue;
    }

    // Resolve relative URLs
    try {
      const resolved = new URL(href, origin).href;
      if (resolved.startsWith(origin)) {
        links.push(resolved);
      }
    } catch {
      // Skip invalid URLs
    }
  }

  return [...new Set(links)];
}

/** Check if a URL is unlikely to be a documentation page */
function isNonDocUrl(url: string): boolean {
  const lower = url.toLowerCase();
  const nonDocPatterns = [
    '/login', '/signup', '/register', '/auth/',
    '/cart', '/checkout', '/pricing',
    '/assets/', '/images/', '/img/', '/static/',
    '/cdn-cgi/', '/_next/', '/_nuxt/',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
    '.css', '.js', '.woff', '.woff2', '.ttf',
    '.pdf', '.zip', '.tar', '.gz',
    '/feed', '/rss',
  ];
  return nonDocPatterns.some((p) => lower.includes(p));
}

/** Normalize a base URL: ensure trailing slash, strip fragments */
function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

/** Normalize a page URL: strip fragment and trailing slash */
function normalizePageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    // Remove trailing slash (except for root)
    let path = parsed.pathname;
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    parsed.pathname = path;
    return parsed.href;
  } catch {
    return url;
  }
}

/** Basic HTML → markdown (replicates content-cleaner logic without import cycle) */
function htmlToMarkdownBasic(html: string): string {
  let md = html;

  // Remove non-content sections
  md = md.replace(/<(script|style|nav|footer|header|aside|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
  md = md.replace(/<[^>]*(cookie|consent|gdpr|banner|popup|modal|overlay|advertisement|ad-)[^>]*>[\s\S]*?<\/[^>]+>/gi, '');

  // Try to extract main content
  const mainMatch = md.match(/<(main|article)[^>]*>([\s\S]*?)<\/\1>/i);
  if (mainMatch) md = mainMatch[2];

  // Headings
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');

  // Code
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  // Links
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // Bold/italic
  md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');

  // Lists
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  md = md.replace(/<\/?[ou]l[^>]*>/gi, '\n');

  // Block elements
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
  md = md.replace(/<br[^>]*\/?>/gi, '\n');
  md = md.replace(/<hr[^>]*\/?>/gi, '\n---\n');

  // Tables
  md = md.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, '$1\n');
  md = md.replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, '| $1 ');

  // Strip remaining tags
  md = md.replace(/<[^>]+>/g, '');

  // Decode entities
  md = md
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");

  // Collapse whitespace
  md = md.replace(/[ \t]+/g, ' ');
  md = md.replace(/\n{3,}/g, '\n\n');

  return md.trim();
}

/** SHA-256 hash of content */
function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/** Rough token estimate (~4 chars per token) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
