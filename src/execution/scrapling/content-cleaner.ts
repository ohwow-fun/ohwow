/**
 * Content Cleaner
 *
 * Post-processes Scrapling HTML responses into clean, truncated content
 * suitable for Claude's context window.
 */

import type { ScraplingResponse } from './scrapling-types.js';

const MAX_CONTENT_LENGTH = 50000; // ~50K chars
const MAX_HTML_FOR_REGEX = 500_000; // 500KB — beyond this, skip regex-heavy conversion

/**
 * Clean and format a Scrapling response for return to Claude.
 */
export function cleanContent(
  response: ScraplingResponse,
  format: string = 'markdown',
  maxLength: number = MAX_CONTENT_LENGTH,
): string {
  // If CSS-selected elements were returned, use those directly
  if (response.selected && response.selected.length > 0) {
    const selectedContent = response.selected.join('\n\n');
    return truncate(selectedContent, maxLength);
  }

  const html = response.html;
  if (!html) return '(empty page)';

  // Guard: huge HTML would hang on regex passes — fast-path to plain text
  if (html.length > MAX_HTML_FOR_REGEX) {
    return truncate(htmlToText(html.slice(0, MAX_HTML_FOR_REGEX)), maxLength);
  }

  switch (format) {
    case 'html':
      return truncate(html, maxLength);
    case 'text':
      return truncate(htmlToText(html), maxLength);
    case 'markdown':
    default:
      return truncate(htmlToMarkdown(html), maxLength);
  }
}

/**
 * Strip HTML to plain text.
 */
function htmlToText(html: string): string {
  let text = html;

  // Remove script/style/nav/footer/header content
  text = text.replace(/<(script|style|nav|footer|header|aside|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Remove cookie banners and ad containers (common class patterns)
  text = text.replace(/<[^>]*(cookie|consent|gdpr|banner|popup|modal|overlay|advertisement|ad-)[^>]*>[\s\S]*?<\/[^>]+>/gi, '');

  // Convert block elements to newlines
  text = text.replace(/<(br|hr|p|div|h[1-6]|li|tr|section|article)[^>]*\/?>/gi, '\n');

  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common entities
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text;
}

/**
 * Convert HTML to basic markdown.
 * Not a full converter, but good enough for content extraction.
 */
function htmlToMarkdown(html: string): string {
  let md = html;

  // Remove non-content sections
  md = md.replace(/<(script|style|nav|footer|header|aside|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
  md = md.replace(/<[^>]*(cookie|consent|gdpr|banner|popup|modal|overlay|advertisement|ad-)[^>]*>[\s\S]*?<\/[^>]+>/gi, '');

  // Try to extract main content area
  const mainMatch = md.match(/<(main|article|\[role="main"\])[^>]*>([\s\S]*?)<\/\1>/i);
  if (mainMatch) {
    md = mainMatch[2];
  }

  // Headings
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n');
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n');

  // Links
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // Bold/italic
  md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');

  // Code
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');

  // Lists
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  md = md.replace(/<\/?[ou]l[^>]*>/gi, '\n');

  // Paragraphs and breaks
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
  md = md.replace(/<br[^>]*\/?>/gi, '\n');
  md = md.replace(/<hr[^>]*\/?>/gi, '\n---\n');

  // Images (alt text)
  md = md.replace(/<img[^>]*alt="([^"]*)"[^>]*\/?>/gi, '![$1]');

  // Tables (basic)
  md = md.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, '$1\n');
  md = md.replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, '| $1 ');

  // Remove remaining tags
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
  md = md.trim();

  return md;
}

/** Truncate content to max length with a notice. */
function truncate(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + '\n\n[Content truncated. Original length: ' + content.length + ' chars]';
}
