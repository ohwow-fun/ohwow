/**
 * One-shot driver for DashboardCopyExperiment. Runs probe + judge
 * against the live dashboard and prints per-route violations.
 */
import { DashboardCopyExperiment } from '../src/self-bench/experiments/dashboard-copy.js';
import { close } from '../src/self-bench/browser/self-bench-browser.js';
import type { ExperimentContext } from '../src/self-bench/experiment-types.js';

async function main(): Promise<void> {
  const exp = new DashboardCopyExperiment();
  const t0 = Date.now();
  const result = await exp.probe({} as ExperimentContext);
  const verdict = exp.judge(result, []);
  const dt = Date.now() - t0;
  console.log(`[drive] ${dt}ms  verdict=${verdict}`);
  console.log(`[drive] ${result.summary}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ev = result.evidence as any;
  if (ev.per_route) {
    for (const r of ev.per_route) {
      if (r.violations.length > 0) {
        console.log(`\n  ${r.route}  (${r.loadMs}ms, ${r.textLength} chars)`);
        for (const v of r.violations.slice(0, 5)) {
          console.log(`    [${v.severity}] ${v.ruleId}  ${JSON.stringify(v.match)}`);
          console.log(`      ctx: ${v.context}`);
        }
        if (r.violations.length > 5) {
          console.log(`    …and ${r.violations.length - 5} more`);
        }
      }
    }
  }
  if (ev.affected_files) {
    console.log(`\n[drive] affected_files: ${JSON.stringify(ev.affected_files)}`);
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
