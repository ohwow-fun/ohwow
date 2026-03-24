/**
 * Shared constants for filesystem tools.
 */

/** Directories to skip during recursive traversal (in addition to guard blocks). */
export const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.ssh', '.gnupg', '.aws']);

export const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
export const MAX_DIR_ENTRIES = 500;
export const MAX_SEARCH_RESULTS = 50;
export const MAX_CONTENT_MATCHES = 100;
export const MAX_RECURSIVE_DEPTH = 3;
export const MAX_TRAVERSAL_DEPTH = 10;
