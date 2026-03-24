/**
 * Windows-specific tests for platform-utils.
 * These tests mock process.platform to 'win32' to verify Windows code paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync, execFile } from 'child_process';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);
const mockExecFile = vi.mocked(execFile);

describe('platform-utils (win32)', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  describe('commandExists', () => {
    it('uses where.exe on Windows', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from('C:\\Windows\\System32\\node.exe'));
      // Re-import to pick up mocked platform
      const { commandExists } = await import('../platform-utils.js');
      const result = commandExists('node');
      expect(result).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'where.exe',
        ['node'],
        expect.objectContaining({ timeout: 3000 }),
      );
    });

    it('returns false when where.exe throws', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
      const { commandExists } = await import('../platform-utils.js');
      expect(commandExists('nonexistent')).toBe(false);
    });

    it('rejects unsafe command names', async () => {
      const { commandExists } = await import('../platform-utils.js');
      expect(commandExists('cmd; rm -rf /')).toBe(false);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe('detectPackageManager', () => {
    it('detects winget on Windows', async () => {
      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'where.exe' && (args as string[])?.[0] === 'winget') {
          return Buffer.from('C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe');
        }
        throw new Error('not found');
      });
      const { detectPackageManager } = await import('../platform-utils.js');
      const result = detectPackageManager();
      expect(result).toEqual({ name: 'winget', installCmd: 'winget install' });
    });

    it('detects chocolatey when winget is absent', async () => {
      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'where.exe' && (args as string[])?.[0] === 'choco') {
          return Buffer.from('C:\\ProgramData\\chocolatey\\bin\\choco.exe');
        }
        throw new Error('not found');
      });
      const { detectPackageManager } = await import('../platform-utils.js');
      const result = detectPackageManager();
      expect(result).toEqual({ name: 'choco', installCmd: 'choco install -y' });
    });

    it('returns null when no package manager found', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
      const { detectPackageManager } = await import('../platform-utils.js');
      expect(detectPackageManager()).toBeNull();
    });
  });

  describe('popplerInstallHint', () => {
    it('returns Windows-specific hint with package manager', async () => {
      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'where.exe' && (args as string[])?.[0] === 'winget') {
          return Buffer.from('winget.exe');
        }
        throw new Error('not found');
      });
      const { popplerInstallHint } = await import('../platform-utils.js');
      expect(popplerInstallHint()).toContain('winget install');
    });

    it('returns GitHub releases URL when no package manager', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
      const { popplerInstallHint } = await import('../platform-utils.js');
      expect(popplerInstallHint()).toContain('poppler-windows/releases');
    });
  });

  describe('openPath', () => {
    it('uses cmd.exe /c start on Windows', async () => {
      const mockChild = { stdin: { destroy: vi.fn() }, stdout: { destroy: vi.fn() }, stderr: { destroy: vi.fn() } };
      mockExecFile.mockReturnValue(mockChild as never);
      const { openPath } = await import('../platform-utils.js');
      openPath('C:\\Users\\test\\file.txt');
      expect(mockExecFile).toHaveBeenCalledWith(
        'cmd.exe',
        ['/c', 'start', '""', 'C:\\Users\\test\\file.txt'],
        expect.any(Function),
      );
    });
  });
});
