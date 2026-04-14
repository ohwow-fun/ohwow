/**
 * Auto-revert sandbox — exercises the Layer 5a/5b rollback flow on a
 * temp git repo without touching the live daemon.
 *
 * Run:    npx tsx scripts/probe-auto-revert-sandbox.ts
 *
 * What it shows the operator: the exact sequence of events that would
 * fire the moment they `touch ~/.ohwow/auto-revert-enabled` and a
 * trailer-bearing autonomous patch needed to be reverted.
 *
 * Steps
 * -----
 *   1. Spin up bare-origin + working-clone under /tmp/ohwow-...
 *   2. Make a seed commit and push.
 *   3. Make a fake autonomous commit carrying a Fixes-Finding-Id +
 *      Self-authored-by trailer; push it.
 *   4. findAutonomousPatchesInWindow → expect 1 patch discovered.
 *   5. With OHWOW_AUTO_REVERT_TEST_ALLOW=1, call revertCommit →
 *      expect ok:true with a revert sha + the trailer block.
 *   6. Confirm the bare origin received the revert.
 *   7. Tear down.
 *
 * The temp repo sets local user.{name,email} and disables gpg signing
 * to be portable; these are LOCAL config on a throwaway repo and have
 * no effect on the real ohwow repo.
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findAutonomousPatchesInWindow,
  revertCommit,
} from '../src/self-bench/patch-rollback.js';

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' }).trim();
}

function shInput(cmd: string, cwd: string, input: string): string {
  return execSync(cmd, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
    input,
  }).trim();
}

function step(n: number, label: string): void {
  console.log(`\n[${n}] ${label}`);
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ohwow-auto-revert-sandbox-'));
  const originDir = path.join(root, 'origin.git');
  const repoDir = path.join(root, 'repo');
  console.log(`sandbox root: ${root}`);

  let exitCode = 0;
  try {
    step(1, 'init bare origin + working clone');
    fs.mkdirSync(originDir);
    sh('git init --bare --initial-branch=main', originDir);
    sh(`git clone ${originDir} repo`, root);
    sh('git config --local user.name sandbox', repoDir);
    sh('git config --local user.email sandbox@local', repoDir);
    sh('git config --local commit.gpgsign false', repoDir);

    step(2, 'seed commit + push');
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# sandbox\n');
    sh('git add README.md', repoDir);
    sh('git commit -m "seed"', repoDir);
    sh('git push -u origin main', repoDir);

    step(3, 'fake autonomous commit with Fixes-Finding-Id trailer');
    const findingId = randomUUID();
    fs.writeFileSync(path.join(repoDir, 'patched.txt'), 'autonomous patch payload\n');
    sh('git add patched.txt', repoDir);
    const commitMsg =
      'feat(sandbox): fake autonomous patch\n\n' +
      'Pretend this is a probe fix.\n\n' +
      'Self-authored by experiment: sandbox-probe\n' +
      `Fixes-Finding-Id: ${findingId}\n`;
    shInput('git commit -F -', repoDir, commitMsg);
    sh('git push', repoDir);
    const patchSha = sh('git rev-parse HEAD', repoDir);
    console.log(`  patch sha: ${patchSha}`);
    console.log(`  finding id: ${findingId}`);

    step(4, 'findAutonomousPatchesInWindow (1h)');
    const found = findAutonomousPatchesInWindow(repoDir, 60 * 60 * 1000);
    console.log(`  discovered ${found.length} patch(es):`);
    for (const p of found) {
      console.log(
        `    sha=${p.sha.slice(0, 12)} finding=${p.findingId} experiment=${p.experimentId} files=${p.files.join(',')}`,
      );
    }
    if (found.length !== 1 || found[0].sha !== patchSha || found[0].findingId !== findingId) {
      throw new Error('discovery did not match the seeded patch');
    }

    step(5, 'revertCommit with OHWOW_AUTO_REVERT_TEST_ALLOW=1');
    process.env.OHWOW_AUTO_REVERT_TEST_ALLOW = '1';
    const result = revertCommit(repoDir, patchSha, 'sandbox: confirming heal-cycle end-to-end');
    console.log('  result:', JSON.stringify(result));
    if (!result.ok) throw new Error(`revert failed: ${result.reason}`);

    step(6, 'verify revert landed on origin');
    sh('git fetch origin', repoDir);
    const log = sh('git log --oneline -3 origin/main', repoDir);
    console.log('  origin/main top:');
    for (const line of log.split('\n')) console.log(`    ${line}`);
    const revertBody = sh(`git show -s --format=%B ${result.revertSha}`, repoDir);
    if (!revertBody.includes(`Auto-Reverts: ${patchSha}`)) {
      throw new Error('revert commit missing Auto-Reverts trailer');
    }
    console.log('  Auto-Reverts trailer present ✓');

    console.log('\n✅ sandbox passed — heal-cycle is wired correctly');
  } catch (err) {
    exitCode = 1;
    console.error('\n❌ sandbox failed:', err instanceof Error ? err.message : err);
  } finally {
    delete process.env.OHWOW_AUTO_REVERT_TEST_ALLOW;
    step(7, 'teardown');
    fs.rmSync(root, { recursive: true, force: true });
    console.log(`  removed ${root}`);
    process.exit(exitCode);
  }
}

void main();
