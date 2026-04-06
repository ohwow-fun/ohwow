/**
 * Path Normalizer — URL-to-Filepath Conversion
 *
 * Converts documentation site URLs into a clean filesystem structure.
 * Detects common path prefixes across all URLs and strips them so the
 * filesystem mirrors how you think about the docs, not how the URL
 * happens to be structured.
 *
 * Example: https://better-auth.com/docs/installation → /installation.md
 */

// ============================================================================
// MAIN API
// ============================================================================

/**
 * Normalize a batch of URLs into filesystem paths.
 * Detects and strips the common path prefix so files are as shallow as possible.
 *
 * @returns Map from source URL → relative file path (e.g., /api/charges/create.md)
 */
export function normalizeUrlsToPaths(urls: string[], baseUrl: string): Map<string, string> {
  if (urls.length === 0) return new Map();

  const baseOrigin = new URL(baseUrl).origin;
  const result = new Map<string, string>();

  // Extract path segments for each URL
  const pathEntries: Array<{ url: string; segments: string[] }> = [];
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      // Only process same-origin URLs
      if (parsed.origin !== baseOrigin) continue;

      // Strip query params and fragments
      const cleanPath = parsed.pathname;
      const segments = cleanPath
        .split('/')
        .filter((s) => s.length > 0);

      pathEntries.push({ url, segments });
    } catch {
      // Skip invalid URLs
    }
  }

  if (pathEntries.length === 0) return result;

  // Find common prefix
  const commonPrefix = detectCommonPrefix(pathEntries.map((e) => e.segments));

  for (const entry of pathEntries) {
    const stripped = entry.segments.slice(commonPrefix.length);
    const filePath = segmentsToFilePath(stripped);
    result.set(entry.url, filePath);
  }

  return result;
}

/**
 * Normalize a single URL against a known common prefix.
 * Used during incremental crawling when the prefix is already computed.
 */
export function normalizeUrlToPath(url: string, baseUrl: string, commonPrefixLength: number): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
    const stripped = segments.slice(commonPrefixLength);
    return segmentsToFilePath(stripped);
  } catch {
    // Fallback: hash the URL
    return `/page-${simpleHash(url)}.md`;
  }
}

/**
 * Extract the domain from a URL for use as namespace prefix.
 */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/[^a-zA-Z0-9.-]/g, '_');
  }
}

/**
 * Generate a stable namespace from a URL.
 * Used as the directory name under ~/.ohwow/docs/.
 */
export function urlToNamespace(url: string): string {
  try {
    const parsed = new URL(url);
    const domain = parsed.hostname.replace(/^www\./, '');
    // Include first path segment if it's meaningful (e.g., /docs, /api)
    const firstSegment = parsed.pathname.split('/').filter((s) => s.length > 0)[0];
    if (firstSegment && !['index.html', 'index.htm'].includes(firstSegment)) {
      return `${domain}-${firstSegment}`;
    }
    return domain;
  } catch {
    return url.replace(/[^a-zA-Z0-9.-]/g, '_');
  }
}

// ============================================================================
// INTERNALS
// ============================================================================

/**
 * Detect the common path prefix across all segment arrays.
 * Only considers segments that are identical across ALL paths.
 */
export function detectCommonPrefix(allSegments: string[][]): string[] {
  if (allSegments.length === 0) return [];
  if (allSegments.length === 1) {
    // Single URL: strip all but the last segment (the page itself)
    return allSegments[0].slice(0, Math.max(0, allSegments[0].length - 1));
  }

  const minLength = Math.min(...allSegments.map((s) => s.length));
  const prefix: string[] = [];

  for (let i = 0; i < minLength; i++) {
    const segmentAtI = allSegments[0][i];
    const allSame = allSegments.every((segs) => segs[i] === segmentAtI);
    if (allSame) {
      prefix.push(segmentAtI);
    } else {
      break;
    }
  }

  return prefix;
}

/** Convert remaining path segments to a .md file path */
function segmentsToFilePath(segments: string[]): string {
  if (segments.length === 0) {
    return '/index.md';
  }

  // Clean each segment
  const cleaned = segments.map((s) => {
    // Remove file extensions that aren't .md
    const ext = s.match(/\.[a-z]+$/i)?.[0] || '';
    if (ext && ext !== '.md') {
      s = s.slice(0, -ext.length);
    }
    return s;
  });

  const joined = '/' + cleaned.join('/');

  // If last segment looks like a directory (trailing slash in original, or no extension)
  // and doesn't already end with .md, add .md
  if (!joined.endsWith('.md')) {
    return joined + '.md';
  }
  return joined;
}

/** Simple string hash for fallback naming */
function simpleHash(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}
