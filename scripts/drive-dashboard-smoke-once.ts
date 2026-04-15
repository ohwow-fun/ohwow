/**
 * One-shot driver for DashboardSmokeExperiment. Runs probe + judge
 * against the current dashboard and prints the per-route issue
 * report. Used for development loops — the daemon also runs this
 * on a 10min cadence.
 */
import { DashboardSmokeExperiment } from '../src/self-bench/experiments/dashboard-smoke.js';
import { close } from '../src/self-bench/browser/self-bench-browser.js';
import type { ExperimentContext } from '../src/self-bench/experiment-types.js';

async function main(): Promise<void> {
  const exp = new DashboardSmokeExperiment();
  const ctx = {} as ExperimentContext;
  const t0 = Date.now();
  const result = await exp.probe(ctx);
  const verdict = exp.judge(result, []);
  const dt = Date.now() - t0;
  console.log(`[drive] ${dt}ms  verdict=${verdict}`);
  console.log(`[drive] summary: ${result.summary}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ev = result.evidence as any;
  if (ev.per_route) {
    for (const r of ev.per_route) {
      if (r.issues.length > 0) {
        console.log(`  ${r.route} (${r.loadMs}ms, title=${JSON.stringify(r.title)})`);
        for (const i of r.issues.slice(0, 5)) {
          console.log(`    [${i.kind}] ${i.message}${i.url ? '  ' + i.url : ''}`);
        }
      }
    }
    console.log(`[drive] affected_files: ${JSON.stringify(ev.affected_files)}`);
  }
  await close();
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error('[drive] fatal:', err);
    void close().finally(() => process.exit(1));
  },
);
