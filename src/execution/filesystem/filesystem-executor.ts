/**
 * Filesystem Tool Executor
 * Handles execution of filesystem tool calls with security validation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../lib/logger.js';
import type { FileAccessGuard } from './filesystem-guard.js';
import { expandTilde } from './filesystem-guard.js';
import { PermissionDeniedError, resolveSuggestedPath } from './permission-error.js';
import {
  SKIP_DIRECTORIES,
  MAX_FILE_SIZE,
  MAX_DIR_ENTRIES,
  MAX_SEARCH_RESULTS,
  MAX_CONTENT_MATCHES,
  MAX_RECURSIVE_DEPTH,
  MAX_TRAVERSAL_DEPTH,
} from './constants.js';
import { detectRipgrep, rgSearchContent, rgSearchFiles } from './rg-backend.js';

/**
 * Simple glob matching (supports *, **, and ? wildcards).
 * No external dependency needed for basic patterns like "*.csv" or "report*".
 */
export function globMatch(filename: string, pattern: string): boolean {
  // Convert glob pattern to regex
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        regexStr += '.*';
        i += 2;
        if (pattern[i] === '/' || pattern[i] === path.sep) i++; // skip separator after **
        continue;
      }
      regexStr += '[^/]*';
    } else if (c === '?') {
      regexStr += '[^/]';
    } else if (c === '.') {
      regexStr += '\\.';
    } else {
      regexStr += c.replace(/[{}()[\]\\+^$|]/g, '\\$&');
    }
    i++;
  }
  try {
    return new RegExp(`^${regexStr}$`, 'i').test(filename);
  } catch {
    return filename.toLowerCase().includes(pattern.toLowerCase());
  }
}

// Binary file detection: check for null bytes in first 8KB
function isBinaryContent(buffer: Buffer): boolean {
  const check = buffer.subarray(0, Math.min(buffer.length, 8192));
  return check.includes(0);
}

// ============================================================================
// TOOL RESULT TYPE
// ============================================================================

export interface FilesystemToolResult {
  content: string;
  is_error?: boolean;
}

/**
 * Check a path against the guard. On deny, throw PermissionDeniedError so
 * the ReAct loop unwinds and the task lands in needs_approval with a
 * structured permission request. On allow, return normally.
 */
function enforceGuard(
  guard: FileAccessGuard,
  rawPath: string,
  toolName: string,
): void {
  const check = guard.isAllowed(rawPath);
  if (check.allowed) return;
  const suggestedExact = resolveSuggestedPath(rawPath);
  throw new PermissionDeniedError({
    toolName,
    attemptedPath: rawPath,
    suggestedExact,
    suggestedParent: path.dirname(suggestedExact),
    guardReason: check.reason ?? 'Path is outside the allowed directories.',
  });
}

// ============================================================================
// TOOL HANDLERS
// ============================================================================

async function executeListDirectory(
  guard: FileAccessGuard,
  input: Record<string, unknown>,
): Promise<FilesystemToolResult> {
  const rawPath = (input.path as string | undefined) ?? '.';
  const dirPath = path.resolve(expandTilde(rawPath));

  enforceGuard(guard, rawPath, 'local_list_directory');

  const recursive = input.recursive === true;
  const pattern = input.pattern as string | undefined;

  try {
    const entries = await listDir(dirPath, recursive ? MAX_RECURSIVE_DEPTH : 0, pattern, 0, { count: 0 });
    if (entries.length === 0) {
      return { content: 'Directory is empty or no files match the pattern.' };
    }
    return { content: entries.join('\n') };
  } catch (err) {
    return { content: `Error reading directory: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true };
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `(${bytes}B)`;
  if (bytes < 1024 * 1024) return `(${(bytes / 1024).toFixed(1)}KB)`;
  return `(${(bytes / 1024 / 1024).toFixed(1)}MB)`;
}

async function listDir(
  dirPath: string,
  maxDepth: number,
  pattern?: string,
  currentDepth = 0,
  totalEntries = { count: 0 },
): Promise<string[]> {
  const entries: string[] = [];
  const items = await fs.promises.readdir(dirPath, { withFileTypes: true });

  for (const item of items) {
    if (totalEntries.count >= MAX_DIR_ENTRIES) break;

    const fullPath = path.join(dirPath, item.name);

    if (pattern && !item.isDirectory()) {
      if (!globMatch(item.name, pattern)) continue;
    }

    if (item.isFile()) {
      let sizeStr = '';
      try {
        const stat = await fs.promises.stat(fullPath);
        sizeStr = formatSize(stat.size).padEnd(10);
      } catch {
        sizeStr = '          ';
      }
      entries.push(`       ${sizeStr} ${fullPath}`);
    } else {
      entries.push(`[DIR]            ${fullPath}`);
    }

    totalEntries.count++;

    if (item.isDirectory() && currentDepth < maxDepth) {
      try {
        const subEntries = await listDir(fullPath, maxDepth, pattern, currentDepth + 1, totalEntries);
        entries.push(...subEntries);
      } catch {
        // Skip inaccessible directories
      }
    }
  }

  return entries;
}

async function executeReadFile(
  guard: FileAccessGuard,
  input: Record<string, unknown>,
): Promise<FilesystemToolResult> {
  const rawPath = input.path as string;
  if (!rawPath) return { content: 'Error: path is required', is_error: true };
  const filePath = path.resolve(expandTilde(rawPath));

  enforceGuard(guard, rawPath, 'local_read_file');

  try {
    const stat = await fs.promises.stat(filePath);

    if (stat.isDirectory()) {
      const listing = await executeListDirectory(guard, { path: rawPath });
      if (listing.is_error) {
        return listing;
      }
      return {
        content: `[Note: "${rawPath}" is a directory. Showing directory listing instead. Use local_list_directory for directories next time.]\n\n${listing.content}`,
      };
    }

    if (stat.size > MAX_FILE_SIZE) {
      return { content: `Error: file is ${(stat.size / 1024 / 1024).toFixed(1)}MB, exceeding the 2MB limit.`, is_error: true };
    }

    const buffer = await fs.promises.readFile(filePath);

    if (isBinaryContent(buffer)) {
      return {
        content: `[Binary file: ${path.basename(filePath)}, ${(stat.size / 1024).toFixed(1)}KB, base64-encoded]\n\n${buffer.toString('base64')}`,
      };
    }

    return { content: buffer.toString('utf-8') };
  } catch (err) {
    return { content: `Error reading file: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true };
  }
}

async function executeSearchFiles(
  guard: FileAccessGuard,
  input: Record<string, unknown>,
): Promise<FilesystemToolResult> {
  const pattern = input.pattern as string;
  if (!pattern) return { content: 'Error: pattern is required', is_error: true };

  const fileType = input.type as string | undefined;
  const allowedPaths = guard.getAllowedPaths();
  const start = Date.now();

  // Try ripgrep backend first
  if (detectRipgrep()) {
    const result = await rgSearchFiles({
      pattern,
      paths: allowedPaths,
      type: fileType,
      maxResults: MAX_SEARCH_RESULTS,
    });
    logger.debug({ tool: 'local_search_files', durationMs: Date.now() - start }, 'filesystem search complete');
    return result;
  }

  // JS fallback
  const results: string[] = [];

  for (const dir of allowedPaths) {
    if (results.length >= MAX_SEARCH_RESULTS) break;
    try {
      await searchFilesRecursive(dir, pattern, results, 0, fileType);
    } catch {
      // Skip inaccessible directories
    }
  }

  logger.debug({ tool: 'local_search_files', durationMs: Date.now() - start, matchCount: results.length }, 'filesystem search complete');

  if (results.length === 0) {
    return { content: `No files matching "${pattern}" found in allowed directories.` };
  }

  return { content: results.slice(0, MAX_SEARCH_RESULTS).join('\n') };
}

async function searchFilesRecursive(
  dirPath: string,
  pattern: string,
  results: string[],
  depth: number,
  fileType?: string,
): Promise<void> {
  if (results.length >= MAX_SEARCH_RESULTS || depth > MAX_TRAVERSAL_DEPTH) return;

  const items = await fs.promises.readdir(dirPath, { withFileTypes: true });

  for (const item of items) {
    if (results.length >= MAX_SEARCH_RESULTS) return;

    // Skip blocked directories
    if (item.isDirectory() && SKIP_DIRECTORIES.has(item.name)) {
      continue;
    }

    const fullPath = path.join(dirPath, item.name);

    if (item.isDirectory()) {
      try {
        await searchFilesRecursive(fullPath, pattern, results, depth + 1, fileType);
      } catch {
        // Skip inaccessible
      }
    } else if (globMatch(item.name, pattern)) {
      if (fileType && !item.name.endsWith(`.${fileType}`)) continue;
      results.push(fullPath);
    }
  }
}

interface ContentSearchOpts {
  matcher: (line: string) => boolean;
  filePattern?: string;
  contextLines: number;
  fileType?: string;
  outputMode: 'content' | 'files' | 'count';
}

let loggedBackend = false;

async function executeSearchContent(
  guard: FileAccessGuard,
  input: Record<string, unknown>,
): Promise<FilesystemToolResult> {
  const query = input.query as string;
  if (!query) return { content: 'Error: query is required', is_error: true };

  const filePattern = input.pattern as string | undefined;
  const useRegex = input.regex === true;
  const contextLines = typeof input.context === 'number' ? Math.min(Math.max(0, input.context), 10) : 0;
  const searchPath = input.path as string | undefined;
  const caseSensitive = input.case_sensitive === true;
  const fileType = input.type as string | undefined;
  const outputMode = (input.output_mode as 'content' | 'files' | 'count') || 'content';

  let searchRoots: string[];
  if (searchPath) {
    enforceGuard(guard, searchPath, 'local_search_content');
    searchRoots = [path.resolve(expandTilde(searchPath))];
  } else {
    searchRoots = guard.getAllowedPaths();
  }

  const start = Date.now();

  // Try ripgrep backend first
  const rgBin = detectRipgrep();
  if (rgBin) {
    if (!loggedBackend) {
      logger.debug('filesystem search using ripgrep backend');
      loggedBackend = true;
    }
    const result = await rgSearchContent({
      query,
      paths: searchRoots,
      pattern: filePattern,
      regex: useRegex,
      caseSensitive,
      context: contextLines,
      type: fileType,
      outputMode,
      maxResults: MAX_CONTENT_MATCHES,
    });
    logger.debug({ tool: 'local_search_content', durationMs: Date.now() - start }, 'filesystem search complete');
    return result;
  }

  if (!loggedBackend) {
    logger.debug('filesystem search using JS fallback backend');
    loggedBackend = true;
  }

  // JS fallback
  const regexFlags = caseSensitive ? '' : 'i';
  let matcher: (line: string) => boolean;
  if (useRegex) {
    try {
      const re = new RegExp(query, regexFlags);
      matcher = (line) => re.test(line);
    } catch {
      return { content: `Error: invalid regex pattern: ${query}`, is_error: true };
    }
  } else if (caseSensitive) {
    matcher = (line) => line.includes(query);
  } else {
    const queryLower = query.toLowerCase();
    matcher = (line) => line.toLowerCase().includes(queryLower);
  }

  const opts: ContentSearchOpts = { matcher, filePattern, contextLines, fileType, outputMode };
  const results: string[] = [];

  for (const root of searchRoots) {
    if (results.length >= MAX_CONTENT_MATCHES) break;
    try {
      const stat = await fs.promises.stat(root);
      if (stat.isFile()) {
        await searchContentInFile(root, results, opts);
      } else {
        await searchContentRecursive(root, results, 0, opts);
      }
    } catch {
      // Skip inaccessible
    }
  }

  const durationMs = Date.now() - start;
  logger.debug({ tool: 'local_search_content', durationMs, matchCount: results.length }, 'filesystem search complete');

  if (results.length === 0) {
    return { content: `No matches for "${query}" found in allowed files.` };
  }

  return { content: results.join('\n') };
}

async function searchContentInFile(
  filePath: string,
  results: string[],
  opts: ContentSearchOpts,
): Promise<void> {
  if (results.length >= MAX_CONTENT_MATCHES) return;
  if (opts.filePattern && !globMatch(path.basename(filePath), opts.filePattern)) return;
  if (opts.fileType && !filePath.endsWith(`.${opts.fileType}`)) return;

  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_FILE_SIZE) return;

    const buffer = await fs.promises.readFile(filePath);
    if (isBinaryContent(buffer)) return;

    const content = buffer.toString('utf-8');
    const lines = content.split('\n');

    if (opts.outputMode === 'files') {
      for (let i = 0; i < lines.length; i++) {
        if (opts.matcher(lines[i])) {
          results.push(filePath);
          return;
        }
      }
      return;
    }

    if (opts.outputMode === 'count') {
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        if (opts.matcher(lines[i])) count++;
      }
      if (count > 0) {
        results.push(`${filePath}:${count}`);
      }
      return;
    }

    // Default: content mode
    if (opts.contextLines === 0) {
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= MAX_CONTENT_MATCHES) return;
        if (opts.matcher(lines[i])) {
          results.push(`${filePath}:${i + 1}: ${lines[i].trimEnd()}`);
        }
      }
    } else {
      const matchIndices: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (opts.matcher(lines[i])) matchIndices.push(i);
      }

      let lastEmittedLine = -1;
      for (let m = 0; m < matchIndices.length; m++) {
        if (results.length >= MAX_CONTENT_MATCHES) return;
        const start = Math.max(0, matchIndices[m] - opts.contextLines);
        const end = Math.min(lines.length - 1, matchIndices[m] + opts.contextLines);

        if (lastEmittedLine >= 0 && start > lastEmittedLine + 1) {
          results.push('---');
        }

        const from = Math.max(start, lastEmittedLine + 1);
        for (let j = from; j <= end; j++) {
          if (results.length >= MAX_CONTENT_MATCHES) return;
          results.push(`${filePath}:${j + 1}: ${lines[j].trimEnd()}`);
        }
        lastEmittedLine = end;
      }
    }
  } catch {
    // Skip unreadable files
  }
}

async function searchContentRecursive(
  dirPath: string,
  results: string[],
  depth: number,
  opts: ContentSearchOpts,
): Promise<void> {
  if (results.length >= MAX_CONTENT_MATCHES || depth > MAX_TRAVERSAL_DEPTH) return;

  const items = await fs.promises.readdir(dirPath, { withFileTypes: true });

  for (const item of items) {
    if (results.length >= MAX_CONTENT_MATCHES) return;

    if (item.isDirectory() && SKIP_DIRECTORIES.has(item.name)) {
      continue;
    }

    const fullPath = path.join(dirPath, item.name);

    if (item.isDirectory()) {
      try {
        await searchContentRecursive(fullPath, results, depth + 1, opts);
      } catch {
        // Skip inaccessible
      }
    } else {
      await searchContentInFile(fullPath, results, opts);
    }
  }
}

async function executeWriteFile(
  guard: FileAccessGuard,
  input: Record<string, unknown>,
): Promise<FilesystemToolResult> {
  const rawPath = input.path as string;
  const content = input.content as string;
  if (!rawPath) return { content: 'Error: path is required', is_error: true };
  if (content === undefined || content === null) return { content: 'Error: content is required', is_error: true };
  const filePath = path.resolve(expandTilde(rawPath));

  enforceGuard(guard, rawPath, 'local_write_file');

  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, content, 'utf-8');
    return { content: `Written ${Buffer.byteLength(content, 'utf-8')} bytes to ${filePath}` };
  } catch (err) {
    return { content: `Error writing file: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true };
  }
}

async function executeEditFile(
  guard: FileAccessGuard,
  input: Record<string, unknown>,
): Promise<FilesystemToolResult> {
  const rawPath = input.path as string;
  const oldString = input.old_string as string;
  const newString = input.new_string as string;
  if (!rawPath) return { content: 'Error: path is required', is_error: true };
  if (!oldString) return { content: 'Error: old_string is required', is_error: true };
  if (newString === undefined || newString === null) return { content: 'Error: new_string is required', is_error: true };
  const filePath = path.resolve(expandTilde(rawPath));

  enforceGuard(guard, rawPath, 'local_edit_file');

  try {
    const fileContent = await fs.promises.readFile(filePath, 'utf-8');

    // Count occurrences using split (avoids regex escaping issues)
    const occurrences = fileContent.split(oldString).length - 1;
    if (occurrences === 0) {
      return { content: 'Error: old_string not found in file', is_error: true };
    }
    if (occurrences > 1) {
      return { content: `Error: old_string matches ${occurrences} times — provide more context to make it unique`, is_error: true };
    }

    const updated = fileContent.replace(oldString, newString);
    await fs.promises.writeFile(filePath, updated, 'utf-8');
    return { content: `Edit applied to ${filePath}` };
  } catch (err) {
    return { content: `Error editing file: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true };
  }
}

// ============================================================================
// DISPATCHER
// ============================================================================

export async function executeFilesystemTool(
  guard: FileAccessGuard,
  toolName: string,
  input: Record<string, unknown>,
): Promise<FilesystemToolResult> {
  switch (toolName) {
    case 'local_list_directory':
      return executeListDirectory(guard, input);
    case 'local_read_file':
      return executeReadFile(guard, input);
    case 'local_search_files':
      return executeSearchFiles(guard, input);
    case 'local_search_content':
      return executeSearchContent(guard, input);
    case 'local_write_file':
      return executeWriteFile(guard, input);
    case 'local_edit_file':
      return executeEditFile(guard, input);
    default:
      return { content: `Unknown filesystem tool: ${toolName}`, is_error: true };
  }
}
