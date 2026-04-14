/**
 * ToolchainTestProbeExperiment — parameterized probe that runs an
 * orchestrator-tool test file via vitest and judges by exit code.
 *
 * Why this exists
 * ---------------
 * Phase 7-D's autonomous author had been emitting one full TypeScript
 * file per orchestrator-tool test via fillSubprocessHealthProbe — a
 * series of byte-identical classes whose only difference was the
 * tool slug. The audit reduced them to ~140 lines of parameterized
 * class plus a registry of `{ slug }` rows in
 * src/self-bench/registries/toolchain-test-registry.ts.
 *
 * Behavior is identical to the deleted per-tool classes:
 *   - 6h cadence (everyMs: 21600000, runOnBoot: true)
 *   - execSync the vitest command, capture stdout/stderr/exitCode
 *   - Verdict='fail' on non-zero exit; 'pass' on zero;
 *     'warning' when the repo root cannot be resolved
 *   - Subject = `subprocess:toolchain-tool-test-<slug>`,
 *     evidence carries the trailing 15 stdout/stderr lines for triage
 *
 * Identity
 * --------
 * Each registered instance gets the legacy id
 * `toolchain-tool-test-<slug>` so historical findings remain queryable
 * after the refactor.
 *
 * Ghost guard
 * -----------
 * The deleted per-tool classes included probes whose referenced test
 * files did NOT exist on disk — the previous a46f61a cleanup deleted
 * 9 such ghosts; this commit found 4 more (schedules, state,
 * synthesize-for-goal, whatsapp). The registry is the chokepoint:
 * only slugs whose test file exists are listed. The parameterized
 * test in __tests__/toolchain-test-probe.test.ts has an invariant
 * that asserts every registered slug resolves to a real file on disk,
 * so a future ghost cannot be silently appended.
 */

import { execSync } from 'node:child_process';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { getSelfCommitStatus } from '../self-commit.js';

/** Path inside the repo where orchestrator-tool tests live. */
export const TOOL_TESTS_DIR = 'src/orchestrator/tools/__tests__';

/** Default subprocess timeout for one vitest run. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Default cadence — every 6 hours, fires on boot. */
const DEFAULT_EVERY_MS = 6 * 60 * 60 * 1000;

interface ToolchainEvidence extends Record<string, unknown> {
  command: string;
  exit_code: number;
  stdout_lines: string[];
  stderr_lines: string[];
  duration_ms: number;
  repo_root: string | null;
  error?: string;
}

export interface ToolchainTestProbeConfig {
  /** Tool slug, e.g. 'agents' for src/orchestrator/tools/__tests__/agents.test.ts. */
  slug: string;
  /** Optional timeout override; defaults to 60s — generous for a single test file. */
  timeoutMs?: number;
}

export class ToolchainTestProbeExperiment implements Experiment {
  readonly id: string;
  readonly name: string;
  readonly category: ExperimentCategory = 'tool_reliability';
  readonly hypothesis: string;
  readonly cadence = { everyMs: DEFAULT_EVERY_MS, runOnBoot: true };

  private readonly slug: string;
  private readonly command: string;
  private readonly timeoutMs: number;

  constructor(config: ToolchainTestProbeConfig) {
    this.slug = config.slug;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.id = `toolchain-tool-test-${config.slug}`;
    this.name = `Tool test coverage: ${config.slug}`;
    this.command = `npx vitest run ${TOOL_TESTS_DIR}/${config.slug}.test.ts`;
    this.hypothesis = `${config.slug} tests at ${TOOL_TESTS_DIR}/${config.slug}.test.ts pass on every run.`;
  }

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const { repoRoot } = getSelfCommitStatus();
    const startMs = Date.now();

    if (!repoRoot) {
      const evidence: ToolchainEvidence = {
        command: this.command,
        exit_code: -1,
        stdout_lines: [],
        stderr_lines: [],
        duration_ms: 0,
        repo_root: null,
        error: 'repo root not configured',
      };
      return {
        subject: `subprocess:${this.id}`,
        summary: `Test coverage probe for ${this.slug}: repo root unavailable`,
        evidence,
      };
    }

    let exitCode = 0;
    let stdout = '';
    let stderr = '';

    try {
      stdout = execSync(this.command, {
        cwd: repoRoot,
        stdio: 'pipe',
        timeout: this.timeoutMs,
        encoding: 'utf-8',
      }).toString();
    } catch (err) {
      exitCode = (err as { status?: number }).status ?? 1;
      const execErr = err as { stdout?: Buffer | string; stderr?: Buffer | string };
      stdout = execErr.stdout ? String(execErr.stdout) : '';
      stderr = execErr.stderr ? String(execErr.stderr) : '';
      if (!stdout && !stderr && err instanceof Error) {
        stderr = err.message;
      }
    }

    const durationMs = Date.now() - startMs;
    const stdoutLines = stdout.split('\n').filter((l) => l.trim()).slice(-15);
    const stderrLines = stderr.split('\n').filter((l) => l.trim()).slice(-15);

    const evidence: ToolchainEvidence = {
      command: this.command,
      exit_code: exitCode,
      stdout_lines: stdoutLines,
      stderr_lines: stderrLines,
      duration_ms: durationMs,
      repo_root: repoRoot,
    };

    const summary =
      exitCode === 0
        ? `Test coverage probe for ${this.slug}: passed in ${durationMs}ms`
        : `Test coverage probe for ${this.slug}: failed (exit ${exitCode}) in ${durationMs}ms`;

    return {
      subject: `subprocess:${this.id}`,
      summary,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ToolchainEvidence;
    if (ev.repo_root === null) return 'warning';
    if (ev.exit_code !== 0) return 'fail';
    return 'pass';
  }
}
