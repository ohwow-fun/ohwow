/**
 * Cross-Platform Utility Helpers
 * POSIX-standard command detection, package manager discovery, and portable Python lookup.
 */

import { execFile, execFileSync } from 'child_process';
import { platform } from 'os';

/** Allowlist: command names must be alphanumeric with dots, hyphens, underscores. */
const SAFE_CMD_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Check if a command exists using POSIX-standard `command -v`.
 * Rejects names containing shell metacharacters to prevent injection.
 */
export function commandExists(cmd: string): boolean {
  if (!SAFE_CMD_RE.test(cmd)) return false;
  try {
    if (process.platform === 'win32') {
      execFileSync('where.exe', [cmd], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 3000,
      });
    } else {
      execFileSync('/bin/sh', ['-c', `command -v ${cmd}`], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 3000,
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the system package manager on Linux.
 * Returns the manager name and its install command prefix, or null on non-Linux / unknown.
 */
export function detectPackageManager(): { name: string; installCmd: string } | null {
  if (platform() === 'win32') {
    const winManagers = [
      { name: 'winget', installCmd: 'winget install' },
      { name: 'choco', installCmd: 'choco install -y' },
      { name: 'scoop', installCmd: 'scoop install' },
    ];
    for (const mgr of winManagers) {
      if (commandExists(mgr.name)) return mgr;
    }
    return null;
  }

  if (platform() !== 'linux') return null;

  const managers = [
    { name: 'apt-get', installCmd: 'sudo apt-get install -y' },
    { name: 'dnf', installCmd: 'sudo dnf install -y' },
    { name: 'yum', installCmd: 'sudo yum install -y' },
    { name: 'pacman', installCmd: 'sudo pacman -S --noconfirm' },
    { name: 'apk', installCmd: 'sudo apk add' },
    { name: 'zypper', installCmd: 'sudo zypper install -y' },
  ];

  for (const mgr of managers) {
    if (commandExists(mgr.name)) return mgr;
  }
  return null;
}

/**
 * Return a platform-appropriate hint for installing poppler.
 */
export function popplerInstallHint(): string {
  const os = platform();
  if (os === 'darwin') {
    return 'brew install poppler';
  }
  if (os === 'win32') {
    const pkgMgr = detectPackageManager();
    if (pkgMgr) return `${pkgMgr.installCmd} poppler`;
    return 'Install poppler from https://github.com/oschwartz10612/poppler-windows/releases';
  }
  if (os === 'linux') {
    const pkgMgr = detectPackageManager();
    if (pkgMgr) {
      const pkg = pkgMgr.name === 'pacman' ? 'poppler' : 'poppler-utils';
      return `${pkgMgr.installCmd} ${pkg}`;
    }
    return 'Install poppler-utils using your distribution package manager';
  }
  return 'Install poppler for your platform (https://poppler.freedesktop.org/)';
}

/**
 * Find a working Python command (python3 or python).
 * Returns the command name or null if neither is found.
 */
export function findPythonCommand(): string | null {
  if (commandExists('python3')) return 'python3';
  if (commandExists('python')) return 'python';
  return null;
}

/**
 * Find a working pip command (pip3 or pip).
 * Returns the command name or null if neither is found.
 */
export function findPipCommand(): string | null {
  if (commandExists('pip3')) return 'pip3';
  if (commandExists('pip')) return 'pip';
  return null;
}

/**
 * Open a file or URL with the platform's default handler.
 * Uses `open` on macOS, `xdg-open` on Linux. No-op if the command fails.
 * Uses execFile (array form) to avoid shell injection from file paths.
 */
export function openPath(filePath: string): void {
  try {
    if (platform() === 'win32') {
      const child = execFile('cmd.exe', ['/c', 'start', '""', filePath], () => {});
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      return;
    }
    const cmd = platform() === 'darwin' ? 'open' : 'xdg-open';
    const child = execFile(cmd, [filePath], () => {});
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  } catch {
    // Swallow errors silently — matches existing behavior
  }
}
