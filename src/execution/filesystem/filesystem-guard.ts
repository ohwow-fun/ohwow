/**
 * FileAccessGuard — Security layer for local filesystem access.
 * Validates that all file operations target allowed directories
 * and blocks access to sensitive files/patterns.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return os.homedir() + p.slice(1);
  return p;
}

/** Patterns that are always blocked regardless of allowlist. */
const BLOCKED_PATTERNS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.env',
  'node_modules',
  '.git',
];

/** File extensions that are always blocked. */
const BLOCKED_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks'];

/** Filename patterns that are always blocked. */
const BLOCKED_FILENAMES = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', '.env', '.env.local', '.env.production'];

export class FileAccessGuard {
  private resolvedPaths: string[];

  constructor(allowedPaths: string[]) {
    // Pre-resolve all allowed paths at construction time
    this.resolvedPaths = allowedPaths
      .map((p) => {
        try {
          return fs.realpathSync(path.resolve(expandTilde(p)));
        } catch {
          // Path doesn't exist, skip it
          return null;
        }
      })
      .filter((p): p is string => p !== null);
  }

  /** Check if a target path is within the allowlist and not blocked. */
  isAllowed(targetPath: string): { allowed: boolean; reason?: string } {
    if (this.resolvedPaths.length === 0) {
      return { allowed: false, reason: 'No directories are configured for file access.' };
    }

    // Resolve the target path
    let resolvedTarget: string;
    try {
      // For paths that don't exist yet (search queries), resolve without following symlinks
      const absolute = path.resolve(expandTilde(targetPath));
      try {
        resolvedTarget = fs.realpathSync(absolute);
      } catch {
        // Path doesn't exist — use the resolved absolute for prefix check
        resolvedTarget = absolute;
      }
    } catch {
      return { allowed: false, reason: 'Could not resolve path.' };
    }

    // Check blocked patterns in any path segment
    const segments = resolvedTarget.split(path.sep);
    for (const segment of segments) {
      // Check .env* pattern
      if (segment.startsWith('.env')) {
        return { allowed: false, reason: `Access to ${segment} files is blocked for security.` };
      }
      for (const blocked of BLOCKED_PATTERNS) {
        if (segment === blocked) {
          return { allowed: false, reason: `Access to ${blocked} is blocked for security.` };
        }
      }
    }

    // Check blocked extensions
    const ext = path.extname(resolvedTarget).toLowerCase();
    if (BLOCKED_EXTENSIONS.includes(ext)) {
      return { allowed: false, reason: `Access to ${ext} files is blocked for security.` };
    }

    // Check blocked filenames
    const basename = path.basename(resolvedTarget);
    for (const blocked of BLOCKED_FILENAMES) {
      if (basename === blocked || basename.startsWith(blocked)) {
        return { allowed: false, reason: `Access to ${basename} is blocked for security.` };
      }
    }

    // Check if within any allowed directory
    for (const allowed of this.resolvedPaths) {
      if (resolvedTarget === allowed || resolvedTarget.startsWith(allowed + path.sep)) {
        return { allowed: true };
      }
    }

    return { allowed: false, reason: 'Path is outside the allowed directories.' };
  }

  /** Get the list of allowed directories (resolved). */
  getAllowedPaths(): string[] {
    return [...this.resolvedPaths];
  }
}
