/**
 * Bash Tool Executor
 * Handles execution of bash commands with security validation.
 * Uses child_process.spawn for non-blocking execution.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import type { FileAccessGuard } from '../filesystem/filesystem-guard.js';
import { scrubEnvironment } from '../../lib/env-scrub.js';

// ============================================================================
// TYPES
// ============================================================================

export interface BashToolResult {
  content: string;
  is_error?: boolean;
}

// ============================================================================
// SECURITY CONSTANTS
// ============================================================================

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB per stream

/** Patterns for commands that are always blocked (Unix/macOS/Linux). */
const BLOCKED_COMMAND_PATTERNS_UNIX: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[^\s]*\s+)*-[^\s]*r[^\s]*f[^\s]*\s+\/(\s|$)/, reason: 'rm -rf / is blocked' },
  { pattern: /\brm\s+(-[^\s]*\s+)*-[^\s]*f[^\s]*r[^\s]*\s+\/(\s|$)/, reason: 'rm -rf / is blocked' },
  { pattern: /\bshutdown\b/, reason: 'shutdown is blocked' },
  { pattern: /\breboot\b/, reason: 'reboot is blocked' },
  { pattern: /\bhalt\b/, reason: 'halt is blocked' },
  { pattern: /\bpoweroff\b/, reason: 'poweroff is blocked' },
  { pattern: /\bmkfs\b/, reason: 'mkfs (format filesystem) is blocked' },
  { pattern: /\bdd\b.*\bof\s*=\s*\/dev\//, reason: 'dd to device files is blocked' },
  { pattern: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'Fork bombs are blocked' },
  { pattern: /\bcurl\b.*\|\s*\bbash\b/, reason: 'Piping curl to bash is blocked' },
  { pattern: /\bwget\b.*\|\s*\bbash\b/, reason: 'Piping wget to bash is blocked' },
  { pattern: /\bcurl\b.*\|\s*\bsh\b/, reason: 'Piping curl to sh is blocked' },
  { pattern: /\bwget\b.*\|\s*\bsh\b/, reason: 'Piping wget to sh is blocked' },
  { pattern: />\s*\/etc\//, reason: 'Writing to /etc/ is blocked' },
  { pattern: />\s*\/usr\//, reason: 'Writing to /usr/ is blocked' },
  { pattern: /\bsudo\b/, reason: 'sudo is blocked' },
  { pattern: /\bsu\s+-/, reason: 'su is blocked' },
];

/** Patterns for commands that are always blocked (Windows). */
const BLOCKED_COMMAND_PATTERNS_WIN32: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bformat\s+[a-zA-Z]:/i, reason: 'format drive is blocked' },
  { pattern: /\bdel\s+.*[/\\]\s*\*/i, reason: 'Recursive delete from root is blocked' },
  { pattern: /\bRemove-Item\s+.*-Recurse.*[/\\]\*/i, reason: 'Recursive delete from root is blocked' },
  { pattern: /\breg\s+(delete|add)\s+.*HK/i, reason: 'Registry modification is blocked' },
  { pattern: /\bshutdown\s+\/[srh]/i, reason: 'shutdown is blocked' },
  { pattern: /\bbcdedit\b/i, reason: 'bcdedit is blocked' },
  { pattern: /\bnet\s+stop\b/i, reason: 'net stop is blocked' },
  { pattern: /\bSet-ExecutionPolicy\b/i, reason: 'Changing execution policy is blocked' },
  { pattern: /\bInvoke-Expression\b.*\bInvoke-WebRequest\b/i, reason: 'Piping web content to eval is blocked' },
  { pattern: /\bIEX\b.*\bIWR\b/i, reason: 'Piping web content to eval is blocked' },
];

// ============================================================================
// HELPERS
// ============================================================================

function checkBlockedCommand(command: string): string | null {
  const patterns = process.platform === 'win32'
    ? BLOCKED_COMMAND_PATTERNS_WIN32
    : BLOCKED_COMMAND_PATTERNS_UNIX;
  for (const { pattern, reason } of patterns) {
    if (pattern.test(command)) {
      return reason;
    }
  }
  return null;
}

function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || timeoutMs === null) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, timeoutMs));
}

function truncateOutput(output: string, label: string): string {
  const bytes = Buffer.byteLength(output, 'utf-8');
  if (bytes <= MAX_OUTPUT_BYTES) return output;

  // Truncate by characters (approximate, good enough)
  const ratio = MAX_OUTPUT_BYTES / bytes;
  const charLimit = Math.floor(output.length * ratio);
  return output.slice(0, charLimit) + `\n[${label} truncated: ${bytes} bytes exceeded ${MAX_OUTPUT_BYTES} byte limit]`;
}

// ============================================================================
// EXECUTOR
// ============================================================================

function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'powershell.exe' : 'bash';
    const shellArgs = isWin
      ? ['-NoProfile', '-NonInteractive', '-Command', command]
      : ['-c', command];
    const child = spawn(shell, shellArgs, {
      cwd,
      env: scrubEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 0, // We handle timeout ourselves for SIGKILL
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        stderr += `\n[Process killed: exceeded ${timeoutMs}ms timeout]`;
      }
      resolve({
        stdout,
        stderr,
        exitCode: killed ? 124 : (code ?? 1),
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + `\n${err.message}`,
        exitCode: 1,
      });
    });
  });
}

// ============================================================================
// PUBLIC API
// ============================================================================

export async function executeBashTool(
  guard: FileAccessGuard,
  _toolName: string,
  input: Record<string, unknown>,
): Promise<BashToolResult> {
  const command = input.command as string | undefined;
  const workingDirectory = input.working_directory as string | undefined;
  const timeoutMs = clampTimeout(input.timeout_ms as number | undefined);

  // Validate command is provided and non-empty
  if (!command || command.trim().length === 0) {
    return { content: 'Error: command is required and must not be empty', is_error: true };
  }

  // Check blocked commands
  const blocked = checkBlockedCommand(command);
  if (blocked) {
    return { content: `Error: ${blocked}`, is_error: true };
  }

  // Resolve working directory
  const allowedPaths = guard.getAllowedPaths();
  let cwd: string;

  if (workingDirectory) {
    const resolved = path.resolve(workingDirectory);
    const check = guard.isAllowed(resolved);
    if (!check.allowed) {
      return { content: `Error: Working directory is outside allowed paths. ${check.reason || ''}`.trim(), is_error: true };
    }
    cwd = resolved;
  } else {
    if (allowedPaths.length === 0) {
      return { content: 'Error: No allowed directories configured', is_error: true };
    }
    cwd = allowedPaths[0];
  }

  // Execute the command
  const result = await executeCommand(command, cwd, timeoutMs);

  // Format output
  const stdout = truncateOutput(result.stdout, 'stdout');
  const stderr = truncateOutput(result.stderr, 'stderr');

  const parts = [`Exit code: ${result.exitCode}`];
  if (stdout.length > 0) {
    parts.push(`\nstdout:\n${stdout}`);
  }
  if (stderr.length > 0) {
    parts.push(`\nstderr:\n${stderr}`);
  }

  return {
    content: parts.join('\n'),
    is_error: result.exitCode !== 0,
  };
}
