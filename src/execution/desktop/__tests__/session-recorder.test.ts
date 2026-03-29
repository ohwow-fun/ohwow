import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing SessionRecorder
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execSync, spawn } from 'child_process';
import { SessionRecorder } from '../session-recorder.js';

const mockExecSync = vi.mocked(execSync);
const mockSpawn = vi.mocked(spawn);

describe('SessionRecorder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the static cache by accessing internal state
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (SessionRecorder as any).ffmpegAvailable = null;
  });

  it('isRecording() returns false initially', () => {
    const recorder = new SessionRecorder();
    expect(recorder.isRecording()).toBe(false);
  });

  it('stop() returns null when not recording', async () => {
    const recorder = new SessionRecorder();
    const result = await recorder.stop();
    expect(result).toBeNull();
  });

  it('gracefully degrades when FFmpeg is not found', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found: ffmpeg');
    });

    const recorder = new SessionRecorder();
    await recorder.start('test-session');

    expect(recorder.isRecording()).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('caches FFmpeg availability check', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });

    const recorder1 = new SessionRecorder();
    await recorder1.start('s1');

    const recorder2 = new SessionRecorder();
    await recorder2.start('s2');

    // which ffmpeg should only be called once (cached after first check)
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });

  it('spawns FFmpeg when available', async () => {
    mockExecSync.mockReturnValue('/usr/local/bin/ffmpeg');

    const mockProcess = {
      on: vi.fn(),
      stdin: { write: vi.fn(), end: vi.fn() },
      killed: false,
      kill: vi.fn(),
    };
    mockSpawn.mockReturnValue(mockProcess as never);

    const recorder = new SessionRecorder();
    await recorder.start('test-session', '/tmp/test-data');

    expect(recorder.isRecording()).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-f', 'avfoundation', '-framerate', '15']),
      expect.objectContaining({ stdio: ['pipe', 'ignore', 'ignore'] }),
    );
  });

  it('does not start twice', async () => {
    mockExecSync.mockReturnValue('/usr/local/bin/ffmpeg');
    const mockProcess = {
      on: vi.fn(),
      stdin: { write: vi.fn(), end: vi.fn() },
      killed: false,
      kill: vi.fn(),
    };
    mockSpawn.mockReturnValue(mockProcess as never);

    const recorder = new SessionRecorder();
    await recorder.start('s1');
    await recorder.start('s2');

    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});
