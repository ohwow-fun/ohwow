/**
 * Claude Code CLI Detection
 * Detects whether `claude` CLI is installed, what version, and whether it's authenticated.
 * Caches results with TTL to avoid repeated subprocess spawns.
 */

import { execFileSync } from 'child_process';
import { logger } from '../../lib/logger.js';

export interface ClaudeCodeStatus {
  available: boolean;
  binaryPath: string | null;
  version: string | null;
  authenticated: boolean;
}

const UNAVAILABLE: ClaudeCodeStatus = {
  available: false,
  binaryPath: null,
  version: null,
  authenticated: false,
};

// Cache with different TTLs for available vs unavailable
let cachedStatus: ClaudeCodeStatus | null = null;
let cachedAt = 0;
const AVAILABLE_TTL_MS = 60_000;   // 1 min when available
const UNAVAILABLE_TTL_MS = 15_000; // 15s when unavailable (faster retry)

function isCacheValid(): boolean {
  if (!cachedStatus) return false;
  const ttl = cachedStatus.available ? AVAILABLE_TTL_MS : UNAVAILABLE_TTL_MS;
  return Date.now() - cachedAt < ttl;
}

/**
 * Find the claude binary path.
 * Tries custom path first, then `which claude`.
 */
function findBinary(customPath?: string): string | null {
  if (customPath) {
    try {
      // Verify the custom path exists and is executable
      execFileSync(customPath, ['--version'], { timeout: 5_000, stdio: 'pipe' });
      return customPath;
    } catch {
      logger.warn(`[claude-code-detection] Custom path ${customPath} is not executable`);
      return null;
    }
  }

  try {
    const result = execFileSync('/usr/bin/which', ['claude'], {
      timeout: 5_000,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    const path = result.trim();
    return path || null;
  } catch {
    return null;
  }
}

/**
 * Get version from `claude --version`.
 */
function getVersion(binaryPath: string): string | null {
  try {
    const result = execFileSync(binaryPath, ['--version'], {
      timeout: 5_000,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check authentication by running a minimal prompt.
 * If auth is valid, Claude Code will respond. If not, it exits with an error.
 */
function checkAuth(binaryPath: string): boolean {
  try {
    execFileSync(binaryPath, [
      '--print', 'respond with ok',
      '--output-format', 'json',
      '--max-turns', '1',
    ], {
      timeout: 15_000,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect Claude Code CLI availability, version, and auth status.
 * Results are cached — call `resetClaudeCodeCache()` to force re-detection.
 */
export async function detectClaudeCode(customPath?: string): Promise<ClaudeCodeStatus> {
  if (isCacheValid()) return cachedStatus!;

  const binaryPath = findBinary(customPath);
  if (!binaryPath) {
    cachedStatus = UNAVAILABLE;
    cachedAt = Date.now();
    return UNAVAILABLE;
  }

  const version = getVersion(binaryPath);
  const authenticated = checkAuth(binaryPath);

  const status: ClaudeCodeStatus = {
    available: authenticated,
    binaryPath,
    version,
    authenticated,
  };

  cachedStatus = status;
  cachedAt = Date.now();

  if (status.available) {
    logger.info({ version, path: binaryPath }, '[claude-code-detection] Claude Code CLI detected');
  } else {
    logger.warn({ version, path: binaryPath }, '[claude-code-detection] Claude Code CLI found but not authenticated');
  }

  return status;
}

/**
 * Synchronous check — reads cached status only.
 * Returns false if detection hasn't run yet or cache expired.
 */
export function isClaudeCodeCliAvailable(): boolean {
  if (!isCacheValid()) return false;
  return cachedStatus?.available ?? false;
}

/**
 * Get the full cached status (or null if not yet detected).
 */
export function getCachedClaudeCodeStatus(): ClaudeCodeStatus | null {
  if (!isCacheValid()) return null;
  return cachedStatus;
}

/**
 * Force re-detection on next call.
 */
export function resetClaudeCodeCache(): void {
  cachedStatus = null;
  cachedAt = 0;
}
