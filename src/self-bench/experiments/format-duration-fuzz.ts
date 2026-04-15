/**
 * FormatDurationFuzzExperiment — first surprise-source for the
 * tier-2 patch loop.
 *
 * Property-tests src/lib/format-duration.ts with a deterministic seeded
 * corpus of non-negative ms values, including known edge cases and
 * pseudorandom fuzz. For each input it asserts:
 *
 *   - formatDuration never throws on finite non-negative input
 *   - the output is a non-empty string
 *   - the output contains only legal unit tokens (d|h|m|s|ms)
 *   - parsing the output back recovers floor(input) exactly
 *     (round-trip property — the strongest contract the format implies)
 *
 * On a correct implementation this stays at zero violations forever
 * and the experiment functions as a heartbeat over the contract. If a
 * future change to format-duration ever breaks any of the four
 * properties, this experiment fires a fail finding whose
 * evidence.affected_files = ['src/lib/format-duration.ts'] —
 * exactly the shape PatchAuthorExperiment is watching for.
 *
 * Why this beats relying on the existing exact-output unit tests:
 * unit tests catch the specific values they enumerate. Property tests
 * catch entire classes of regressions (an off-by-one in the floor
 * logic, dropping an intermediate unit, misordering, etc.) by
 * sampling the input space. The two are complementary.
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
import { formatDuration } from '../../lib/format-duration.js';


const TARGET_FILE = 'src/lib/format-duration.ts';
const SAMPLE_COUNT = 200;
/** Stable seed so the same corpus is replayed every tick. */
const RNG_SEED = 0x9e3779b9;

const UNIT_TOKEN_RE = /^(?:\d+(?:d|h|m|s|ms))(?: \d+(?:d|h|m|s|ms))*$/;

export interface FormatDurationViolation {
  input: number;
  output: string | null;
  property: 'threw' | 'empty' | 'token-shape' | 'round-trip';
  detail: string;
}

interface FuzzEvidence extends Record<string, unknown> {
  samples_tested: number;
  violations: FormatDurationViolation[];
  affected_files: string[];
  seed: number;
}

export class FormatDurationFuzzExperiment implements Experiment {
  readonly id = 'format-duration-fuzz';
  readonly name = 'Property fuzz: src/lib/format-duration.ts';
  readonly category: ExperimentCategory = 'tool_reliability';
  readonly hypothesis =
    'For every non-negative finite ms input, formatDuration returns a ' +
    'non-empty string of legal unit tokens that round-trips back to floor(input).';
  readonly cadence = { everyMs: 5 * 60 * 1000, runOnBoot: true };

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const inputs = buildCorpus(SAMPLE_COUNT, RNG_SEED);
    const violations: FormatDurationViolation[] = [];

    for (const ms of inputs) {
      const result = checkOne(ms);
      if (result) violations.push(result);
    }

    const evidence: FuzzEvidence = {
      samples_tested: inputs.length,
      violations,
      affected_files: [TARGET_FILE],
      seed: RNG_SEED,
    };
    const summary =
      violations.length === 0
        ? `${inputs.length} samples, all four properties hold`
        : `${violations.length} property violation(s) over ${inputs.length} samples`;
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
      '[format-duration-fuzz] property violations detected — patch-author should pick this up',
    );
    return null;
  }
}

/**
 * Deterministic xorshift32 generator. Used so the corpus is identical
 * across runs — a regression in formatDuration produces the same
 * violations on every replay until it's fixed.
 */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

const FIXED_EDGE_CASES: number[] = [
  0,
  1,
  999,
  1_000,
  1_001,
  59_999,
  60_000,
  60_001,
  3_599_999,
  3_600_000,
  3_600_001,
  86_399_999,
  86_400_000,
  86_400_001,
  // 30 days; 365 days; 1000 days
  30 * 86_400_000,
  365 * 86_400_000,
  1_000 * 86_400_000,
];

export function buildCorpus(count: number, seed: number): number[] {
  const rng = makeRng(seed);
  const out: number[] = [...FIXED_EDGE_CASES];
  while (out.length < count) {
    // Mix three magnitude ranges so the corpus exercises every unit
    // band roughly evenly.
    const r = rng();
    const mode = r % 3;
    let v: number;
    if (mode === 0) v = rng() % 10_000; // sub-second to 10s
    else if (mode === 1) v = rng() % 86_400_000; // sub-day
    else v = rng() % (30 * 86_400_000); // sub-month
    out.push(v);
  }
  return out;
}

export function checkOne(ms: number): FormatDurationViolation | null {
  let output: string;
  try {
    output = formatDuration(ms);
  } catch (err) {
    return {
      input: ms,
      output: null,
      property: 'threw',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (typeof output !== 'string' || output.length === 0) {
    return {
      input: ms,
      output: typeof output === 'string' ? output : null,
      property: 'empty',
      detail: 'output is not a non-empty string',
    };
  }
  if (!UNIT_TOKEN_RE.test(output)) {
    return {
      input: ms,
      output,
      property: 'token-shape',
      detail: `output does not match unit-token grammar`,
    };
  }
  const parsed = parseFormattedDuration(output);
  if (parsed === null) {
    return {
      input: ms,
      output,
      property: 'round-trip',
      detail: 'parser rejected own output',
    };
  }
  if (parsed !== Math.floor(ms)) {
    return {
      input: ms,
      output,
      property: 'round-trip',
      detail: `parsed=${parsed} expected=${Math.floor(ms)}`,
    };
  }
  return null;
}

const UNIT_MS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
  ms: 1,
};

/**
 * Inverse of formatDuration. Returns total ms, or null if the input
 * doesn't parse (token order wrong, repeated unit, etc.). The grammar
 * accepts only the shapes formatDuration produces — strict on
 * purpose so the round-trip check actually catches drift.
 */
export function parseFormattedDuration(s: string): number | null {
  if (s === '0ms') return 0;
  const tokens = s.split(' ');
  const order = ['d', 'h', 'm', 's', 'ms'];
  let cursor = 0;
  let total = 0;
  for (const token of tokens) {
    const m = token.match(/^(\d+)(d|h|m|s|ms)$/);
    if (!m) return null;
    const [, numStr, unit] = m;
    const idx = order.indexOf(unit);
    if (idx < cursor) return null; // out of order or repeat
    cursor = idx + 1;
    const n = Number(numStr);
    if (!Number.isFinite(n)) return null;
    total += n * UNIT_MS[unit];
  }
  return total;
}

export const FORMAT_DURATION_FUZZ_TARGETS = [TARGET_FILE] as const;
