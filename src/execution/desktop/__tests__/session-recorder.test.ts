import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process and fs before importing SessionRecorder. Without the fs
// mock, tests that reach the success path would call mkdirSync against the
// real filesystem — either /tmp or (worse) ~/.ohwow/media/desktop-recordings.
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 0 })),
}));

import { execSync, spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { SessionRecorder } from '../session-recorder.js';

const mockExecSync = vi.mocked(execSync);
const mockSpawn = vi.mocked(spawn);
const mockMkdirSync = vi.mocked(mkdirSync);

// Use an isolated fake directory for any test that needs a dataDir. The fs
// mock intercepts mkdirSync so nothing hits disk either way, but passing an
// explicit dataDir also prevents the DEFAULT_RECORDING_DIR code path (which
// resolves to the user's real ~/.ohwow/media/desktop-recordings).
const TEST_DATA_DIR = '/tmp/ohwow-test-session-recorder';

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
    await recorder.start('test-session', TEST_DATA_DIR);

    expect(recorder.isRecording()).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-f', 'avfoundation', '-framerate', '15']),
      expect.objectContaining({ stdio: ['pipe', 'ignore', 'ignore'] }),
    );
    // mkdirSync must have been called against the isolated test dir, not
    // against the real ~/.ohwow default. Guards against regressions that
    // would write into the user's home while running tests.
    expect(mockMkdirSync).toHaveBeenCalled();
    const firstCallPath = mockMkdirSync.mock.calls[0]?.[0];
    expect(String(firstCallPath)).toContain(TEST_DATA_DIR);
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
    await recorder.start('s1', TEST_DATA_DIR);
    await recorder.start('s2', TEST_DATA_DIR);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});
