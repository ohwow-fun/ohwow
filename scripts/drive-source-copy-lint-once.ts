import { SourceCopyLintExperiment } from '../src/self-bench/experiments/source-copy-lint.js';
import { setSelfCommitRepoRoot } from '../src/self-bench/self-commit.js';
import type { ExperimentContext } from '../src/self-bench/experiment-types.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  setSelfCommitRepoRoot(resolve(here, '..'));
  const exp = new SourceCopyLintExperiment();
  const t0 = Date.now();
  const result = await exp.probe({} as ExperimentContext);
  const verdict = exp.judge(result, []);
  const dt = Date.now() - t0;
  console.log(`[drive] ${dt}ms  verdict=${verdict}`);
  console.log(`[drive] ${result.summary}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ev = result.evidence as any;
  if (Array.isArray(ev.violations)) {
    const byRule = new Map<string, number>();
    for (const v of ev.violations) byRule.set(v.ruleId, (byRule.get(v.ruleId) ?? 0) + 1);
    console.log('[drive] by rule:', Object.fromEntries(byRule));
    for (const v of ev.violations.slice(0, 15)) {
      console.log(`  ${v.file}:${v.line}:${v.column}  [${v.ruleId}]  ${JSON.stringify(v.match)}`);
      console.log(`    literal: ${JSON.stringify(v.literal.slice(0, 100))}`);
    }
    console.log(`[drive] affected_files: ${JSON.stringify(ev.affected_files.slice(0, 10))}`);
  }
}

void main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
