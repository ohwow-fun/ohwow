/**
 * Ripgrep Backend
 * Uses `rg` (ripgrep) for fast file/content search when available.
 * Falls back gracefully when rg is not installed.
 */

import { execFileSync, execFile } from 'node:child_process';
import type { FilesystemToolResult } from './filesystem-executor.js';

// ============================================================================
// DETECTION
// ============================================================================

let rgPath: string | null | undefined; // undefined = not checked yet

/** Check if ripgrep is available. Returns the binary path or null. Result is cached. */
export function detectRipgrep(): string | null {
  if (rgPath !== undefined) return rgPath;
  try {
    execFileSync('rg', ['--version'], { timeout: 5000, stdio: 'pipe' });
    rgPath = 'rg';
  } catch {
    rgPath = null;
  }
  return rgPath;
}

/** Reset cached detection (for testing). */
export function resetRipgrepCache(): void {
  rgPath = undefined;
}

// ============================================================================
// CONTENT SEARCH
// ============================================================================

export interface RgSearchContentOpts {
  query: string;
  paths: string[];
  pattern?: string;       // glob pattern for file filtering
  regex?: boolean;        // treat query as regex (default: false = literal)
  caseSensitive?: boolean;
  context?: number;       // context lines (-C)
  type?: string;          // file type filter (e.g. "ts", "py")
  outputMode?: 'content' | 'files' | 'count';
  maxResults?: number;
}

/** Search file contents using ripgrep. */
export async function rgSearchContent(opts: RgSearchContentOpts): Promise<FilesystemToolResult> {
  const rg = detectRipgrep();
  if (!rg) return { content: 'ripgrep not available', is_error: true };

  const maxResults = opts.maxResults ?? 100;
  const args = buildContentArgs(opts, maxResults);

  // Append search paths
  args.push(...opts.paths);

  try {
    const output = await execRg(rg, args);
    if (!output.trim()) {
      return { content: `No matches for "${opts.query}" found.` };
    }
    return { content: output };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    // rg exits with code 1 when no matches found — not an error
    if (message.includes('exit code 1') || message.includes('No matches')) {
      return { content: `No matches for "${opts.query}" found.` };
    }
    return { content: `Search error: ${message}`, is_error: true };
  }
}

function buildContentArgs(opts: RgSearchContentOpts, maxResults: number): string[] {
  const args: string[] = [
    '--no-heading',
    '--line-number',
    '--color', 'never',
    '--max-count', String(maxResults),
    '--max-filesize', '2M',
  ];

  // Regex vs literal mode
  if (!opts.regex) {
    args.push('--fixed-strings');
  }

  // Case sensitivity
  if (opts.caseSensitive) {
    args.push('-s');
  } else {
    args.push('-i');
  }

  // Context lines
  if (opts.context && opts.context > 0) {
    args.push('-C', String(Math.min(opts.context, 10)));
  }

  // File type filter
  if (opts.type) {
    args.push('--type', opts.type);
  }

  // Glob pattern for file filtering
  if (opts.pattern) {
    args.push('--glob', opts.pattern);
  }

  // Output mode
  if (opts.outputMode === 'files') {
    args.push('--files-with-matches');
  } else if (opts.outputMode === 'count') {
    args.push('--count');
  }

  // The search pattern
  args.push('--', opts.query);

  return args;
}

// ============================================================================
// FILE SEARCH
// ============================================================================

export interface RgSearchFilesOpts {
  pattern: string;    // glob pattern for filename matching
  paths: string[];
  type?: string;      // file type filter
  maxResults?: number;
}

/** Search for files by name pattern using ripgrep. */
export async function rgSearchFiles(opts: RgSearchFilesOpts): Promise<FilesystemToolResult> {
  const rg = detectRipgrep();
  if (!rg) return { content: 'ripgrep not available', is_error: true };

  const maxResults = opts.maxResults ?? 50;
  const args: string[] = [
    '--files',
    '--color', 'never',
    '--glob', opts.pattern,
  ];

  if (opts.type) {
    args.push('--type', opts.type);
  }

  // Append search paths
  args.push(...opts.paths);

  try {
    const output = await execRg(rg, args);
    if (!output.trim()) {
      return { content: `No files matching "${opts.pattern}" found.` };
    }
    // Limit results
    const lines = output.trim().split('\n');
    const limited = lines.slice(0, maxResults);
    return { content: limited.join('\n') };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (message.includes('exit code 1') || message.includes('No matches')) {
      return { content: `No files matching "${opts.pattern}" found.` };
    }
    return { content: `Search error: ${message}`, is_error: true };
  }
}

// ============================================================================
// HELPERS
// ============================================================================

const RG_TIMEOUT = 30_000;

function execRg(rgBin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(rgBin, args, {
      timeout: RG_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024, // 10MB output buffer
      cwd: undefined,
    }, (error, stdout, stderr) => {
      if (error) {
        // rg exit code 1 = no matches, not an error
        if ((error as any).code === 1) {
          resolve('');
          return;
        }
        reject(new Error(`rg failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}
