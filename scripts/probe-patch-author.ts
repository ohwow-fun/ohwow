/**
 * Read-only observer for PatchAuthorExperiment.
 *
 * Run:    npx tsx scripts/probe-patch-author.ts
 *
 * Prints, in order:
 *   1. Three kill-switch states (self-commit, auto-revert, patch-author)
 *   2. Registered tier-2 prefixes
 *   3. Last 5 self-commit audit log entries
 *   4. Last 10 autonomous commits (Self-authored trailer) with
 *      Fixes-Finding-Id status
 *   5. self_findings rows whose verdict in (warning, fail) and
 *      evidence.affected_files intersects a tier-2 prefix in the last
 *      7 days, with patched/unpatched status
 *   6. Result of FormatDurationFuzzExperiment.probe() right now
 *
 * Pure read — does not touch git, does not call a model, does not
 * write to the audit log. Safe to run repeatedly while the daemon is
 * live.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PATCH_AUTHOR_ENABLED_PATH,
  collectFindingIdsAlreadyPatched,
  extractAffectedFiles,
  listTier2Prefixes,
} from '../src/self-bench/experiments/patch-author.js';
import { SELF_COMMIT_ENABLED_PATH } from '../src/self-bench/self-commit.js';
import { AUTO_REVERT_ENABLED_PATH } from '../src/self-bench/patch-rollback.js';
import { resolvePathTier } from '../src/self-bench/path-trust-tiers.js';
import { FormatDurationFuzzExperiment } from '../src/self-bench/experiments/format-duration-fuzz.js';
import type { ExperimentContext } from '../src/self-bench/experiment-types.js';

const REPO_ROOT = process.cwd();
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const AUDIT_LOG = path.join(os.homedir(), '.ohwow', 'self-commit-log');
const DEFAULT_DB = path.join(os.homedir(), '.ohwow', 'workspaces', 'default', 'runtime.db');

function header(s: string): void {
  console.log(`\n=== ${s} ===`);
}

function bool(b: boolean): string {
  return b ? 'OPEN' : 'closed';
}

function killSwitches(): void {
  header('Kill switches');
  for (const [label, p] of [
    ['self-commit  ', SELF_COMMIT_ENABLED_PATH],
    ['auto-revert  ', AUTO_REVERT_ENABLED_PATH],
    ['patch-author ', PATCH_AUTHOR_ENABLED_PATH],
  ] as const) {
    console.log(`  ${label} ${bool(fs.existsSync(p))}  (${p})`);
  }
}

function tier2(): void {
  header('Tier-2 registry');
  const prefixes = listTier2Prefixes();
  if (prefixes.length === 0) {
    console.log('  (no tier-2 paths registered)');
    return;
  }
  for (const p of prefixes) {
    const { entry } = resolvePathTier(p);
    console.log(`  ${p}  — ${entry?.rationale ?? '(no rationale)'}`);
  }
}

function auditTail(): void {
  header('Last 5 self-commit audit log entries');
  if (!fs.existsSync(AUDIT_LOG)) {
    console.log('  (no audit log yet)');
    return;
  }
  const lines = fs.readFileSync(AUDIT_LOG, 'utf-8').trim().split('\n').slice(-5);
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as {
        ts: string;
        files_changed: string[];
        bailout_check: string;
        fixes_finding_id: string | null;
      };
      console.log(
        `  ${row.ts}  bailout=${row.bailout_check}  fixes=${row.fixes_finding_id ?? '(none)'}`,
      );
      console.log(`    files: ${row.files_changed.join(', ')}`);
    } catch {
      console.log(`  (unparseable) ${line.slice(0, 80)}`);
    }
  }
}

function autonomousCommits(): void {
  header('Last 10 autonomous commits (Self-authored trailer)');
  let log: string;
  try {
    log = execSync(
      'git log --grep="Self-authored by experiment:" -n 10 --pretty=format:%H%x1f%s%x1f%B%x1e',
      { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 30_000 },
    );
  } catch (err) {
    console.log(`  (git log failed: ${(err as Error).message})`);
    return;
  }
  const records = log.split('\x1e').map((r) => r.trim()).filter((r) => r.length > 0);
  if (records.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const rec of records) {
    const [sha, subject, body] = rec.split('\x1f');
    const fixes = body.match(/^Fixes-Finding-Id:\s*([^\s]+)\s*$/m);
    const exp = body.match(/^Self-authored by experiment:\s*(\S+)\s*$/m);
    console.log(
      `  ${sha.slice(0, 12)}  exp=${exp?.[1] ?? '(none)'}  fixes=${fixes?.[1] ?? '(none)'}`,
    );
    console.log(`    ${subject}`);
  }
}

function tier2CandidatesFromDb(): void {
  header('Tier-2 patch candidates in DB (last 7d, observer view)');
  if (!fs.existsSync(DEFAULT_DB)) {
    console.log(`  (no runtime.db at ${DEFAULT_DB})`);
    return;
  }
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const sql =
    `SELECT id, experiment_id, verdict, ran_at, evidence ` +
    `FROM self_findings ` +
    `WHERE verdict IN ('warning','fail') AND ran_at >= '${since}' ` +
    `ORDER BY ran_at DESC LIMIT 200;`;
  let rows: Array<{
    id: string;
    experiment_id: string;
    verdict: string;
    ran_at: string;
    evidence: string;
  }>;
  try {
    const out = execSync(`sqlite3 -json "${DEFAULT_DB}" "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 30_000,
    }).trim();
    rows = out ? JSON.parse(out) : [];
  } catch (err) {
    console.log(`  (sqlite3 query failed: ${(err as Error).message.slice(0, 200)})`);
    return;
  }
  const alreadyPatched = collectFindingIdsAlreadyPatched(REPO_ROOT, WINDOW_MS);
  const candidates: Array<{ row: (typeof rows)[number]; tier2Files: string[]; patched: boolean }> = [];
  for (const row of rows) {
    let evidence: unknown;
    try {
      evidence = JSON.parse(row.evidence);
    } catch {
      continue;
    }
    const affected = extractAffectedFiles(evidence);
    const tier2Files = affected.filter((f) => resolvePathTier(f).tier === 'tier-2');
    if (tier2Files.length === 0) continue;
    candidates.push({ row, tier2Files, patched: alreadyPatched.has(row.id) });
  }
  if (candidates.length === 0) {
    console.log(`  scanned ${rows.length} warning|fail finding(s); 0 intersect tier-2`);
    return;
  }
  console.log(`  scanned ${rows.length} warning|fail finding(s); ${candidates.length} tier-2 hit(s)`);
  for (const c of candidates) {
    const flag = c.patched ? '[PATCHED]' : '[OPEN]   ';
    console.log(
      `  ${flag} ${c.row.ran_at}  ${c.row.experiment_id}/${c.row.id.slice(0, 8)}  verdict=${c.row.verdict}`,
    );
    console.log(`    files: ${c.tier2Files.join(', ')}`);
  }
  console.log(
    `\n  To insert a synthetic finding for testing (replace UUID + paths):\n` +
      `    sqlite3 "${DEFAULT_DB}" "INSERT INTO self_findings(id, experiment_id, category, subject, hypothesis, verdict, summary, evidence, ran_at, duration_ms, status, created_at) VALUES ('test-uuid','format-duration-fuzz','tool_reliability','src/lib/format-duration.ts','synthetic','fail','synthetic violation','{\\"affected_files\\":[\\"src/lib/format-duration.ts\\"]}','$(date -u +%Y-%m-%dT%H:%M:%SZ)',0,'active','$(date -u +%Y-%m-%dT%H:%M:%SZ)');"`,
  );
}

async function fuzzerNow(): Promise<void> {
  header('FormatDurationFuzzExperiment.probe() — live readout');
  const exp = new FormatDurationFuzzExperiment();
  const r = await exp.probe({} as ExperimentContext);
  const ev = r.evidence as { samples_tested: number; violations: unknown[]; affected_files: string[] };
  console.log(`  samples=${ev.samples_tested}  violations=${ev.violations.length}`);
  console.log(`  verdict: ${exp.judge(r, [])}`);
  console.log(`  summary: ${r.summary}`);
  if (ev.violations.length > 0) {
    console.log('  first violations:');
    for (const v of ev.violations.slice(0, 5)) console.log(`    ${JSON.stringify(v)}`);
  }
}

async function main(): Promise<void> {
  console.log(`probe-patch-author observer  (repo: ${REPO_ROOT})`);
  killSwitches();
  tier2();
  auditTail();
  autonomousCommits();
  tier2CandidatesFromDb();
  await fuzzerNow();
}

void main().catch((err) => {
  console.error('observer failed:', err);
  process.exit(1);
});
