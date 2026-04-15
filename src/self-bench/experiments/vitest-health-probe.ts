/**
 * VitestHealthProbeExperiment — runs the vitest suite as an observable
 * signal inside the autonomous loop.
 *
 * Probe spawns `npx vitest run --reporter=json --silent` against a
 * scoped glob (defaults to the self-bench area) with a hard timeout,
 * then parses the JSON summary. For every failing test file it emits a
 * finding whose affected_files includes the test path (tier-1 modify-
 * allowed via MODIFY_ALLOWED_EXACT_PATHS, so the author loop can
 * propose fixes) and, when derivable, the sibling source path.
 *
 * This is the "tool" the loop uses to discover broken tests. Paired
 * with TestCoverageProbeExperiment it closes a second feedback loop:
 * one surface flags failures, the other flags missing coverage, and
 * the authoring pipeline can react to either.
 *
 * Cadence default 30min. Kept observe-only (no intervene) so the probe
 * surfaces signal without racing the patch author.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { getSelfCommitStatus } from '../self-commit.js';

const execFileP = promisify(execFile);

const DEFAULT_TEST_GLOB = 'src/self-bench/__tests__/**/*.test.ts';
const DEFAULT_TIMEOUT_MS = 180_000;

export interface VitestFailure {
  testFile: string;
  failedAssertions: number;
  firstMessage: string | null;
}

export interface VitestHealthEvidence extends Record<string, unknown> {
  affected_files: string[];
  total_tests: number;
  passed_tests: number;
  failed_tests: number;
  failing_files: VitestFailure[];
  runner_error: string | null;
  test_glob: string;
}

interface VitestJsonAssertion {
  status?: string;
  fullName?: string;
  failureMessages?: string[];
}
interface VitestJsonTestResult {
  name?: string;
  status?: string;
  assertionResults?: VitestJsonAssertion[];
}
interface VitestJsonSummary {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  success?: boolean;
  testResults?: VitestJsonTestResult[];
}

export class VitestHealthProbeExperiment implements Experiment {
  readonly id = 'vitest-health-probe';
  readonly name = 'Vitest suite health';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'Autonomous patches that introduce a failing test should surface as ' +
    'fail findings within one cadence so the patch author can react before ' +
    'the failure compounds.';
  readonly cadence = { everyMs: 30 * 60 * 1000, runOnBoot: false };

  constructor(
    private readonly testGlob: string = DEFAULT_TEST_GLOB,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const { repoRoot } = getSelfCommitStatus();
    if (!repoRoot) {
      return {
        subject: 'meta:vitest',
        summary: 'no repo root configured',
        evidence: emptyEvidence(this.testGlob, 'no repo root'),
      };
    }
    const run = await runVitestJson(repoRoot, this.testGlob, this.timeoutMs);
    if (run.error && !run.json) {
      return {
        subject: 'meta:vitest',
        summary: `vitest runner error: ${run.error}`,
        evidence: emptyEvidence(this.testGlob, run.error),
      };
    }
    const summary = run.json ?? {};
    const failing = parseFailingFiles(summary, repoRoot);
    const evidence: VitestHealthEvidence = {
      affected_files: failing.flatMap((f) => [f.testFile, ...maybeSiblingSource(f.testFile)]),
      total_tests: summary.numTotalTests ?? 0,
      passed_tests: summary.numPassedTests ?? 0,
      failed_tests: summary.numFailedTests ?? 0,
      failing_files: failing,
      runner_error: run.error ?? null,
      test_glob: this.testGlob,
    };
    const descriptor =
      evidence.failed_tests === 0
        ? `all ${evidence.passed_tests} tests passing`
        : `${evidence.failed_tests} failing / ${evidence.total_tests} total across ${failing.length} file(s)`;
    return { subject: 'meta:vitest', summary: descriptor, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as VitestHealthEvidence;
    if (ev.runner_error && !ev.total_tests) return 'warning';
    return ev.failed_tests > 0 ? 'fail' : 'pass';
  }
}

export async function runVitestJson(
  repoRoot: string,
  testGlob: string,
  timeoutMs: number,
): Promise<{ json: VitestJsonSummary | null; error: string | null }> {
  try {
    const { stdout } = await execFileP(
      'npx',
      ['vitest', 'run', '--reporter=json', '--silent', testGlob],
      { cwd: repoRoot, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env } },
    );
    return { json: safeParse(stdout), error: null };
  } catch (err) {
    // vitest exits non-zero on any test failure; stdout still carries
    // the JSON summary that tells us which tests failed.
    const stdout = (err as { stdout?: string | Buffer }).stdout;
    const text = typeof stdout === 'string' ? stdout : stdout?.toString('utf-8') ?? '';
    const json = safeParse(text);
    if (json) return { json, error: null };
    return { json: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function safeParse(raw: string): VitestJsonSummary | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(trimmed.slice(start)) as VitestJsonSummary;
  } catch {
    return null;
  }
}

export function parseFailingFiles(summary: VitestJsonSummary, repoRoot: string): VitestFailure[] {
  const results = summary.testResults ?? [];
  const failing: VitestFailure[] = [];
  for (const r of results) {
    const file = r.name ? relativize(r.name, repoRoot) : null;
    if (!file) continue;
    const failedAssertions = (r.assertionResults ?? []).filter((a) => a.status === 'failed');
    if (r.status === 'failed' || failedAssertions.length > 0) {
      const firstMessage =
        failedAssertions[0]?.failureMessages?.[0]?.split('\n').slice(0, 3).join('\n') ?? null;
      failing.push({
        testFile: file,
        failedAssertions: failedAssertions.length,
        firstMessage,
      });
    }
  }
  return failing;
}

function relativize(abs: string, repoRoot: string): string | null {
  const rel = path.relative(repoRoot, abs);
  if (!rel || rel.startsWith('..')) return null;
  return rel.replace(/\\/g, '/');
}

function maybeSiblingSource(testPath: string): string[] {
  const match = testPath.match(/^(.*?)\/__tests__\/(.+)\.test\.ts$/);
  if (!match) return [];
  const candidate = `${match[1]}/${match[2]}.ts`;
  return [candidate];
}

function emptyEvidence(testGlob: string, runnerError: string | null): VitestHealthEvidence {
  return {
    affected_files: [],
    total_tests: 0,
    passed_tests: 0,
    failed_tests: 0,
    failing_files: [],
    runner_error: runnerError,
    test_glob: testGlob,
  };
}
