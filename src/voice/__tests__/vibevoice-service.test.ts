/**
 * Tests for VibeVoice Service Manager
 *
 * Stress tests #1 (cold start / health lifecycle) and #2 (port collision).
 * Does NOT require actual Python or GPU — all subprocess calls are mocked.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

// Mock child_process before importing the service
const mockSpawn = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// Mock platform-utils
vi.mock('../../lib/platform-utils.js', () => ({
  findPythonCommand: () => 'python3',
  findPipCommand: () => 'pip3',
}));

// Mock logger
vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocks
const { VibeVoiceService } = await import('../vibevoice-service.js');

// Helper: create a mock ChildProcess
function createMockProcess() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    stdin: { end: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (!listeners[`stderr:${event}`]) listeners[`stderr:${event}`] = [];
        listeners[`stderr:${event}`].push(cb);
      }),
    },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    }),
    kill: vi.fn(),
    // helpers for tests
    _emit(event: string, ...args: unknown[]) {
      (listeners[event] || []).forEach((cb) => cb(...args));
    },
    _emitStderr(data: string) {
      (listeners['stderr:data'] || []).forEach((cb) => cb(Buffer.from(data)));
    },
  };
}

describe('VibeVoiceService', () => {
  let service: InstanceType<typeof VibeVoiceService>;
  let mockFetch: Mock;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockSpawn.mockReset();
    mockExecFileSync.mockReset();

    // Default: deps check passes
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    // Default: health check fails (server not running)
    mockFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    service = new VibeVoiceService({ port: 18001 });
  });

  describe('constructor', () => {
    it('defaults to port 8001', () => {
      const s = new VibeVoiceService();
      expect(s.getBaseUrl()).toBe('http://127.0.0.1:8001');
    });

    it('respects custom port', () => {
      const s = new VibeVoiceService({ port: 9999 });
      expect(s.getBaseUrl()).toBe('http://127.0.0.1:9999');
    });
  });

  describe('healthCheck()', () => {
    it('returns true when server responds ok', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
      );
      expect(await service.healthCheck()).toBe(true);
    });

    it('returns true when server responds healthy', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ status: 'healthy' }), { status: 200 }),
      );
      expect(await service.healthCheck()).toBe(true);
    });

    it('returns false on connection refused', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await service.healthCheck()).toBe(false);
    });

    it('returns false on HTTP 500', async () => {
      mockFetch.mockResolvedValue(
        new Response('error', { status: 500 }),
      );
      expect(await service.healthCheck()).toBe(false);
    });
  });

  describe('start() — Stress Test #1: Cold Start', () => {
    it('skips start if server is already healthy', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
      );

      await service.start();

      // Should NOT spawn a new process
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('spawns uvicorn on correct port with correct args', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      // First health check: server not running. After spawn: server healthy.
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) return Promise.reject(new Error('ECONNREFUSED'));
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
        );
      });

      await service.start();

      expect(mockSpawn).toHaveBeenCalledWith(
        'python3',
        ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', '18001', '--log-level', 'warning'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );
    });

    it('checks dependencies before spawning', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) return Promise.reject(new Error('ECONNREFUSED'));
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
        );
      });

      await service.start();

      // Should check for transformers and torch (not whisper like Voicebox)
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'python3',
        ['-c', 'import fastapi; import uvicorn; import transformers; import torch'],
        expect.any(Object),
      );
    });

    it('auto-installs deps via pip when imports fail', async () => {
      // First call (import check) fails, second call is pip install
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('ModuleNotFoundError'); })
        .mockReturnValue(Buffer.from(''));

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) return Promise.reject(new Error('ECONNREFUSED'));
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
        );
      });

      await service.start();

      // Should have called pip install
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'pip3',
        ['install', '-r', expect.stringContaining('requirements.txt')],
        expect.objectContaining({ timeout: 600000 }),
      );
    });

    it('concurrent start() calls are deduplicated', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) return Promise.reject(new Error('ECONNREFUSED'));
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
        );
      });

      // Fire two starts simultaneously
      await Promise.all([service.start(), service.start()]);

      // Should only spawn once
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('start() — Stress Test #2: Port Collision', () => {
    it('fast-fails when port is already in use', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      // Simulate stderr: "address already in use"
      setTimeout(() => {
        mockProc._emitStderr('ERROR: [Errno 48] error while attempting to bind on address ("127.0.0.1", 18001): address already in use');
      }, 50);

      await expect(service.start()).rejects.toThrow(
        'Port 18001 is already in use',
      );

      // Process should have been killed
      expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('fast-fails on "port is already in use" variant', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      setTimeout(() => {
        mockProc._emitStderr('Port is already in use: 18001');
      }, 50);

      await expect(service.start()).rejects.toThrow(
        'Port 18001 is already in use',
      );
    });

    it('fast-fails if process exits during startup', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      // Process exits immediately
      setTimeout(() => {
        mockProc._emit('exit', 1);
      }, 50);

      await expect(service.start()).rejects.toThrow(
        'VibeVoice server process exited during startup',
      );
    });
  });

  describe('stop()', () => {
    it('sends SIGTERM then cleans up', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      // Start the service first
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) return Promise.reject(new Error('ECONNREFUSED'));
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
        );
      });

      await service.start();

      // Simulate process exiting on SIGTERM
      mockProc.kill.mockImplementation(() => {
        setTimeout(() => mockProc._emit('exit', 0), 10);
      });

      await service.stop();

      expect(mockProc.stdin.end).toHaveBeenCalled();
      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('does nothing if not running', async () => {
      // Should not throw
      await service.stop();
    });
  });

  describe('ensureRunning()', () => {
    it('reuses existing healthy process', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      // First start
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) return Promise.reject(new Error('ECONNREFUSED'));
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
        );
      });

      await service.start();
      mockSpawn.mockClear();

      // ensureRunning should not spawn again
      await service.ensureRunning();
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });
});
