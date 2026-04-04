/**
 * Smart text chunker for the RAG pipeline.
 *
 * Splits text into overlapping, structure-aware chunks that preserve
 * markdown header context and never break inside fenced code blocks.
 */

// ============================================================================
// TYPES
// ============================================================================

export interface ChunkOptions {
  targetChars?: number;   // default 4000
  overlapChars?: number;  // default 200
  maxChunks?: number;     // default 50 (safety limit)
}

export interface Chunk {
  content: string;
  tokenCount: number;
  keywords: string[];
  headerPrefix?: string;   // markdown header context (e.g. "## API Reference > ### Authentication")
  overlapPrefix?: string;  // overlap text from previous chunk (if any)
}

// ============================================================================
// STOP WORDS & KEYWORD EXTRACTION
// ============================================================================

export const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
  'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'it', 'its', 'this', 'that', 'not', 'you', 'they',
]);

export function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

  const freq = new Map<string, number>();
  for (const word of words) {
    freq.set(word, (freq.get(word) || 0) + 1);
  }

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
}

// ============================================================================
// CODE BLOCK PROTECTION
// ============================================================================

/** Placeholder that won't appear in real text */
const CODE_BLOCK_SENTINEL = '\x00CODE_BLOCK\x00';

interface ProtectedBlocks {
  text: string;
  blocks: string[];
}

/**
 * Replace fenced code blocks with sentinels so header splitting doesn't
 * break inside them. Returns the modified text and the extracted blocks.
 */
function protectCodeBlocks(text: string): ProtectedBlocks {
  const blocks: string[] = [];
  const replaced = text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, (match) => {
    blocks.push(match);
    return `${CODE_BLOCK_SENTINEL}${blocks.length - 1}${CODE_BLOCK_SENTINEL}`;
  });
  return { text: replaced, blocks };
}

/** Restore code block sentinels with their original content. */
function restoreCodeBlocks(text: string, blocks: string[]): string {
  return text.replace(
    new RegExp(`${CODE_BLOCK_SENTINEL}(\\d+)${CODE_BLOCK_SENTINEL}`, 'g'),
    (_match, idx) => blocks[parseInt(idx, 10)] ?? '',
  );
}

// ============================================================================
// SECTION SPLITTING
// ============================================================================

interface Section {
  header?: string;        // raw header line (e.g. "## API Reference")
  headerPrefix: string;   // breadcrumb (e.g. "## API Reference > ### Authentication")
  body: string;           // section body text (with code blocks restored)
}

/**
 * Split text into sections at markdown header boundaries.
 * Tracks cumulative header breadcrumbs by depth.
 */
function splitSections(text: string, blocks: string[]): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  // Track headers by level (1-6) for breadcrumb building
  const headerStack: Map<number, string> = new Map();
  let currentHeader: string | undefined;
  let currentBodyLines: string[] = [];

  function flushSection(): void {
    const bodyText = restoreCodeBlocks(currentBodyLines.join('\n'), blocks).trim();
    if (bodyText.length > 0 || currentHeader) {
      const breadcrumb = buildBreadcrumb(headerStack);
      sections.push({
        header: currentHeader,
        headerPrefix: breadcrumb,
        body: bodyText,
      });
    }
  }

  function buildBreadcrumb(stack: Map<number, string>): string {
    const sorted = Array.from(stack.entries())
      .sort(([a], [b]) => a - b)
      .map(([, h]) => h);
    return sorted.join(' > ');
  }

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      // Flush previous section
      flushSection();

      const level = headerMatch[1].length;
      const headerLine = line.trim();

      // Clear deeper headers when a higher-level header appears
      for (const [lvl] of headerStack) {
        if (lvl >= level) headerStack.delete(lvl);
      }
      headerStack.set(level, headerLine);

      currentHeader = headerLine;
      currentBodyLines = [];
    } else {
      currentBodyLines.push(line);
    }
  }

  // Flush final section
  flushSection();

  return sections;
}

// ============================================================================
// PARAGRAPH ACCUMULATION
// ============================================================================

/**
 * Split section body into paragraphs, accumulating them into chunks
 * that respect targetChars. Code blocks are treated as atomic units.
 */
function accumulateParagraphs(body: string, targetChars: number): string[] {
  if (body.length === 0) return [];

  const paragraphs = body.split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length === 0) return [];

  const result: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    // If a single paragraph exceeds target, flush current and push it alone
    if (paragraph.length > targetChars) {
      if (current.length > 0) {
        result.push(current);
        current = '';
      }
      result.push(paragraph);
      continue;
    }

    const combined = current + (current ? '\n\n' : '') + paragraph;

    if (combined.length > targetChars && current.length > 0) {
      result.push(current);
      current = paragraph;
    } else {
      current = combined;
    }
  }

  if (current.length > 0) {
    result.push(current);
  }

  return result;
}

// ============================================================================
// MAIN CHUNKER
// ============================================================================

export function chunkText(text: string, options?: ChunkOptions): Chunk[] {
  const targetChars = options?.targetChars ?? 4000;
  const overlapChars = options?.overlapChars ?? 200;
  const maxChunks = options?.maxChunks ?? 50;

  // Empty / whitespace-only text
  if (!text || text.trim().length === 0) return [];

  // Small text shortcut: return as single chunk
  if (text.length <= targetChars * 1.2) {
    const trimmed = text.trim();
    return [{
      content: trimmed,
      tokenCount: Math.ceil(trimmed.length / 4),
      keywords: extractKeywords(trimmed),
    }];
  }

  // 1. Protect code blocks from being split
  const { text: protectedText, blocks } = protectCodeBlocks(text);

  // 2. Split into sections by markdown headers
  const sections = splitSections(protectedText, blocks);

  // 3. Accumulate paragraphs within each section, then build chunks
  const rawChunks: Array<{ content: string; headerPrefix: string }> = [];

  for (const section of sections) {
    const accumulated = accumulateParagraphs(section.body, targetChars);

    if (accumulated.length === 0) continue;

    for (const content of accumulated) {
      rawChunks.push({
        content,
        headerPrefix: section.headerPrefix,
      });
    }
  }

  // 4. Apply overlap between consecutive chunks and build final output
  const chunks: Chunk[] = [];
  let previousContent = '';

  for (let i = 0; i < rawChunks.length && chunks.length < maxChunks; i++) {
    const raw = rawChunks[i];
    let overlapPrefix: string | undefined;
    let content = raw.content;

    if (i > 0 && overlapChars > 0 && previousContent.length > 0) {
      const overlapText = previousContent.slice(-overlapChars).trim();
      if (overlapText.length > 0) {
        overlapPrefix = overlapText;
        content = `[...] ${overlapText}\n\n${content}`;
      }
    }

    previousContent = raw.content; // Use raw content (without overlap) for next chunk's overlap

    const trimmed = content.trim();
    if (trimmed.length === 0) continue;

    chunks.push({
      content: trimmed,
      tokenCount: Math.ceil(trimmed.length / 4),
      keywords: extractKeywords(trimmed),
      headerPrefix: raw.headerPrefix || undefined,
      overlapPrefix,
    });
  }

  return chunks;
}
