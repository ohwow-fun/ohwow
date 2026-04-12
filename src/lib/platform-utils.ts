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
 * Resolve a command to its absolute path via `command -v` (POSIX) or
 * `where.exe` (Windows). Returns null when not found. Use this instead of
 * {@link commandExists} when you need to spawn the binary — the daemon's
 * subprocess environment sometimes has a stripped PATH that breaks bare
 * name lookups even though /bin/sh can still resolve them.
 *
 * Caught live on 2026-04-12: the scrapling sidecar was spawning with
 * `spawn('python3', ...)` which returned ENOENT because the daemon's
 * process.env.PATH didn't include /usr/bin, while commandExists returned
 * true because /bin/sh -c 'command -v python3' has its own PATH resolution.
 */
export function resolveCommandPath(cmd: string): string | null {
  if (!SAFE_CMD_RE.test(cmd)) return null;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where.exe', [cmd], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 3000,
        encoding: 'utf-8',
      });
      const firstLine = out.split(/\r?\n/)[0]?.trim();
      return firstLine || null;
    }
    const out = execFileSync('/bin/sh', ['-c', `command -v ${cmd}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000,
      encoding: 'utf-8',
    });
    const trimmed = out.trim();
    return trimmed || null;
  } catch {
    return null;
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
 * Returns the absolute path to the binary so callers can spawn it
 * without depending on the subprocess PATH. Returns null if neither
 * is found.
 */
export function findPythonCommand(): string | null {
  return resolveCommandPath('python3') || resolveCommandPath('python');
}

/**
 * Find a working pip command (pip3 or pip).
 * Returns the absolute path to the binary so callers can spawn it
 * without depending on the subprocess PATH. Returns null if neither
 * is found.
 */
export function findPipCommand(): string | null {
  if (resolveCommandPath('pip3')) return resolveCommandPath('pip3');
  if (resolveCommandPath('pip')) return resolveCommandPath('pip');
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
