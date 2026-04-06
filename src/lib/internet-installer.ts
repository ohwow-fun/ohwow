/**
 * Internet Tools Installer
 * Auto-installs yt-dlp and gh CLI when needed. Follows the scrapling-installer pattern:
 * check → install → flag file.
 */

import { execFileSync } from 'child_process';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { logger } from './logger.js';
import { commandExists, detectPackageManager } from './platform-utils.js';

const FLAG_DIR = join(homedir(), '.ohwow');
const YTDLP_FLAG = join(FLAG_DIR, 'yt-dlp-installed');
const GH_FLAG = join(FLAG_DIR, 'gh-installed');

function markInstalled(flagFile: string): void {
  if (!existsSync(FLAG_DIR)) {
    mkdirSync(FLAG_DIR, { recursive: true });
  }
  writeFileSync(flagFile, new Date().toISOString(), 'utf-8');
}

// ---------------------------------------------------------------------------
// yt-dlp
// ---------------------------------------------------------------------------

export function isYtdlpAvailable(): boolean {
  if (existsSync(YTDLP_FLAG)) return true;
  if (commandExists('yt-dlp')) {
    markInstalled(YTDLP_FLAG);
    return true;
  }
  return false;
}

export async function ensureYtdlp(): Promise<boolean> {
  if (isYtdlpAvailable()) return true;

  const os = platform();

  try {
    if (os === 'darwin' && commandExists('brew')) {
      logger.info('[Internet] Installing yt-dlp via Homebrew...');
      execFileSync('brew', ['install', 'yt-dlp'], { stdio: 'pipe', timeout: 120_000 });
    } else if (os === 'linux' || os === 'darwin') {
      // pip fallback works on both macOS and Linux
      const pip = commandExists('pip3') ? 'pip3' : commandExists('pip') ? 'pip' : null;
      if (pip) {
        logger.info('[Internet] Installing yt-dlp via pip...');
        execFileSync(pip, ['install', 'yt-dlp'], { stdio: 'pipe', timeout: 120_000 });
      } else {
        const pkgMgr = detectPackageManager();
        if (pkgMgr) {
          logger.info(`[Internet] Installing yt-dlp via ${pkgMgr.name}...`);
          execFileSync('/bin/sh', ['-c', `${pkgMgr.installCmd} yt-dlp`], { stdio: 'pipe', timeout: 120_000 });
        } else {
          logger.debug('[Internet] No package manager found for yt-dlp installation');
          return false;
        }
      }
    } else if (os === 'win32') {
      const pkgMgr = detectPackageManager();
      if (pkgMgr) {
        logger.info(`[Internet] Installing yt-dlp via ${pkgMgr.name}...`);
        execFileSync('cmd', ['/c', `${pkgMgr.installCmd} yt-dlp`], { stdio: 'pipe', timeout: 120_000 });
      } else {
        logger.debug('[Internet] No package manager found for yt-dlp installation on Windows');
        return false;
      }
    }

    if (commandExists('yt-dlp')) {
      markInstalled(YTDLP_FLAG);
      logger.info('[Internet] yt-dlp installed successfully');
      return true;
    }
  } catch (err) {
    logger.warn({ err }, '[Internet] yt-dlp auto-install failed (non-blocking)');
  }

  return false;
}

// ---------------------------------------------------------------------------
// gh CLI
// ---------------------------------------------------------------------------

export function isGhAvailable(): boolean {
  if (existsSync(GH_FLAG)) return true;
  if (commandExists('gh')) {
    markInstalled(GH_FLAG);
    return true;
  }
  return false;
}

export async function ensureGh(): Promise<boolean> {
  if (isGhAvailable()) return true;

  const os = platform();

  try {
    if (os === 'darwin' && commandExists('brew')) {
      logger.info('[Internet] Installing gh CLI via Homebrew...');
      execFileSync('brew', ['install', 'gh'], { stdio: 'pipe', timeout: 120_000 });
    } else if (os === 'linux') {
      const pkgMgr = detectPackageManager();
      if (pkgMgr) {
        logger.info(`[Internet] Installing gh via ${pkgMgr.name}...`);
        execFileSync('/bin/sh', ['-c', `${pkgMgr.installCmd} gh`], { stdio: 'pipe', timeout: 120_000 });
      } else {
        logger.debug('[Internet] No package manager found for gh installation');
        return false;
      }
    } else if (os === 'win32') {
      const pkgMgr = detectPackageManager();
      if (pkgMgr) {
        logger.info(`[Internet] Installing gh via ${pkgMgr.name}...`);
        execFileSync('cmd', ['/c', `${pkgMgr.installCmd} gh`], { stdio: 'pipe', timeout: 120_000 });
      } else {
        logger.debug('[Internet] No package manager found for gh installation on Windows');
        return false;
      }
    }

    if (commandExists('gh')) {
      markInstalled(GH_FLAG);
      logger.info('[Internet] gh CLI installed successfully');
      return true;
    }
  } catch (err) {
    logger.warn({ err }, '[Internet] gh auto-install failed (non-blocking)');
  }

  return false;
}

/**
 * Ensure all internet tool dependencies are installed.
 * Non-blocking: failures are logged but don't prevent startup.
 */
export async function ensureInternetDeps(): Promise<{ ytdlp: boolean; gh: boolean }> {
  // Sequential: ensureYtdlp/ensureGh use execFileSync internally
  const ytdlp = await ensureYtdlp();
  const gh = await ensureGh();
  return { ytdlp, gh };
}
