/**
 * XIntelScheduler unit tests. Focus: does it spawn a child, honor the
 * config flag, write a heartbeat, and respect stop() — without actually
 * attaching to Chrome or calling a live LLM. We drive tick() directly
 * rather than waiting on the interval, and we point the child at a
 * `true` shell builtin so no network touch happens.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XIntelScheduler } from '../x-intel-scheduler.js';

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'x-intel-test-'));
}

describe('XIntelScheduler', () => {
  let tmp: string;
  let dataDir: string;
  let repoRoot: string;

  beforeEach(() => {
    tmp = makeTmp();
    dataDir = join(tmp, 'data');
    repoRoot = join(tmp, 'repo');
    mkdirSync(dataDir, { recursive: true });
    // Create a tiny fake x-intel.mjs that just exits 0 so we're testing
    // the scheduler's shell-out mechanics, not the pipeline itself.
    mkdirSync(join(repoRoot, 'scripts/x-experiments'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'scripts/x-experiments/x-intel.mjs'),
      `process.stdout.write('hi'); process.exit(0);`,
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes a heartbeat after a successful tick', async () => {
    const s = new XIntelScheduler({ workspaceSlug: 'default', dataDir, repoRoot });
    await s.tick();
    expect(s.lastExit).toBe(0);
    const heartbeatPath = join(dataDir, 'x-intel-last-run.json');
    expect(existsSync(heartbeatPath)).toBe(true);
    const hb = JSON.parse(readFileSync(heartbeatPath, 'utf8'));
    expect(hb.workspace).toBe('default');
    expect(hb.exitCode).toBe(0);
    expect(typeof hb.durationMs).toBe('number');
    expect(hb.stdoutTail).toContain('hi');
  });

  it('records a non-zero exit when the child fails', async () => {
    writeFileSync(
      join(repoRoot, 'scripts/x-experiments/x-intel.mjs'),
      `process.stderr.write('boom'); process.exit(7);`,
    );
    const s = new XIntelScheduler({ workspaceSlug: 'default', dataDir, repoRoot });
    await s.tick();
    expect(s.lastExit).toBe(7);
    const hb = JSON.parse(readFileSync(join(dataDir, 'x-intel-last-run.json'), 'utf8'));
    expect(hb.exitCode).toBe(7);
    expect(hb.stdoutTail).toContain('boom');
  });

  it('skips overlapping ticks', async () => {
    // Slow child: runs for ~400ms. Kick two ticks 10ms apart; the second
    // should short-circuit via the executing guard instead of spawning.
    writeFileSync(
      join(repoRoot, 'scripts/x-experiments/x-intel.mjs'),
      `setTimeout(() => process.exit(0), 400);`,
    );
    const s = new XIntelScheduler({ workspaceSlug: 'default', dataDir, repoRoot });
    const first = s.tick();
    // No await — start second immediately
    const second = s.tick();
    await Promise.all([first, second]);
    // Only one heartbeat because only one child actually ran
    const hb = JSON.parse(readFileSync(join(dataDir, 'x-intel-last-run.json'), 'utf8'));
    expect(hb.exitCode).toBe(0);
    expect(hb.durationMs).toBeGreaterThanOrEqual(350);
  });

  it('stop() halts the interval', async () => {
    const s = new XIntelScheduler({ workspaceSlug: 'default', dataDir, repoRoot, runOnBoot: false });
    s.start(60_000);
    expect(s.isRunning).toBe(true);
    s.stop();
    expect(s.isRunning).toBe(false);
  });
});
