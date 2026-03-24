/**
 * Scrapling Types
 * TypeScript types for Scrapling service requests and responses.
 */

export interface ScraplingFetchOptions {
  /** CSS selector to narrow returned content */
  selector?: string;
  /** Request timeout in seconds (default: 30) */
  timeout?: number;
  /** Proxy URL override for this request */
  proxy?: string;
  /** Run browser in headless mode (default: true) */
  headless?: boolean;
}

export type ScraplingBulkFetchOptions = ScraplingFetchOptions;

export interface ScraplingResponse {
  /** The URL that was fetched */
  url: string;
  /** HTTP status code (0 if connection failed) */
  status: number;
  /** Raw HTML content */
  html: string;
  /** Elements matching the CSS selector (if provided) */
  selected?: string[];
  /** Page title */
  title?: string;
  /** Error message if fetch failed */
  error?: string;
}

export interface ScraplingServiceConfig {
  /** Port for the Scrapling server (default: 8100) */
  port?: number;
  /** Auto-start on first use (default: true) */
  autoStart?: boolean;
  /** Default proxy for all requests */
  proxy?: string;
  /** List of proxies for rotation */
  proxies?: string[];
  /** Path to the scrapling-server directory */
  serverPath?: string;
}

export type FetchTier = 'fast' | 'stealth' | 'dynamic';

export interface ScraplingToolResult {
  success: boolean;
  content?: string;
  data?: unknown;
  error?: string;
  tier?: FetchTier;
  url?: string;
}
