/**
 * shell_script dispatcher tests. Real subprocess spawns against a tiny
 * fake script written to a temp dir so we exercise the actual spawn +
 * env + exit code machinery rather than mocking it away.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellScriptDispatcher } from '../dispatchers/shell-script.js';
import type { DispatcherDeps } from '../action-dispatcher.js';
import type { LocalTrigger } from '../../webhooks/ghl-types.js';

const deps = {} as DispatcherDeps; // dispatcher doesn't touch deps
const trigger = { id: 'test-trigger', name: 'test' } as LocalTrigger;

describe('shellScriptDispatcher', () => {
  let tmp: string;
  let scriptDir: string;
  let cwdBefore: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shell-script-test-'));
    scriptDir = join(tmp, 'scripts');
    mkdirSync(scriptDir, { recursive: true });
    cwdBefore = process.cwd();
    // Pin OHWOW_REPO_ROOT so the dispatcher resolves scripts out of our tmp
    // tree rather than the real repo.
    process.env.OHWOW_REPO_ROOT = tmp;
  });

  afterEach(() => {
    process.chdir(cwdBefore);
    delete process.env.OHWOW_REPO_ROOT;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('runs a script and returns exit_code + stdout_tail on success', async () => {
    writeFileSync(
      join(scriptDir, 'hello.mjs'),
      `process.stdout.write('hello-out'); process.exit(0);`,
    );
    const out = await shellScriptDispatcher.execute(
      { script_path: 'scripts/hello.mjs' },
      {},
      deps,
      trigger,
    );
    expect(out.exit_code).toBe(0);
    expect(out.status).toBe('ok');
    expect(out.stdout_tail).toContain('hello-out');
    expect(typeof out.duration_ms).toBe('number');
  });

  it('throws with status=nonzero_exit when the script fails', async () => {
    writeFileSync(
      join(scriptDir, 'fail.mjs'),
      `process.stderr.write('boom'); process.exit(3);`,
    );
    await expect(
      shellScriptDispatcher.execute(
        { script_path: 'scripts/fail.mjs' },
        {},
        deps,
        trigger,
      ),
    ).rejects.toThrow(/nonzero_exit.*exit=3/);
  });

  it('injects OHWOW_WORKSPACE + OHWOW_PORT into the child env', async () => {
    writeFileSync(
      join(scriptDir, 'env.mjs'),
      `process.stdout.write('ws=' + process.env.OHWOW_WORKSPACE + ' port=' + process.env.OHWOW_PORT); process.exit(0);`,
    );
    process.env.OHWOW_PORT = '9911';
    const out = await shellScriptDispatcher.execute(
      { script_path: 'scripts/env.mjs', workspace_slug: 'test-ws' },
      {},
      deps,
      trigger,
    );
    delete process.env.OHWOW_PORT;
    expect(out.stdout_tail).toContain('ws=test-ws');
    expect(out.stdout_tail).toContain('port=9911');
  });

  it('passes config.env overrides on top of the ohwow env', async () => {
    writeFileSync(
      join(scriptDir, 'custom.mjs'),
      `process.stdout.write('shape=' + (process.env.SHAPES || '-')); process.exit(0);`,
    );
    const out = await shellScriptDispatcher.execute(
      {
        script_path: 'scripts/custom.mjs',
        workspace_slug: 'test-ws',
        env: { SHAPES: 'humor' },
      },
      {},
      deps,
      trigger,
    );
    expect(out.stdout_tail).toContain('shape=humor');
  });

  it('rejects config missing script_path', async () => {
    await expect(
      shellScriptDispatcher.execute({}, {}, deps, trigger),
    ).rejects.toThrow(/invalid config/);
  });

  it('times out and throws when the script outlasts timeout_seconds', async () => {
    writeFileSync(
      join(scriptDir, 'hang.mjs'),
      `setInterval(() => {}, 1000); /* never exits */`,
    );
    await expect(
      shellScriptDispatcher.execute(
        { script_path: 'scripts/hang.mjs', timeout_seconds: 1 },
        {},
        deps,
        trigger,
      ),
    ).rejects.toThrow(/timeout/);
  }, 15_000);
});
