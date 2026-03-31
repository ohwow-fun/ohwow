/**
 * Claude Code CLI Adapter
 * Spawns `claude` CLI as a child process for full-delegation task execution.
 * Instead of ohwow managing its own tool loop, Claude Code handles everything:
 * file editing, bash, search, context management, and MCP tools.
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { logger } from '../../lib/logger.js';
import { ClaudeCodeStreamParser, type ProgressInfo } from './claude-code-parser.js';
import { getCachedClaudeCodeStatus } from './claude-code-detection.js';
import type { ClaudeCodeCliPermissionMode } from '../../config.js';

// ---------- Types ----------

export interface ClaudeCodeExecConfig {
  /** Path to claude binary (empty = use cached detection result or 'claude') */
  binaryPath?: string;
  /** Model override (e.g., 'claude-sonnet-4-5-20250514') */
  model?: string;
  /** Max tool iterations (default: 25) */
  maxTurns?: number;
  /** Permission mode (default: 'skip') */
  permissionMode?: ClaudeCodeCliPermissionMode;
  /** Specific tools to allow when permissionMode is 'allowedTools' */
  allowedTools?: string[];
  /** Working directory for Claude Code */
  workingDirectory?: string;
  /** Session ID for --resume (cwd-aware) */
  sessionId?: string;
  /** Timeout in ms (default: 300_000 = 5 min) */
  timeout?: number;
  /** Extra environment variables (e.g., OHWOW_AGENT_ID) */
  envVars?: Record<string, string>;
  /** Directories to inject via --add-dir (CLAUDE.md, skills) */
  skillsDirs?: string[];
}

export interface ClaudeCodeExecResult {
  success: boolean;
  content: string;
  sessionId: string | null;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  model: string;
  toolsUsed: string[];
  error?: string;
}

// ---------- Adapter ----------

const DEFAULT_TIMEOUT = 300_000; // 5 minutes
const KILL_GRACE_MS = 5_000;     // 5s between SIGTERM and SIGKILL

/**
 * Resolve the claude binary path.
 * Priority: config → cached detection → fallback to 'claude'.
 */
function resolveBinaryPath(configPath?: string): string {
  if (configPath) return configPath;
  const cached = getCachedClaudeCodeStatus();
  if (cached?.binaryPath) return cached.binaryPath;
  return 'claude';
}

/**
 * Build the CLI arguments array.
 */
function buildArgs(config: ClaudeCodeExecConfig): string[] {
  const args: string[] = ['--print', '--output-format', 'stream-json', '--verbose'];

  if (config.model) {
    args.push('--model', config.model);
  }

  if (config.maxTurns) {
    args.push('--max-turns', String(config.maxTurns));
  }

  // Permission handling
  if (config.permissionMode === 'skip' || !config.permissionMode) {
    args.push('--dangerously-skip-permissions');
  } else if (config.permissionMode === 'allowedTools' && config.allowedTools?.length) {
    args.push('--allowedTools', ...config.allowedTools);
  }
  // 'interactive' mode: no permission flags (Claude Code prompts normally)

  // Session resume
  if (config.sessionId) {
    args.push('--resume', config.sessionId);
  }

  // Skills directories
  if (config.skillsDirs?.length) {
    for (const dir of config.skillsDirs) {
      args.push('--add-dir', dir);
    }
  }

  return args;
}

/**
 * Execute a task via Claude Code CLI.
 * Spawns the claude binary, pipes the prompt, and parses stream-json output.
 *
 * If session resume fails, automatically retries without --resume.
 */
export async function executeWithClaudeCodeCli(
  prompt: string,
  config: ClaudeCodeExecConfig,
  onProgress?: (info: ProgressInfo) => void,
): Promise<ClaudeCodeExecResult> {
  const result = await runClaudeProcess(prompt, config, onProgress);

  // If resume failed, retry without session
  if (!result.success && config.sessionId && isResumeError(result.error)) {
    logger.info('[claude-code-adapter] Session resume failed, retrying with fresh session');
    const freshConfig = { ...config, sessionId: undefined };
    return runClaudeProcess(prompt, freshConfig, onProgress);
  }

  return result;
}

/**
 * Check if the error is related to session resume failure.
 */
function isResumeError(error?: string): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return lower.includes('session') || lower.includes('resume') || lower.includes('not found');
}

/**
 * Core process spawning and output parsing.
 */
function runClaudeProcess(
  prompt: string,
  config: ClaudeCodeExecConfig,
  onProgress?: (info: ProgressInfo) => void,
): Promise<ClaudeCodeExecResult> {
  return new Promise((resolve) => {
    const binaryPath = resolveBinaryPath(config.binaryPath);
    const args = buildArgs(config);
    const timeout = config.timeout ?? DEFAULT_TIMEOUT;

    logger.info(
      { binary: binaryPath, cwd: config.workingDirectory, resume: !!config.sessionId, maxTurns: config.maxTurns },
      '[claude-code-adapter] Spawning Claude Code CLI',
    );

    const child = spawn(binaryPath, args, {
      cwd: config.workingDirectory,
      env: { ...process.env, ...config.envVars },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const parser = new ClaudeCodeStreamParser();
    const stderrChunks: string[] = [];

    // Parse stdout line by line
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      parser.processLine(line, onProgress);
    });

    // Capture stderr for diagnostics
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrChunks.push(text);
      // Log stderr at debug level (it often contains progress info, not errors)
      logger.debug({ stderr: text.trim() }, '[claude-code-adapter] stderr');
    });

    // Timeout handling: SIGTERM → wait → SIGKILL
    let killed = false;
    const timeoutId = setTimeout(() => {
      killed = true;
      logger.warn({ timeout }, '[claude-code-adapter] Process timed out, sending SIGTERM');
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          logger.warn('[claude-code-adapter] Process did not exit after SIGTERM, sending SIGKILL');
          child.kill('SIGKILL');
        }
      }, KILL_GRACE_MS);
    }, timeout);

    // Handle spawn errors (binary not found, permission denied)
    child.on('error', (err) => {
      clearTimeout(timeoutId);
      logger.error({ err }, '[claude-code-adapter] Failed to spawn claude process');
      resolve({
        success: false,
        content: '',
        sessionId: null,
        costCents: 0,
        inputTokens: 0,
        outputTokens: 0,
        numTurns: 0,
        model: 'unknown',
        toolsUsed: [],
        error: `Failed to spawn claude: ${err.message}`,
      });
    });

    // Handle process exit
    child.on('close', (code) => {
      clearTimeout(timeoutId);
      rl.close();

      const parsed = parser.getResult();
      const stderr = stderrChunks.join('');

      if (killed) {
        resolve({
          ...parsed,
          success: false,
          error: `Claude Code CLI timed out after ${timeout}ms`,
        });
        return;
      }

      if (code !== 0 && !parsed.content) {
        resolve({
          ...parsed,
          success: false,
          error: stderr || `Claude Code CLI exited with code ${code}`,
        });
        return;
      }

      // Even if exit code is non-zero, if we got content, treat as success
      // (Claude Code may exit with code 1 on some tool errors but still produce output)
      resolve({
        ...parsed,
        success: true,
      });
    });

    // Pipe the prompt via stdin
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
