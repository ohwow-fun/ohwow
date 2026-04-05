import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';

// Mock child_process before importing the module
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

// Mock logger
vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocking
const { detectClaudeCode, isClaudeCodeCliAvailable, resetClaudeCodeCache, getCachedClaudeCodeStatus } = await import('../adapters/claude-code-detection.js');

const mockExecFileSync = vi.mocked(execFileSync);

describe('claude-code-detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClaudeCodeCache();
  });

  describe('detectClaudeCode', () => {
    it('detects claude when binary is in PATH and authenticated', async () => {
      // which claude
      mockExecFileSync.mockReturnValueOnce('/usr/local/bin/claude');
      // claude --version
      mockExecFileSync.mockReturnValueOnce('1.0.23');
      // claude --print "test" (auth check)
      mockExecFileSync.mockReturnValueOnce('{"result":"ok"}');

      const status = await detectClaudeCode();
      expect(status.available).toBe(true);
      expect(status.binaryPath).toBe('/usr/local/bin/claude');
      expect(status.version).toBe('1.0.23');
      expect(status.authenticated).toBe(true);
    });

    it('returns unavailable when binary not found', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });

      const status = await detectClaudeCode();
      expect(status.available).toBe(false);
      expect(status.binaryPath).toBeNull();
    });

    it('returns unavailable when not authenticated', async () => {
      // which claude
      mockExecFileSync.mockReturnValueOnce('/usr/local/bin/claude');
      // claude --version
      mockExecFileSync.mockReturnValueOnce('1.0.23');
      // claude --print (auth check fails)
      mockExecFileSync.mockImplementationOnce(() => { throw new Error('not authenticated'); });

      const status = await detectClaudeCode();
      expect(status.available).toBe(false);
      expect(status.binaryPath).toBe('/usr/local/bin/claude');
      expect(status.version).toBe('1.0.23');
      expect(status.authenticated).toBe(false);
    });

    it('uses custom path when provided', async () => {
      // Custom path version check (findBinary calls --version to verify)
      mockExecFileSync.mockReturnValueOnce('1.0.0');
      // claude --version (getVersion)
      mockExecFileSync.mockReturnValueOnce('1.0.0');
      // claude --print (auth check)
      mockExecFileSync.mockReturnValueOnce('ok');

      const status = await detectClaudeCode('/custom/claude');
      expect(status.available).toBe(true);
      expect(status.binaryPath).toBe('/custom/claude');
    });

    it('caches result and returns cached on subsequent calls', async () => {
      mockExecFileSync.mockReturnValueOnce('/usr/local/bin/claude');
      mockExecFileSync.mockReturnValueOnce('1.0.0');
      mockExecFileSync.mockReturnValueOnce('ok');

      const first = await detectClaudeCode();
      expect(first.available).toBe(true);

      // Second call should not trigger new subprocess calls
      const callCountBefore = mockExecFileSync.mock.calls.length;
      const second = await detectClaudeCode();
      expect(second.available).toBe(true);
      expect(mockExecFileSync.mock.calls.length).toBe(callCountBefore);
    });
  });

  describe('isClaudeCodeCliAvailable', () => {
    it('returns false when cache is empty', () => {
      expect(isClaudeCodeCliAvailable()).toBe(false);
    });

    it('returns true after successful detection', async () => {
      mockExecFileSync.mockReturnValueOnce('/usr/local/bin/claude');
      mockExecFileSync.mockReturnValueOnce('1.0.0');
      mockExecFileSync.mockReturnValueOnce('ok');

      await detectClaudeCode();
      expect(isClaudeCodeCliAvailable()).toBe(true);
    });

    it('returns false after failed detection', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });

      await detectClaudeCode();
      expect(isClaudeCodeCliAvailable()).toBe(false);
    });
  });

  describe('getCachedClaudeCodeStatus', () => {
    it('returns null when no detection has run', () => {
      expect(getCachedClaudeCodeStatus()).toBeNull();
    });

    it('returns full status after detection', async () => {
      mockExecFileSync.mockReturnValueOnce('/usr/local/bin/claude');
      mockExecFileSync.mockReturnValueOnce('1.0.23');
      mockExecFileSync.mockReturnValueOnce('ok');

      await detectClaudeCode();
      const status = getCachedClaudeCodeStatus();
      expect(status).not.toBeNull();
      expect(status!.version).toBe('1.0.23');
    });
  });

  describe('resetClaudeCodeCache', () => {
    it('clears cache so next call re-detects', async () => {
      mockExecFileSync.mockReturnValueOnce('/usr/local/bin/claude');
      mockExecFileSync.mockReturnValueOnce('1.0.0');
      mockExecFileSync.mockReturnValueOnce('ok');

      await detectClaudeCode();
      expect(isClaudeCodeCliAvailable()).toBe(true);

      resetClaudeCodeCache();
      expect(isClaudeCodeCliAvailable()).toBe(false);
      expect(getCachedClaudeCodeStatus()).toBeNull();
    });
  });
});
