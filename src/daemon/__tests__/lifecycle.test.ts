import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock instance-lock before importing lifecycle
vi.mock('../../lib/instance-lock.js', () => ({
  readLock: vi.fn(),
  isProcessAlive: vi.fn(),
}));

// Mock logger to suppress output
vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock fs — keep real join/path but control file operations
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    statSync: vi.fn(),
    renameSync: vi.fn(),
    openSync: vi.fn(),
  };
});

import { readLock, isProcessAlive } from '../../lib/instance-lock.js';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import {
  getLogPath,
  getPidPath,
  isDaemonRunning,
  getDaemonSessionToken,
  stopDaemon,
  writeReplacedMarker,
  wasRecentlyReplaced,
  clearReplacedMarker,
  parseEnvFile,
} from '../lifecycle.js';

const mockReadLock = vi.mocked(readLock);
const mockIsProcessAlive = vi.mocked(isProcessAlive);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockUnlinkSync = vi.mocked(unlinkSync);

const DATA_DIR = join(tmpdir(), 'ohwow-test');

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getLogPath', () => {
  it('returns daemon.log inside the data directory', () => {
    expect(getLogPath(DATA_DIR)).toBe(join(DATA_DIR, 'daemon.log'));
  });
});

describe('getPidPath', () => {
  it('returns daemon.pid inside the data directory', () => {
    expect(getPidPath(DATA_DIR)).toBe(join(DATA_DIR, 'daemon.pid'));
  });
});

describe('isDaemonRunning', () => {
  it('returns running: false when no lock file exists', async () => {
    mockReadLock.mockReturnValue(null);

    const result = await isDaemonRunning(DATA_DIR, 3000);
    expect(result).toEqual({ running: false });
  });

  it('returns running: false when lock exists but process is dead', async () => {
    mockReadLock.mockReturnValue({ pid: 12345, startedAt: new Date().toISOString(), port: 3000 });
    mockIsProcessAlive.mockReturnValue(false);

    const result = await isDaemonRunning(DATA_DIR, 3000);
    expect(result).toEqual({ running: false });
  });

  it('returns running: true with healthy: false when process alive but health check fails', async () => {
    mockReadLock.mockReturnValue({ pid: 12345, startedAt: new Date().toISOString(), port: 3000 });
    mockIsProcessAlive.mockReturnValue(true);

    // Mock fetch to throw (network error / connection refused)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    try {
      const result = await isDaemonRunning(DATA_DIR, 3000);
      expect(result).toEqual({ running: true, pid: 12345, healthy: false });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns running: true when process alive and health check passes', async () => {
    mockReadLock.mockReturnValue({ pid: 12345, startedAt: new Date().toISOString(), port: 3000 });
    mockIsProcessAlive.mockReturnValue(true);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'healthy' }),
    });

    try {
      const result = await isDaemonRunning(DATA_DIR, 3000);
      expect(result).toEqual({ running: true, pid: 12345 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses port from lock file when available', async () => {
    mockReadLock.mockReturnValue({ pid: 12345, startedAt: new Date().toISOString(), port: 4000 });
    mockIsProcessAlive.mockReturnValue(true);

    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
    globalThis.fetch = mockFetch;

    try {
      await isDaemonRunning(DATA_DIR, 3000);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4000/health',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts degraded status as running', async () => {
    mockReadLock.mockReturnValue({ pid: 12345, startedAt: new Date().toISOString(), port: 3000 });
    mockIsProcessAlive.mockReturnValue(true);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'degraded' }),
    });

    try {
      const result = await isDaemonRunning(DATA_DIR, 3000);
      expect(result).toEqual({ running: true, pid: 12345 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('getDaemonSessionToken', () => {
  it('returns the token when file exists', async () => {
    mockReadFileSync.mockReturnValue('  abc-session-token-123  \n');

    const token = await getDaemonSessionToken(DATA_DIR);
    expect(token).toBe('abc-session-token-123');
  });

  it('returns null when token file does not exist', async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const token = await getDaemonSessionToken(DATA_DIR);
    expect(token).toBeNull();
  });
});

describe('stopDaemon', () => {
  it('returns false when no lock file exists', async () => {
    mockReadLock.mockReturnValue(null);

    expect(await stopDaemon(DATA_DIR)).toBe(false);
  });

  it('returns false when process is not alive', async () => {
    mockReadLock.mockReturnValue({ pid: 99999, startedAt: new Date().toISOString(), port: 3000 });
    mockIsProcessAlive.mockReturnValue(false);

    expect(await stopDaemon(DATA_DIR)).toBe(false);
  });

  it('sends SIGTERM and returns true when process is alive', async () => {
    mockReadLock.mockReturnValue({ pid: 99999, startedAt: new Date().toISOString(), port: 3000 });
    mockIsProcessAlive.mockReturnValue(true);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    try {
      expect(await stopDaemon(DATA_DIR)).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(99999, 'SIGTERM');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('returns false and logs when EPERM', async () => {
    mockReadLock.mockReturnValue({ pid: 99999, startedAt: new Date().toISOString(), port: 3000 });
    mockIsProcessAlive.mockReturnValue(true);

    const err = new Error('EPERM') as NodeJS.ErrnoException;
    err.code = 'EPERM';
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => { throw err; });

    try {
      expect(await stopDaemon(DATA_DIR)).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe('writeReplacedMarker', () => {
  it('writes a JSON marker file with timestamp and reason', () => {
    writeReplacedMarker(DATA_DIR);

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const [path, content] = mockWriteFileSync.mock.calls[0];
    expect(path).toBe(join(DATA_DIR, '.replaced'));

    const parsed = JSON.parse(content as string);
    expect(parsed).toHaveProperty('at');
    expect(parsed.reason).toBe('Another device connected');
  });
});

describe('wasRecentlyReplaced', () => {
  it('returns false when marker file does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    expect(wasRecentlyReplaced(DATA_DIR)).toBe(false);
  });

  it('returns true when marker is recent', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ at: new Date().toISOString() }));

    expect(wasRecentlyReplaced(DATA_DIR)).toBe(true);
  });

  it('returns false when marker is old', () => {
    mockExistsSync.mockReturnValue(true);
    const oldDate = new Date(Date.now() - 600_000).toISOString(); // 10 min ago
    mockReadFileSync.mockReturnValue(JSON.stringify({ at: oldDate }));

    expect(wasRecentlyReplaced(DATA_DIR)).toBe(false);
  });

  it('respects custom withinMs parameter', () => {
    mockExistsSync.mockReturnValue(true);
    const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
    mockReadFileSync.mockReturnValue(JSON.stringify({ at: twoMinAgo }));

    // 1 minute window — marker at 2 min ago should be outside
    expect(wasRecentlyReplaced(DATA_DIR, 60_000)).toBe(false);
    // 3 minute window — marker at 2 min ago should be inside
    expect(wasRecentlyReplaced(DATA_DIR, 180_000)).toBe(true);
  });
});

describe('clearReplacedMarker', () => {
  it('deletes the marker file when it exists', () => {
    mockExistsSync.mockReturnValue(true);

    clearReplacedMarker(DATA_DIR);

    expect(mockUnlinkSync).toHaveBeenCalledWith(join(DATA_DIR, '.replaced'));
  });

  it('does nothing when marker does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    clearReplacedMarker(DATA_DIR);

    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// parseEnvFile
// ---------------------------------------------------------------------------

describe('parseEnvFile', () => {
  const mockReadFileSyncLocal = vi.mocked(readFileSync);

  it('parses KEY=VALUE pairs', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSyncLocal.mockReturnValue('OHWOW_AUTONOMY_CONDUCTOR=1\nFOO=bar\n');
    const result = parseEnvFile('/fake/conductor-on.env');
    expect(result).toEqual({ OHWOW_AUTONOMY_CONDUCTOR: '1', FOO: 'bar' });
  });

  it('skips blank lines and comment lines', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSyncLocal.mockReturnValue(
      '# This is a comment\n\nOHWOW_AUTONOMY_CONDUCTOR=1\n# another comment\n',
    );
    const result = parseEnvFile('/fake/conductor-on.env');
    expect(result).toEqual({ OHWOW_AUTONOMY_CONDUCTOR: '1' });
  });

  it('returns empty object when file is absent (readFileSync throws)', () => {
    mockReadFileSyncLocal.mockImplementation(() => { throw new Error('ENOENT'); });
    const result = parseEnvFile('/fake/missing.env');
    expect(result).toEqual({});
  });

  it('skips lines with no equals sign', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSyncLocal.mockReturnValue('NOT_A_VAR\nKEY=value\n');
    const result = parseEnvFile('/fake/conductor-on.env');
    expect(result).toEqual({ KEY: 'value' });
  });
});
