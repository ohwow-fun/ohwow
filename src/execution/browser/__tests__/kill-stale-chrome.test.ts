/**
 * Freeze tests: killStaleDebugChrome behavior (impl commit 6987b08).
 *
 * Three scenarios are frozen:
 *  1. Stale Chrome (no --remote-debugging-port in ps args) → SIGTERM sent,
 *     stale-chrome-killed warn logged.
 *  2. Legit Chrome (has --remote-debugging-port in ps args) → NOT killed
 *     (early return before any kill -TERM).
 *  3. No Chrome running (findDebugChromePid returns null) → no kill attempt
 *     at all.
 *
 * Strategy: mock node:child_process so execCapture resolves instantly
 * with controlled stdout, and mock the logger to capture warn calls.
 * killStaleDebugChrome is exported from chrome-lifecycle for this purpose.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Logger mock — must be hoisted so the factory runs before module imports.
// ---------------------------------------------------------------------------

const { mockWarn } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    trace: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// child_process mock — intercept exec() so we can control ps output and
// capture kill commands without actually touching any real process.
// ---------------------------------------------------------------------------

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const execMock = vi.fn<any>();

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  return {
    ...orig,
    exec: execMock,
    // spawn is used by spawnDebugChrome, not under test here.
    spawn: vi.fn(() => ({ unref: vi.fn() })),
  };
});

// ---------------------------------------------------------------------------
// chrome-profile-ledger mock — appendChromeProfileEvent is void side effect.
// ---------------------------------------------------------------------------

vi.mock('../chrome-profile-ledger.js', () => ({
  appendChromeProfileEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEBUG_DATA_DIR = join(homedir(), '.ohwow', 'chrome-debug');

/**
 * Set up execMock to respond deterministically per-command.
 * The map key is a substring that uniquely identifies the shell command.
 */
function mockExecResponses(responses: Record<string, { stdout: string; code?: number }>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execMock.mockImplementation((...args: any[]) => {
    const cmd = args[0] as string;
    const cb = args[args.length - 1] as ExecCallback;
    for (const [key, val] of Object.entries(responses)) {
      if (cmd.includes(key)) {
        const err = val.code && val.code !== 0 ? Object.assign(new Error('exit'), { code: val.code }) : null;
        cb(err, val.stdout, '');
        return;
      }
    }
    // Default: command not found / no output.
    cb(Object.assign(new Error('not found'), { code: 1 }), '', '');
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('killStaleDebugChrome', () => {
  beforeEach(() => {
    execMock.mockReset();
    mockWarn.mockClear();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('scenario 1: stale Chrome (no --remote-debugging-port) → SIGTERM sent + warn logged', async () => {
    const pid = 12345;
    const stalePsArgs = `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${DEBUG_DATA_DIR} --profile-directory=Default`;

    // pgrep → one pid
    // ps -o command= for findDebugChromePid → has --user-data-dir but no --type=
    // ps -o args= for killStaleDebugChrome → stale args (no --remote-debugging-port)
    // kill -TERM → success
    // kill -0 (liveness check) → process gone (code 1 = not found)
    mockExecResponses({
      'pgrep': { stdout: `${pid}\n`, code: 0 },
      'ps -o command=': { stdout: stalePsArgs, code: 0 },
      'ps -o args=': { stdout: stalePsArgs, code: 0 },
      'kill -TERM': { stdout: '', code: 0 },
      'kill -0': { stdout: '', code: 1 },   // process gone → exit loop
    });

    const { killStaleDebugChrome } = await import('../chrome-lifecycle.js');
    await killStaleDebugChrome();

    // Must have logged the stale-chrome-killed warn
    const warnCalls = mockWarn.mock.calls;
    const staleCalls = warnCalls.filter(
      (args) =>
        args[0] &&
        typeof args[0] === 'object' &&
        (args[0] as Record<string, unknown>).cdp === true &&
        (args[0] as Record<string, unknown>).action === 'stale-chrome-killed' &&
        (args[0] as Record<string, unknown>).pid === pid,
    );
    expect(staleCalls).toHaveLength(1);
    expect(staleCalls[0][0]).toMatchObject({
      cdp: true,
      action: 'stale-chrome-killed',
      pid,
      profile: 'Default',
    });

    // SIGTERM must have been sent
    const allCmds: string[] = execMock.mock.calls.map((c: unknown[]) => c[0] as string);
    const killTermCmds = allCmds.filter((cmd) => cmd.includes('kill -TERM'));
    expect(killTermCmds).toHaveLength(1);
    expect(killTermCmds[0]).toContain(String(pid));
  });

  it('scenario 2: legit Chrome (has --remote-debugging-port) → NOT killed, no warn', async () => {
    const pid = 54321;
    const legitPsArgs =
      `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${DEBUG_DATA_DIR} --profile-directory=Default --remote-debugging-port=9222 --no-first-run`;

    mockExecResponses({
      'pgrep': { stdout: `${pid}\n`, code: 0 },
      'ps -o command=': { stdout: legitPsArgs, code: 0 },
      'ps -o args=': { stdout: legitPsArgs, code: 0 },
    });

    const { killStaleDebugChrome } = await import('../chrome-lifecycle.js');
    await killStaleDebugChrome();

    // No stale-chrome-killed warn logged
    const warnCalls = mockWarn.mock.calls;
    const staleCalls = warnCalls.filter(
      (args) =>
        args[0] &&
        typeof args[0] === 'object' &&
        (args[0] as Record<string, unknown>).action === 'stale-chrome-killed',
    );
    expect(staleCalls).toHaveLength(0);

    // No kill -TERM sent
    const allCmds2: string[] = execMock.mock.calls.map((c: unknown[]) => c[0] as string);
    const killTermCmds2 = allCmds2.filter((cmd) => cmd.includes('kill -TERM'));
    expect(killTermCmds2).toHaveLength(0);
  });

  it('scenario 3: no Chrome running (pid null) → no exec kill attempt', async () => {
    // pgrep returns empty (no pids)
    mockExecResponses({
      'pgrep': { stdout: '', code: 1 },
    });

    const { killStaleDebugChrome } = await import('../chrome-lifecycle.js');
    await killStaleDebugChrome();

    // No kill commands should have been run
    const allCmds3: string[] = execMock.mock.calls.map((c: unknown[]) => c[0] as string);
    const killCmds3 = allCmds3.filter((cmd) => cmd.includes('kill'));
    expect(killCmds3).toHaveLength(0);

    // No warn logged
    const staleCalls = mockWarn.mock.calls.filter(
      (args) =>
        args[0] &&
        typeof args[0] === 'object' &&
        (args[0] as Record<string, unknown>).action === 'stale-chrome-killed',
    );
    expect(staleCalls).toHaveLength(0);
  });
});
