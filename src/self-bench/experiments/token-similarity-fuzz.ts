/**
 * TokenSimilarityFuzzExperiment — property fuzz for
 * src/lib/token-similarity.ts.
 *
 * Invariants per sample:
 *   - normalizeMessage is idempotent: normalize(normalize(s)) === normalize(s)
 *   - normalizeMessage output contains only lowercase words + single spaces
 *   - tokenSimilarity range is [0, 1]
 *   - tokenSimilarity is symmetric: sim(a,b) === sim(b,a)
 *   - tokenSimilarity(a, a) === 1 when normalize(a) has ≥1 token
 *   - tokenSimilarity(a, '') === 0
 *
 * Emits evidence.affected_files = ['src/lib/token-similarity.ts']
 * on violation so PatchAuthorExperiment can target the right file.
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
  normalizeMessage,
  tokenSimilarity,
} from '../../lib/token-similarity.js';
import { makeRng } from './format-duration-fuzz.js';

const TARGET_FILE = 'src/lib/token-similarity.ts';
const SAMPLE_COUNT = 120;
const RNG_SEED = 0x517cc1b7;

export type TokenSimilarityProperty =
  | 'normalize-idempotent'
  | 'normalize-shape'
  | 'similarity-range'
  | 'similarity-symmetric'
  | 'self-similarity'
  | 'empty-similarity';

export interface TokenSimilarityViolation {
  a: string;
  b: string | null;
  property: TokenSimilarityProperty;
  detail: string;
}

interface FuzzEvidence extends Record<string, unknown> {
  samples_tested: number;
  violations: TokenSimilarityViolation[];
  affected_files: string[];
  seed: number;
}

export class TokenSimilarityFuzzExperiment implements Experiment {
  readonly id = 'token-similarity-fuzz';
  readonly name = 'Property fuzz: src/lib/token-similarity.ts';
  readonly category: ExperimentCategory = 'tool_reliability';
  readonly hypothesis =
    'normalizeMessage is idempotent and tokenSimilarity is a bounded, ' +
    'symmetric [0,1] Jaccard score with self-similarity=1 on non-empty inputs.';
  readonly cadence = { everyMs: 5 * 60 * 1000, runOnBoot: true };

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const pairs = buildPairs(SAMPLE_COUNT, RNG_SEED);
    const violations: TokenSimilarityViolation[] = [];

    for (const [a, b] of pairs) {
      const v = checkPair(a, b);
      if (v) violations.push(...v);
    }

    const evidence: FuzzEvidence = {
      samples_tested: pairs.length,
      violations,
      affected_files: [TARGET_FILE],
      seed: RNG_SEED,
    };
    const summary =
      violations.length === 0
        ? `${pairs.length} pairs, all six properties hold`
        : `${violations.length} property violation(s) over ${pairs.length} pairs`;
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
      '[token-similarity-fuzz] property violations detected — patch-author should pick this up',
    );
    return null;
  }
}

const FIXED_STRINGS: string[] = [
  '',
  '   ',
  'hello world',
  'Hello, World!',
  'HELLO world',
  'one',
  'the quick brown fox jumps over the lazy dog',
  'repeat repeat repeat',
  '!@#$%^&*()',
  'mixed 123 numbers 456',
  '  leading and trailing  ',
  'café naïve',
];

const NORMALIZED_SHAPE = /^(?:[a-z0-9_]+(?: [a-z0-9_]+)*)?$/;

export function buildPairs(count: number, seed: number): Array<[string, string]> {
  const rng = makeRng(seed);
  const corpus: string[] = [...FIXED_STRINGS];
  while (corpus.length < count) {
    corpus.push(randomString(rng));
  }
  const out: Array<[string, string]> = [];
  for (let i = 0; i < count; i++) {
    const a = corpus[i % corpus.length];
    const b = corpus[(i * 7 + 3) % corpus.length];
    out.push([a, b]);
  }
  return out;
}

function randomString(rng: () => number): string {
  const words = ['alpha', 'beta', 'gamma', 'delta', 'foo', 'bar', 'baz', 'qux'];
  const n = 1 + (rng() % 6);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const w = words[rng() % words.length];
    // Randomly perturb case / punctuation so the normalizer has work to do.
    const mode = rng() % 4;
    if (mode === 0) parts.push(w.toUpperCase());
    else if (mode === 1) parts.push(`${w}!`);
    else if (mode === 2) parts.push(` ${w} `);
    else parts.push(w);
  }
  return parts.join(' ');
}

export function checkPair(a: string, b: string): TokenSimilarityViolation[] | null {
  const violations: TokenSimilarityViolation[] = [];

  // Property 1: normalize idempotent.
  const n1 = normalizeMessage(a);
  const n2 = normalizeMessage(n1);
  if (n1 !== n2) {
    violations.push({
      a,
      b: null,
      property: 'normalize-idempotent',
      detail: `normalize(${JSON.stringify(a)})=${JSON.stringify(n1)} but normalize of that=${JSON.stringify(n2)}`,
    });
  }

  // Property 2: normalize shape — lowercase words, single-spaced, no
  // leading/trailing whitespace, no punctuation.
  if (!NORMALIZED_SHAPE.test(n1)) {
    violations.push({
      a,
      b: null,
      property: 'normalize-shape',
      detail: `normalize output ${JSON.stringify(n1)} violates shape`,
    });
  }

  // Property 3: similarity range.
  const sim = tokenSimilarity(a, b);
  if (!(sim >= 0 && sim <= 1) || Number.isNaN(sim)) {
    violations.push({
      a,
      b,
      property: 'similarity-range',
      detail: `tokenSimilarity=${sim} outside [0,1]`,
    });
  }

  // Property 4: symmetric.
  const simBa = tokenSimilarity(b, a);
  if (sim !== simBa) {
    violations.push({
      a,
      b,
      property: 'similarity-symmetric',
      detail: `sim(a,b)=${sim} sim(b,a)=${simBa}`,
    });
  }

  // Property 5: self-similarity = 1 when normalize(a) has ≥1 token.
  const tokensA = n1.split(' ').filter(Boolean);
  const simAa = tokenSimilarity(a, a);
  if (tokensA.length > 0 && simAa !== 1) {
    violations.push({
      a,
      b: null,
      property: 'self-similarity',
      detail: `sim(a,a)=${simAa} but a has ${tokensA.length} token(s)`,
    });
  }

  // Property 6: similarity with empty string = 0.
  const simEmpty = tokenSimilarity(a, '');
  if (simEmpty !== 0) {
    violations.push({
      a,
      b: '',
      property: 'empty-similarity',
      detail: `sim(a,'')=${simEmpty}`,
    });
  }

  return violations.length === 0 ? null : violations;
}

export const TOKEN_SIMILARITY_FUZZ_TARGETS = [TARGET_FILE] as const;
