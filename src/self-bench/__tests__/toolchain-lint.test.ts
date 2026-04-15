import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExperimentContext } from '../experiment-types.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../self-commit.js', () => ({
  getSelfCommitStatus: vi.fn(() => ({
    killSwitchOpen: false,
    repoRootConfigured: true,
    repoRoot: '/fake/repo',
    allowedPathPrefixes: [],
    auditLogPath: '/fake/log',
  })),
}));

import { execSync } from 'node:child_process';
import { getSelfCommitStatus } from '../self-commit.js';
import { ToolchainLintExperiment } from '../experiments/toolchain-lint.js';

function makeCtx(): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {} as any,
    workspaceId: 'ws-test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async () => [],
  };
}

describe('ToolchainLintExperiment (auto-generated)', () => {
  const exp = new ToolchainLintExperiment();

  beforeEach(() => {
    vi.mocked(getSelfCommitStatus).mockReturnValue({
      killSwitchOpen: false,
      repoRootConfigured: true,
      repoRoot: '/fake/repo',
      allowedPathPrefixes: [],
      auditLogPath: '/fake/log',
    });
  });

  it('returns pass when command exits 0', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from('all good\n') as unknown as string);
    const result = await exp.probe(makeCtx());
    expect(exp.judge(result, [])).toBe('pass');
    const ev = result.evidence as { exit_code: number; command: string };
    expect(ev.exit_code).toBe(0);
    expect(ev.command).toBe('npm run lint');
  });

  it('returns fail when command exits non-zero', async () => {
    const err = Object.assign(new Error('failed'), {
      status: 1,
      stdout: Buffer.from('error output\n'),
      stderr: Buffer.from('stderr line\n'),
    });
    vi.mocked(execSync).mockImplementation(() => { throw err; });
    const result = await exp.probe(makeCtx());
    expect(exp.judge(result, [])).toBe('fail');
    const ev = result.evidence as { exit_code: number; stderr_lines: string[] };
    expect(ev.exit_code).toBe(1);
    expect(ev.stderr_lines.length).toBeGreaterThan(0);
  });

  it('returns warning when repo root is unavailable', async () => {
    vi.mocked(getSelfCommitStatus).mockReturnValue({
      killSwitchOpen: false,
      repoRootConfigured: false,
      repoRoot: null,
      allowedPathPrefixes: [],
      auditLogPath: '/fake/log',
    });
    const result = await exp.probe(makeCtx());
    expect(exp.judge(result, [])).toBe('warning');
    const ev = result.evidence as { repo_root: null; error: string };
    expect(ev.repo_root).toBeNull();
    expect(ev.error).toContain('repo root');
  });

  it('evidence exposes command and duration', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from('') as unknown as string);
    const result = await exp.probe(makeCtx());
    const ev = result.evidence as { command: string; duration_ms: number };
    expect(ev.command).toBe('npm run lint');
    expect(typeof ev.duration_ms).toBe('number');
  });
});