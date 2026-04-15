/**
 * StagnationFuzzExperiment — property fuzz for src/lib/stagnation.ts.
 *
 * Invariants per sample:
 *   - hashToolCall deterministic: same (name, input) ⇒ same hash
 *   - hashToolCall output is a 32-char lowercase hex string (md5 shape)
 *   - detectStagnation false for hashes shorter than windowSize
 *   - detectStagnation true iff the last windowSize hashes are all equal
 *
 * Emits evidence.affected_files = ['src/lib/stagnation.ts'] on violation.
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
import { hashToolCall, detectStagnation } from '../../lib/stagnation.js';
import { makeRng } from './format-duration-fuzz.js';

const TARGET_FILE = 'src/lib/stagnation.ts';
const SAMPLE_COUNT = 120;
const RNG_SEED = 0x7f4a7c15;

const HEX_MD5 = /^[0-9a-f]{32}$/;

export type StagnationProperty =
  | 'hash-deterministic'
  | 'hash-shape'
  | 'detect-short-window'
  | 'detect-all-equal'
  | 'detect-mixed';

export interface StagnationViolation {
  sample: string;
  property: StagnationProperty;
  detail: string;
}

interface FuzzEvidence extends Record<string, unknown> {
  samples_tested: number;
  violations: StagnationViolation[];
  affected_files: string[];
  seed: number;
}

interface Sample {
  name: string;
  input: unknown;
  windowSize: number;
  mixedHashes: string[];
}

export class StagnationFuzzExperiment implements Experiment {
  readonly id = 'stagnation-fuzz';
  readonly name = 'Property fuzz: src/lib/stagnation.ts';
  readonly category: ExperimentCategory = 'tool_reliability';
  readonly hypothesis =
    'hashToolCall is a deterministic md5 over (name,input) and ' +
    'detectStagnation is true iff the last windowSize hashes match.';
  readonly cadence = { everyMs: 5 * 60 * 1000, runOnBoot: true };

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const samples = buildSamples(SAMPLE_COUNT, RNG_SEED);
    const violations: StagnationViolation[] = [];

    for (const s of samples) {
      const vs = checkSample(s);
      if (vs) violations.push(...vs);
    }

    const evidence: FuzzEvidence = {
      samples_tested: samples.length,
      violations,
      affected_files: [TARGET_FILE],
      seed: RNG_SEED,
    };
    const summary =
      violations.length === 0
        ? `${samples.length} samples, all five properties hold`
        : `${violations.length} property violation(s) over ${samples.length} samples`;
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
      '[stagnation-fuzz] property violations detected — patch-author should pick this up',
    );
    return null;
  }
}

export function buildSamples(count: number, seed: number): Sample[] {
  const rng = makeRng(seed);
  const toolNames = ['search', 'read_file', 'write_file', 'bash', 'noop'];
  const out: Sample[] = [];
  for (let i = 0; i < count; i++) {
    const name = toolNames[rng() % toolNames.length];
    const input =
      rng() % 3 === 0
        ? { q: `query-${rng() % 20}` }
        : { path: `/tmp/f-${rng() % 40}.txt`, flag: (rng() % 2) === 0 };
    const windowSize = 2 + (rng() % 4); // 2..5

    // Random distinct hashes so we can build a mixed-window that is
    // definitely NOT stagnant.
    const mixedHashes: string[] = [];
    for (let j = 0; j < windowSize + 2; j++) {
      mixedHashes.push(hashToolCall(`${name}-${j}`, { j, salt: rng() }));
    }
    out.push({ name, input, windowSize, mixedHashes });
  }
  return out;
}

export function checkSample(s: Sample): StagnationViolation[] | null {
  const violations: StagnationViolation[] = [];
  const label = `${s.name}/${JSON.stringify(s.input).slice(0, 40)}`;

  // Property 1: determinism.
  const h1 = hashToolCall(s.name, s.input);
  const h2 = hashToolCall(s.name, s.input);
  if (h1 !== h2) {
    violations.push({
      sample: label,
      property: 'hash-deterministic',
      detail: `h1=${h1} h2=${h2}`,
    });
  }

  // Property 2: shape.
  if (typeof h1 !== 'string' || !HEX_MD5.test(h1)) {
    violations.push({
      sample: label,
      property: 'hash-shape',
      detail: `hash=${JSON.stringify(h1)} is not 32-char lowercase hex`,
    });
  }

  // Property 3: detectStagnation false for too-short input.
  const tooShort = new Array(s.windowSize - 1).fill(h1);
  if (detectStagnation(tooShort, s.windowSize) !== false) {
    violations.push({
      sample: label,
      property: 'detect-short-window',
      detail: `expected false for ${tooShort.length} hashes with windowSize=${s.windowSize}`,
    });
  }

  // Property 4: true when last windowSize hashes all equal (include
  // some non-equal prefix to ensure the window-scoping works).
  const stagnantSeq = [...s.mixedHashes.slice(0, 2), ...new Array(s.windowSize).fill(h1)];
  if (detectStagnation(stagnantSeq, s.windowSize) !== true) {
    violations.push({
      sample: label,
      property: 'detect-all-equal',
      detail: `expected true for sequence ending in ${s.windowSize} equal hashes`,
    });
  }

  // Property 5: false when the last windowSize hashes are not all
  // equal (mixed distinct hashes).
  const mixed = s.mixedHashes.slice(-s.windowSize);
  if (detectStagnation(mixed, s.windowSize) !== false) {
    violations.push({
      sample: label,
      property: 'detect-mixed',
      detail: `expected false for ${s.windowSize} distinct hashes`,
    });
  }

  return violations.length === 0 ? null : violations;
}

export const STAGNATION_FUZZ_TARGETS = [TARGET_FILE] as const;
