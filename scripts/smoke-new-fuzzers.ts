/**
 * One-shot smoke check: runs the three new tier-2 fuzzers against
 * current src/lib code and prints verdict + sample count. Not a test
 * script — just a dev convenience so we can see heartbeat output
 * without restarting the daemon.
 */
import { TokenSimilarityFuzzExperiment } from '../src/self-bench/experiments/token-similarity-fuzz.js';
import { StagnationFuzzExperiment } from '../src/self-bench/experiments/stagnation-fuzz.js';
import { ErrorClassificationFuzzExperiment } from '../src/self-bench/experiments/error-classification-fuzz.js';
import type { ExperimentContext } from '../src/self-bench/experiment-types.js';

const ctx = {} as ExperimentContext;

async function run(exp: { id: string; probe: (c: ExperimentContext) => Promise<unknown>; judge: (r: any, h: any[]) => string }): Promise<void> {
  const r: any = await exp.probe(ctx);
  const v = exp.judge(r, []);
  console.log(`${exp.id.padEnd(30)}  verdict=${v}  ${r.summary}`);
  if (v !== 'pass') {
    console.log('  first violations:', JSON.stringify(r.evidence.violations.slice(0, 3), null, 2));
  }
}

await run(new TokenSimilarityFuzzExperiment());
await run(new StagnationFuzzExperiment());
await run(new ErrorClassificationFuzzExperiment());
