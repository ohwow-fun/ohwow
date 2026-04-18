import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let stateDir: string;
let stateFile: string;

describe('ohwow x-throttle-status CLI', () => {
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'ohwow-x-throttle-cli-'));
    stateFile = join(stateDir, 'x-search-throttle.json');
    process.env.OHWOW_X_SEARCH_THROTTLE_FILE = stateFile;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.OHWOW_X_SEARCH_THROTTLE_FILE;
    rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('prints "ok (not throttled)" when the state file is empty', async () => {
    const { runXThrottleStatusCli } = await import('../x-throttle-status.js');
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    runXThrottleStatusCli([]);
    spy.mockRestore();
    expect(logs.some((l) => l.includes('ok (not throttled)'))).toBe(true);
  });

  it('prints a "clears in" line when throttled', async () => {
    // Write a throttled state with 15 minutes remaining.
    const until = new Date(Date.now() + 15 * 60 * 1_000).toISOString();
    writeFileSync(
      stateFile,
      JSON.stringify({
        throttled_until: until,
        consecutive_hits: 1,
        last_hit_at: new Date().toISOString(),
        last_hit_url: 'https://x.com/search?q=test',
      }),
      'utf8',
    );

    const { runXThrottleStatusCli } = await import('../x-throttle-status.js');
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    runXThrottleStatusCli([]);
    spy.mockRestore();

    const joined = logs.join('\n');
    expect(joined).toContain('throttled');
    expect(joined).toContain('clears in:');
  });

  it('emits valid JSON under --json', async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        throttled_until: null,
        consecutive_hits: 0,
        last_hit_at: null,
      }),
      'utf8',
    );

    const { runXThrottleStatusCli } = await import('../x-throttle-status.js');
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    runXThrottleStatusCli(['--json']);
    spy.mockRestore();

    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed).toMatchObject({
      throttled: false,
      consecutive_hits: 0,
      remaining_ms: 0,
    });
    expect(parsed.state_file).toBe(stateFile);
  });
});
