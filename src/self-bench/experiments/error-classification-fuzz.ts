/**
 * ErrorClassificationFuzzExperiment — property fuzz for
 * src/lib/error-classification.ts.
 *
 * Invariants:
 *   - classifyError is total: always returns one of the valid
 *     FailureCategory values, never undefined / throws.
 *   - Fixture table: representative error messages map to the expected
 *     category. If the dispatch logic regresses (e.g. a keyword gets
 *     removed or the order of branches changes meaningfully), the
 *     fixture rows flip and the violation points at the exact row.
 *   - isRetryableFailure returns true only for 'model_error' and
 *     'timeout' — any drift in the retry contract fires here.
 *
 * Emits evidence.affected_files = ['src/lib/error-classification.ts']
 * on violation.
 */

import { logger } from '../../lib/logger.js';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import {
  classifyError,
  isRetryableFailure,
  type FailureCategory,
} from '../../lib/error-classification.js';

const TARGET_FILE = 'src/lib/error-classification.ts';

const VALID_CATEGORIES: readonly FailureCategory[] = [
  'grounding_error',
  'tool_error',
  'safety_error',
  'timeout',
  'budget_exceeded',
  'model_error',
  'unknown',
];

const RETRYABLE: ReadonlySet<FailureCategory> = new Set<FailureCategory>([
  'model_error',
  'timeout',
]);

interface FixtureRow {
  message: string;
  expected: FailureCategory;
}

const FIXTURE_TABLE: FixtureRow[] = [
  { message: 'content policy violation', expected: 'safety_error' },
  { message: 'output flagged as harmful', expected: 'safety_error' },
  { message: 'model refused to answer', expected: 'safety_error' },
  { message: 'rate limit exceeded', expected: 'model_error' },
  { message: 'HTTP 429 Too Many Requests', expected: 'model_error' },
  { message: 'provider overloaded', expected: 'model_error' },
  { message: 'unauthorized: bad api key', expected: 'model_error' },
  { message: 'unknown tool: foobar', expected: 'grounding_error' },
  { message: 'no such tool registered', expected: 'grounding_error' },
  { message: 'Gmail API error: quota', expected: 'tool_error' },
  { message: 'oauth refresh failed', expected: 'tool_error' },
  { message: 'dropbox integration disconnected', expected: 'tool_error' },
  { message: 'request timed out', expected: 'timeout' },
  { message: 'deadline exceeded', expected: 'timeout' },
  { message: 'timeout waiting for response', expected: 'timeout' },
  { message: 'insufficient credit', expected: 'budget_exceeded' },
  { message: 'monthly budget exceeded', expected: 'budget_exceeded' },
  { message: 'some completely unrelated failure', expected: 'unknown' },
  { message: '', expected: 'unknown' },
];

export type ErrorClassificationProperty =
  | 'total-function'
  | 'fixture-mismatch'
  | 'retry-contract';

export interface ErrorClassificationViolation {
  message: string | null;
  property: ErrorClassificationProperty;
  detail: string;
}

interface FuzzEvidence extends Record<string, unknown> {
  samples_tested: number;
  violations: ErrorClassificationViolation[];
  affected_files: string[];
}

export class ErrorClassificationFuzzExperiment implements Experiment {
  readonly id = 'error-classification-fuzz';
  readonly name = 'Property fuzz: src/lib/error-classification.ts';
  readonly category: ExperimentCategory = 'tool_reliability';
  readonly hypothesis =
    'classifyError is a total function over arbitrary input that maps ' +
    'known error phrases to the documented categories; isRetryableFailure ' +
    'marks exactly model_error and timeout as retryable.';
  readonly cadence = { everyMs: 5 * 60 * 1000, runOnBoot: true };

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const violations: ErrorClassificationViolation[] = [];
    let sampleCount = 0;

    // 1. Totality over odd inputs — must not throw, must return a
    //    valid category.
    const oddInputs: unknown[] = [
      '',
      '   ',
      null,
      undefined,
      42,
      { toString: () => 'custom toString' },
      new Error('weird error'),
      { message: 'plain object' },
      Symbol('x'),
      [],
    ];
    for (const inp of oddInputs) {
      sampleCount++;
      let cat: FailureCategory | undefined;
      try {
        cat = classifyError(inp);
      } catch (err) {
        violations.push({
          message: describeOdd(inp),
          property: 'total-function',
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (!VALID_CATEGORIES.includes(cat)) {
        violations.push({
          message: describeOdd(inp),
          property: 'total-function',
          detail: `returned ${JSON.stringify(cat)} which is not a valid FailureCategory`,
        });
      }
    }

    // 2. Fixture table.
    for (const row of FIXTURE_TABLE) {
      sampleCount++;
      const got = classifyError(new Error(row.message));
      if (got !== row.expected) {
        violations.push({
          message: row.message,
          property: 'fixture-mismatch',
          detail: `expected ${row.expected}, got ${got}`,
        });
      }
    }

    // 3. isRetryableFailure contract.
    for (const cat of VALID_CATEGORIES) {
      sampleCount++;
      const got = isRetryableFailure(cat);
      const want = RETRYABLE.has(cat);
      if (got !== want) {
        violations.push({
          message: cat,
          property: 'retry-contract',
          detail: `isRetryableFailure(${cat})=${got}, expected ${want}`,
        });
      }
    }

    const evidence: FuzzEvidence = {
      samples_tested: sampleCount,
      violations,
      affected_files: [TARGET_FILE],
    };
    const summary =
      violations.length === 0
        ? `${sampleCount} samples, totality + fixtures + retry-contract all hold`
        : `${violations.length} violation(s) over ${sampleCount} samples`;
    return { subject: TARGET_FILE, summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as FuzzEvidence;
    return ev.violations.length === 0 ? 'pass' : 'fail';
  }

  async intervene(
    verdict: Verdict,
    result: ProbeResult,
    _ctx: ExperimentContext,
  ): Promise<null> {
    if (verdict !== 'fail') return null;
    const ev = result.evidence as FuzzEvidence;
    logger.warn(
      {
        target: TARGET_FILE,
        violations: ev.violations.slice(0, 5),
        totalViolations: ev.violations.length,
      },
      '[error-classification-fuzz] property violations detected — patch-author should pick this up',
    );
    return null;
  }
}

function describeOdd(x: unknown): string {
  try {
    if (typeof x === 'symbol') return 'Symbol(x)';
    if (x instanceof Error) return `Error(${x.message})`;
    return JSON.stringify(x) ?? String(x);
  } catch {
    return String(x);
  }
}

export const ERROR_CLASSIFICATION_FUZZ_TARGETS = [TARGET_FILE] as const;
