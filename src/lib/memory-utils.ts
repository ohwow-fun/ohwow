/**
 * Memory quality utilities — deduplication, junk filtering, similarity.
 */

import { tokenize } from './rag/retrieval.js';

// ============================================================================
// NORMALIZATION
// ============================================================================

/** Normalize memory content for comparison: lowercase, trim, collapse whitespace. */
export function normalizeMemory(content: string): string {
  return content.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Simple string hash (FNV-1a 32-bit). Deterministic, fast, good enough for dedup. */
export function hashMemory(content: string): string {
  const normalized = normalizeMemory(content);
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ============================================================================
// SIMILARITY
// ============================================================================

/** Jaccard similarity between two strings using tokenized word sets. */
export function jaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));

  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }

  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ============================================================================
// JUNK FILTERING
// ============================================================================

const JUNK_PATTERNS: RegExp[] = [
  // API keys & secrets
  /\b(sk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9._-]{20,})\b/,
  /\b(password|passwd|secret|token)\s*[:=]\s*\S+/i,
  /\b(api[_-]?key|access[_-]?token)\s*[:=]\s*\S+/i,
  // System prompt fragments
  /^you are an? (ai|artificial|language model|helpful assistant)/i,
  /^as (an? )?(ai|language model|assistant)/i,
  /^i('m| am) (an? )?(ai|language model|chatbot)/i,
  // Pure URLs or file paths without context
  /^(https?:\/\/|\/[a-z])[^\s]*$/i,
  // JSON/code blobs masquerading as memories
  /^\s*[[{]/,
];

/** Returns true if the content looks like junk that shouldn't be stored. */
export function isJunkMemory(content: string): boolean {
  const trimmed = content.trim();

  // Too short (< 10 chars) or too long (> 500 chars)
  if (trimmed.length < 10 || trimmed.length > 500) return true;

  for (const pattern of JUNK_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  return false;
}

// ============================================================================
// PII DETECTION
// ============================================================================

const PII_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Email addresses
  { pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/, label: 'email' },
  // Phone numbers (international and US formats)
  { pattern: /\b(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/, label: 'phone' },
  // Social security numbers
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, label: 'ssn' },
  // Credit card numbers (basic Luhn-plausible patterns)
  { pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/, label: 'credit_card' },
  // IP addresses
  { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, label: 'ip_address' },
];

export interface PiiDetectionResult {
  hasPii: boolean;
  detectedTypes: string[];
}

/**
 * Scan memory content for potential PII patterns.
 * Returns which types of PII were detected (if any).
 */
export function detectPii(content: string): PiiDetectionResult {
  const detectedTypes: string[] = [];

  for (const { pattern, label } of PII_PATTERNS) {
    if (pattern.test(content)) {
      detectedTypes.push(label);
    }
  }

  return {
    hasPii: detectedTypes.length > 0,
    detectedTypes,
  };
}

// ============================================================================
// CONFIDENTIALITY CLASSIFICATION
// ============================================================================

export type ConfidentialityLevel = 'public' | 'workspace' | 'confidential' | 'secret';

/**
 * Tool name → default confidentiality level mapping.
 * Mirrors the taint tracker labels from ohwow.fun's safety system.
 */
const TOOL_CONFIDENTIALITY: Record<string, ConfidentialityLevel> = {
  // Secret: credentials, API keys
  read_env_file: 'secret',
  get_api_keys: 'secret',
  get_credentials: 'secret',
  // Confidential: personal/customer data
  gmail_read_emails: 'confidential',
  gmail_search_emails: 'confidential',
  search_contacts: 'confidential',
  list_contacts: 'confidential',
  read_file: 'confidential',
  // Workspace: internal business data (default)
  create_task: 'workspace',
  search_tasks: 'workspace',
  // Public: web-sourced data
  web_search: 'public',
  browser_navigate: 'public',
  browser_screenshot: 'public',
  scrape_url: 'public',
  search_web: 'public',
};

/**
 * Classify the confidentiality level of a memory based on which tools
 * were used during the task that generated it.
 *
 * Takes the highest (most restrictive) confidentiality level from all tools used.
 * If no tools are provided, defaults to 'workspace'.
 */
export function classifyMemoryConfidentiality(
  toolsUsed: string[],
  memoryContent?: string,
): ConfidentialityLevel {
  let maxLevel: ConfidentialityLevel = 'workspace';

  const levelOrder: Record<ConfidentialityLevel, number> = {
    public: 0,
    workspace: 1,
    confidential: 2,
    secret: 3,
  };

  for (const tool of toolsUsed) {
    const toolLevel = TOOL_CONFIDENTIALITY[tool];
    if (toolLevel && levelOrder[toolLevel] > levelOrder[maxLevel]) {
      maxLevel = toolLevel;
    }
  }

  // If PII detected in content, bump to at least 'confidential'
  if (memoryContent) {
    const pii = detectPii(memoryContent);
    if (pii.hasPii && levelOrder[maxLevel] < levelOrder['confidential']) {
      maxLevel = 'confidential';
    }
  }

  return maxLevel;
}

// ============================================================================
// SYNC POLICY FILTERING
// ============================================================================

export type MemorySyncPolicy = 'none' | 'behavioral' | 'full';

const BEHAVIORAL_MEMORY_TYPES = new Set([
  'skill',
  'feedback_positive',
  'feedback_negative',
  'procedure',
  'efficiency',
]);

/**
 * Check if a memory is eligible for sync based on the agent's sync policy
 * and the memory's properties.
 */
export function isMemorySyncable(
  memory: {
    memoryType: string;
    confidentialityLevel: ConfidentialityLevel;
    isLocalOnly: boolean;
  },
  syncPolicy: MemorySyncPolicy,
): boolean {
  // Hard blocks
  if (syncPolicy === 'none') return false;
  if (memory.isLocalOnly) return false;
  if (memory.confidentialityLevel === 'secret') return false;

  // Behavioral policy: only sync behavioral memory types
  if (syncPolicy === 'behavioral') {
    return BEHAVIORAL_MEMORY_TYPES.has(memory.memoryType);
  }

  // Full policy: sync all types except secret confidentiality
  return true;
}

// ============================================================================
// DEDUP HELPERS
// ============================================================================

export interface ExistingMemory {
  id: string;
  content: string;
}

export interface DedupResult {
  action: 'insert' | 'update_existing' | 'skip';
  existingId?: string;
}

const SIMILARITY_THRESHOLD = 0.85;

/**
 * Check if a new memory should be inserted, skipped, or should update an existing one.
 * - Exact normalized match → skip
 * - Jaccard > 0.85 with an existing memory → update existing (refresh updated_at)
 * - Otherwise → insert
 */
export function checkDedup(newContent: string, existingMemories: ExistingMemory[]): DedupResult {
  const normalizedNew = normalizeMemory(newContent);

  for (const existing of existingMemories) {
    const normalizedExisting = normalizeMemory(existing.content);

    // Exact match
    if (normalizedNew === normalizedExisting) {
      return { action: 'skip', existingId: existing.id };
    }

    // Semantic similarity
    if (jaccardSimilarity(newContent, existing.content) >= SIMILARITY_THRESHOLD) {
      return { action: 'update_existing', existingId: existing.id };
    }
  }

  return { action: 'insert' };
}
