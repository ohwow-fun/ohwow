/**
 * Scrapling Installer & Manager
 * Handles checking, installing, and setting up Scrapling Python package + browser binaries.
 * Follows the ollama-installer.ts pattern.
 */

import { execSync, execFileSync, spawn } from 'child_process';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from './logger.js';
import { findPythonCommand, findPipCommand } from './platform-utils.js';

const FLAG_DIR = join(homedir(), '.ohwow');
const FLAG_FILE = join(FLAG_DIR, 'scrapling-installed');

/** Check if `scrapling` CLI is available. */
export async function isScraplingInstalled(): Promise<boolean> {
  const pythonCmd = findPythonCommand();
  if (!pythonCmd) return false;
  try {
    execFileSync(pythonCmd, ['-c', 'import scrapling'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Check if we've previously completed full installation (including browser binaries). */
export function isScraplingSetupComplete(): boolean {
  return existsSync(FLAG_FILE);
}

/** Mark installation as complete by writing a flag file. */
function markSetupComplete(): void {
  if (!existsSync(FLAG_DIR)) {
    mkdirSync(FLAG_DIR, { recursive: true });
  }
  writeFileSync(FLAG_FILE, new Date().toISOString(), 'utf-8');
}

/**
 * Ensure Scrapling is installed and set up.
 * - Checks Python import
 * - If missing, installs via pip
 * - Runs `scrapling install` for browser binaries (if not already done)
 */
export async function ensureScraplingInstalled(): Promise<void> {
  // Fast path: already fully set up
  if (isScraplingSetupComplete()) return;

  const installed = await isScraplingInstalled();

  if (!installed) {
    const pipCmd = findPipCommand();
    if (!pipCmd) {
      throw new Error('pip not found (tried pip3 and pip). Install Python 3 with pip to use Scrapling.');
    }
    logger.info('[Scrapling] Installing scrapling Python package...');
    execFileSync(pipCmd, ['install', 'scrapling[all]'], {
      stdio: 'inherit',
      timeout: 300000, // 5 minutes
    });
  }

  // Install browser binaries. The `scrapling install` command is a pip
  // entry_point script (not `python -m scrapling`, which errors with
  // "No module named scrapling.__main__"). Invoke it via the canonical
  // `python -c "from scrapling.cli import main; main()"` pattern which
  // works regardless of whether the scrapling script is on PATH. Caught
  // live on 2026-04-12 after the daemon kept logging "scrapling: command
  // not found" / "No module named scrapling.__main__" on every restart.
  logger.info('[Scrapling] Installing browser binaries (this may take a few minutes)...');
  const pythonCmd = findPythonCommand();
  if (!pythonCmd) {
    logger.warn('[Scrapling] Python unavailable; skipping browser binary install.');
    return;
  }
  try {
    execFileSync(
      pythonCmd,
      [
        '-c',
        'import sys; from scrapling.cli import main; sys.argv = ["scrapling", "install"]; main()',
      ],
      {
        stdio: 'inherit',
        timeout: 600000, // 10 minutes
      },
    );
    markSetupComplete();
    logger.info('[Scrapling] Setup complete.');
  } catch (err) {
    logger.warn(`[Scrapling] Browser binary installation had issues: ${err instanceof Error ? err.message : err}`);
    logger.warn('[Scrapling] Some fetchers may not work without browser binaries. The server will still start; some fetchers may degrade.');
    // Don't mark as complete — we'll retry on next restart. But also don't
    // block the scrapling server from starting for pure HTTP fetches which
    // don't need the browser binaries.
  }
}

/**
 * Install Scrapling with progress updates. Yields progress lines.
 * Used by the TUI setup wizard for interactive installation.
 */
export async function* installScrapling(): AsyncGenerator<string> {
  if (isScraplingSetupComplete()) {
    yield 'Scrapling is already installed.';
    return;
  }

  const installed = await isScraplingInstalled();

  if (!installed) {
    const pipCmd = findPipCommand();
    if (!pipCmd) {
      throw new Error('pip not found (tried pip3 and pip). Install Python 3 with pip to use Scrapling.');
    }
    yield 'Installing scrapling Python package...';
    yield* runCommand(pipCmd, ['install', 'scrapling[all]']);
  } else {
    yield 'Scrapling Python package already installed.';
  }

  yield 'Installing browser binaries (Chromium + Camoufox)...';
  yield* runCommand('scrapling', ['install']);

  markSetupComplete();
  yield 'Scrapling setup complete.';
}

/**
 * Install the FastAPI server dependencies.
 * Called by ScraplingService before spawning the server.
 */
export async function ensureServerDepsInstalled(requirementsPath: string): Promise<void> {
  const pythonCmd = findPythonCommand();
  if (!pythonCmd) {
    throw new Error('Python not found (tried python3 and python). Install Python 3.8+ to use Scrapling.');
  }
  try {
    execFileSync(pythonCmd, ['-c', 'import fastapi; import uvicorn'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
  } catch {
    const pipCmd = findPipCommand();
    if (!pipCmd) {
      throw new Error('pip not found (tried pip3 and pip). Install Python 3 with pip to use Scrapling.');
    }
    logger.info('[Scrapling] Installing server dependencies...');
    execFileSync(pipCmd, ['install', '-r', requirementsPath], {
      stdio: 'inherit',
      timeout: 300000,
    });
  }
}

/** Run a command and yield stdout/stderr lines. */
async function* runCommand(cmd: string, args: string[]): AsyncGenerator<string> {
  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  let done = false;
  let exitError: Error | null = null;

  child.stdout.on('data', (data: Buffer) => { buffer += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { buffer += data.toString(); });
  child.on('close', (code) => {
    done = true;
    if (code !== 0) exitError = new Error(`Command exited with code ${code}`);
  });
  child.on('error', (err) => {
    done = true;
    exitError = err;
  });

  while (!done) {
    await sleep(200);
    if (buffer) {
      const lines = buffer.split('\n');
      buffer = '';
      for (const line of lines) {
        if (line.trim()) yield line.trim();
      }
    }
  }

  // Flush remaining
  if (buffer) {
    for (const line of buffer.split('\n')) {
      if (line.trim()) yield line.trim();
    }
  }

  if (exitError) throw exitError;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
