/**
 * Tests for ToolchainTestProbeExperiment + the registry it consumes.
 *
 * Replaces the 8 templated per-slug test files with one parameterized
 * file plus a registry-coverage test that pins the ghost-prevention
 * invariant: every registered slug must resolve to a real test file on
 * disk. This is the structural fix for the bug a46f61a cleaned up
 * manually — once the registry is the chokepoint, a future ghost
 * slug fails CI before it can land.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  ToolchainTestProbeExperiment,
  TOOL_TESTS_DIR,
} from '../experiments/toolchain-test-probe.js';
import { TOOLCHAIN_TEST_REGISTRY } from '../registries/toolchain-test-registry.js';
import * as selfCommit from '../self-commit.js';
import type { ExperimentContext } from '../experiment-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

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

describe('ToolchainTestProbeExperiment — parameterized', () => {
  const sampleConfig = { slug: 'agents' };

  it('exposes a stable id derived from the slug', () => {
    const exp = new ToolchainTestProbeExperiment(sampleConfig);
    expect(exp.id).toBe('toolchain-tool-test-agents');
    expect(exp.name).toBe('Tool test coverage: agents');
  });

  it('builds the expected vitest command from the slug', async () => {
    // Spy on getSelfCommitStatus so probe doesn't actually shell out.
    const spy = vi.spyOn(selfCommit, 'getSelfCommitStatus').mockReturnValue({
      killSwitchOpen: false,
      repoRootConfigured: false,
      repoRoot: null,
      allowedPathPrefixes: [],
      auditLogPath: '/tmp/test-audit',
    });
    try {
      const exp = new ToolchainTestProbeExperiment(sampleConfig);
      const result = await exp.probe(makeCtx());
      const ev = result.evidence as { command: string };
      expect(ev.command).toBe(`npx vitest run ${TOOL_TESTS_DIR}/agents.test.ts`);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns warning when repo root is unavailable (no shell-out attempted)', async () => {
    const spy = vi.spyOn(selfCommit, 'getSelfCommitStatus').mockReturnValue({
      killSwitchOpen: false,
      repoRootConfigured: false,
      repoRoot: null,
      allowedPathPrefixes: [],
      auditLogPath: '/tmp/test-audit',
    });
    try {
      const exp = new ToolchainTestProbeExperiment(sampleConfig);
      const result = await exp.probe(makeCtx());
      expect(exp.judge(result, [])).toBe('warning');
      const ev = result.evidence as { exit_code: number; error?: string };
      expect(ev.exit_code).toBe(-1);
      expect(ev.error).toContain('repo root not configured');
    } finally {
      spy.mockRestore();
    }
  });

  it('judge maps exit codes to verdicts correctly', () => {
    const exp = new ToolchainTestProbeExperiment(sampleConfig);
    const passingResult = {
      summary: 'ok',
      evidence: { exit_code: 0, repo_root: '/repo' },
    };
    const failingResult = {
      summary: 'fail',
      evidence: { exit_code: 1, repo_root: '/repo' },
    };
    const noRepoResult = {
      summary: 'no repo',
      evidence: { exit_code: -1, repo_root: null },
    };
    expect(exp.judge(passingResult, [])).toBe('pass');
    expect(exp.judge(failingResult, [])).toBe('fail');
    expect(exp.judge(noRepoResult, [])).toBe('warning');
  });
});

describe('TOOLCHAIN_TEST_REGISTRY — invariants', () => {
  it('every row instantiates a probe with a unique id', () => {
    const ids = TOOLCHAIN_TEST_REGISTRY.map(
      (c) => new ToolchainTestProbeExperiment(c).id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every slug references a real test file on disk (ghost guard)', () => {
    // The structural fix for the a46f61a class of bug. Any future ghost
    // appended to the registry fails this assertion before the daemon
    // ever registers a permanent-fail probe.
    for (const row of TOOLCHAIN_TEST_REGISTRY) {
      const testFile = join(REPO_ROOT, TOOL_TESTS_DIR, `${row.slug}.test.ts`);
      expect(existsSync(testFile), `missing test file for slug='${row.slug}': ${testFile}`).toBe(true);
    }
  });
});
