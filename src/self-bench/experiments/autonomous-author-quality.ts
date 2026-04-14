/**
 * AutonomousAuthorQualityExperiment — meta-watcher over the
 * autonomous code-authoring pipeline.
 *
 * Why this exists
 * ---------------
 * Step 2 of the autonomous-fixing safety floor (Layer 10 of the audit
 * roadmap). Before the path allowlist for autonomous code authoring
 * can be safely widened beyond `src/self-bench/experiments/`, the
 * runtime needs a probe that reports on the QUALITY of what the
 * existing pipeline emits. Today there is no such signal: 35
 * auto-author commits in 6 hours, no experiment notices when those
 * commits are slop, ghosts, or duplicates of one another.
 *
 * The 2026-04-14 audit found four real failure modes the autonomous
 * loop produced and never noticed:
 *   1. Volume runaway — commits ship faster than humans can review
 *   2. Slop — N byte-identical files that should have been a registry
 *   3. Ghosts — probes that reference files which do not exist
 *   4. Verdict-mix collapse — probes that ONLY ever emit 'pass' and
 *      therefore carry no information value beyond their existence
 *
 * Each failure mode gets one vital sign here. Together they let the
 * operator (and a future meta-meta-loop) decide whether to widen the
 * patch allowlist or to throttle the author back. No intervene — the
 * remediation for any failure mode is a code change a human still
 * has to write.
 *
 * Vital signs
 * -----------
 * 1. commit_volume_24h — autonomous commits in the last 24 hours.
 *    Warning above DAILY_COMMIT_BUDGET; absolute cap is the operator's
 *    call, not this probe's, so we surface the number rather than
 *    enforce it.
 *
 * 2. templated_families — number of file-name prefixes inside
 *    `src/self-bench/experiments/` that have N+ siblings sharing the
 *    same prefix. A prefix with > TEMPLATED_FAMILY_THRESHOLD members
 *    is the slop signal: those files should be one parameterized
 *    class fed by a registry. Both completed slop refactors
 *    (89e4516 migration-schema, 305adab toolchain-test) collapsed
 *    families this metric would have flagged at threshold 4.
 *
 * 3. ghost_probe_count — autonomous experiment files whose probe
 *    references (a) a vitest test file, (b) a migration .sql, or (c)
 *    another path on disk, where the referenced file does not exist.
 *    Pattern caught a46f61a (9 ghosts) and the 4-more-ghosts dropped
 *    in 305adab. Going forward the structural ghost guards in the
 *    parameterized classes' invariant tests catch these at CI time,
 *    but ad-hoc per-file probes still need this safety net.
 *
 * 4. always_pass_experiment_count — autonomous experiment ids that
 *    have emitted findings but NEVER emitted anything other than
 *    'pass'. Three reads on this:
 *      - genuinely informative: probe is correctly pinning a stable
 *        invariant (good — but ledger noise is still high)
 *      - probe is dead — never actually invoked, or its judge always
 *        returns pass regardless of evidence (bad)
 *      - probe is shape-only — no judging logic at all (bad)
 *    We can't tell which from one tick; we surface the count and let
 *    the operator decide. >ALWAYS_PASS_RATIO_WARN_THRESHOLD of all
 *    autonomous experiments → warning.
 *
 * Severity
 * --------
 *   pass     0 vital signs flagged
 *   warning  1-2 flagged
 *   fail     3+ flagged OR ghost_probe_count >= GHOST_HARD_FAIL_COUNT
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { getSelfCommitStatus } from '../self-commit.js';

const HOUR_MS = 60 * 60 * 1000;

/** Filename prefix that marks an autonomous-authored experiment. */
const AUTHOR_FILE_PREFIX_RE = /^(migration-schema|toolchain-tool-test|toolchain-singleton)-/;

/** Filename prefixes we count for templated-family detection. */
const TEMPLATED_FAMILY_PREFIXES = [
  'migration-schema-',
  'toolchain-tool-test-',
  'toolchain-singleton-',
] as const;

/** A family with more than this many siblings should have been a registry. */
const TEMPLATED_FAMILY_THRESHOLD = 4;

/** Soft commit budget per 24h — above this, surface as warning. */
const DAILY_COMMIT_BUDGET = 24;

/** Ghost-probe count above which we go straight to fail verdict. */
const GHOST_HARD_FAIL_COUNT = 3;

/** Above this fraction of autonomous experiments only ever emitting pass, warn. */
const ALWAYS_PASS_RATIO_WARN_THRESHOLD = 0.8;

/** Lookback window for ledger queries. */
const LEDGER_LOOKBACK_DAYS = 7;

/** Commit-message substring identifying autonomous commits. */
const AUTONOMOUS_COMMIT_MARKER = 'auto-author';

interface VitalSigns {
  commit_volume_24h: number;
  templated_families: Record<string, number>;
  ghost_probe_count: number;
  always_pass_experiment_count: number;
}

interface QualityEvidence extends Record<string, unknown> {
  vital_signs: VitalSigns;
  autonomous_experiment_count: number;
  always_pass_ratio: number;
  failures: string[];
  reason?: string;
  repo_root: string | null;
}

interface FindingRow {
  experiment_id: string;
  verdict: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXPERIMENTS_DIR = join(__dirname);

export class AutonomousAuthorQualityExperiment implements Experiment {
  readonly id = 'autonomous-author-quality';
  readonly name = 'Autonomous author output quality watcher';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'The autonomous code-authoring pipeline should not be silently producing slop, ghosts, ' +
    'or never-judging probes. Reading commit volume, templated-family counts, ghost probe ' +
    'count, and verdict-mix per autonomous experiment lets the operator decide whether to ' +
    'widen the patch allowlist or throttle the author back.';
  readonly cadence = { everyMs: 6 * HOUR_MS, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const { repoRoot } = getSelfCommitStatus();

    if (!repoRoot) {
      const evidence: QualityEvidence = {
        vital_signs: blankVitalSigns(),
        autonomous_experiment_count: 0,
        always_pass_ratio: 0,
        failures: [],
        reason: 'no_repo_root',
        repo_root: null,
      };
      return {
        subject: 'meta:autonomous-author',
        summary: 'repo root not configured — skipping autonomous-author quality probe',
        evidence,
      };
    }

    const commitVolume24h = countAutonomousCommits(repoRoot, '24 hours ago');
    const templatedFamilies = countTemplatedFamilies();
    const ghostProbeCount = countGhostProbes(repoRoot);
    const verdictMix = await readAutonomousVerdictMix(ctx);
    const alwaysPassRatio =
      verdictMix.totalAutonomous > 0
        ? verdictMix.alwaysPass / verdictMix.totalAutonomous
        : 0;

    const vitals: VitalSigns = {
      commit_volume_24h: commitVolume24h,
      templated_families: templatedFamilies,
      ghost_probe_count: ghostProbeCount,
      always_pass_experiment_count: verdictMix.alwaysPass,
    };

    const failures: string[] = [];
    if (commitVolume24h > DAILY_COMMIT_BUDGET) {
      failures.push(`commit volume ${commitVolume24h}/24h exceeds budget ${DAILY_COMMIT_BUDGET}`);
    }
    for (const [prefix, count] of Object.entries(templatedFamilies)) {
      if (count > TEMPLATED_FAMILY_THRESHOLD) {
        failures.push(
          `${prefix}* family has ${count} files — should be a registry-driven parameterized class`,
        );
      }
    }
    if (ghostProbeCount > 0) {
      failures.push(`${ghostProbeCount} ghost probe(s) reference files that do not exist`);
    }
    if (
      verdictMix.totalAutonomous >= 5 &&
      alwaysPassRatio >= ALWAYS_PASS_RATIO_WARN_THRESHOLD
    ) {
      failures.push(
        `${Math.round(alwaysPassRatio * 100)}% of ${verdictMix.totalAutonomous} autonomous probes never emit anything other than 'pass' — low signal`,
      );
    }

    const evidence: QualityEvidence = {
      vital_signs: vitals,
      autonomous_experiment_count: verdictMix.totalAutonomous,
      always_pass_ratio: Math.round(alwaysPassRatio * 100) / 100,
      failures,
      repo_root: repoRoot,
    };

    const summary =
      failures.length === 0
        ? `autonomous author healthy: ${commitVolume24h} commits/24h, 0 ghosts, ` +
          `${verdictMix.totalAutonomous} autonomous experiments tracked`
        : `autonomous author degraded: ${failures.join('; ')}`;

    return {
      subject: 'meta:autonomous-author',
      summary,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as QualityEvidence;
    if (ev.reason === 'no_repo_root') return 'pass';
    if (ev.vital_signs.ghost_probe_count >= GHOST_HARD_FAIL_COUNT) return 'fail';
    if (ev.failures.length >= 3) return 'fail';
    if (ev.failures.length >= 1) return 'warning';
    return 'pass';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers — exported only for tests.
// ---------------------------------------------------------------------------

function blankVitalSigns(): VitalSigns {
  return {
    commit_volume_24h: 0,
    templated_families: {},
    ghost_probe_count: 0,
    always_pass_experiment_count: 0,
  };
}

/**
 * Count git commits in the lookback window whose subject line contains
 * the autonomous marker. Defensive: returns 0 on any execSync failure
 * so a transient git error doesn't produce a fail verdict.
 */
export function countAutonomousCommits(repoRoot: string, sinceArg: string): number {
  try {
    const out = execSync(
      `git log --since=${JSON.stringify(sinceArg)} --pretty=format:%s | grep -c ${JSON.stringify(AUTONOMOUS_COMMIT_MARKER)} || true`,
      { cwd: repoRoot, encoding: 'utf-8', shell: '/bin/sh', timeout: 10_000 },
    );
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Walk the experiments dir and count files per templated-family prefix.
 * Excludes the parameterized classes themselves (e.g. migration-schema-probe.ts)
 * by requiring the prefix to be followed by a digit or letter that's
 * NOT 'probe' — the parameterized class names end in '-probe.ts'.
 */
export function countTemplatedFamilies(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const prefix of TEMPLATED_FAMILY_PREFIXES) {
    counts[prefix] = 0;
  }
  let entries: string[];
  try {
    entries = readdirSync(EXPERIMENTS_DIR);
  } catch {
    return counts;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('-probe.ts')) continue; // parameterized base classes
    for (const prefix of TEMPLATED_FAMILY_PREFIXES) {
      if (entry.startsWith(prefix)) {
        counts[prefix] = (counts[prefix] ?? 0) + 1;
        break;
      }
    }
  }
  return counts;
}

/**
 * Scan autonomous-authored experiment files for references to files
 * (test files, migration .sql) that don't exist on disk. Catches the
 * a46f61a class of bug at probe time as a safety net behind the
 * structural ghost guards in the parameterized classes' tests.
 */
export function countGhostProbes(repoRoot: string): number {
  let entries: string[];
  try {
    entries = readdirSync(EXPERIMENTS_DIR);
  } catch {
    return 0;
  }
  let ghosts = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('-probe.ts')) continue;
    if (!AUTHOR_FILE_PREFIX_RE.test(entry)) continue;
    let contents: string;
    try {
      contents = readFileSync(join(EXPERIMENTS_DIR, entry), 'utf-8');
    } catch {
      continue;
    }
    // Look for explicit src/ paths the probe shells out to or reads.
    const refs = contents.match(/src\/[^\s'"`]+\.(ts|sql)/g) ?? [];
    for (const ref of refs) {
      const absPath = join(repoRoot, ref);
      if (!existsSync(absPath)) {
        ghosts += 1;
        break; // count each file once
      }
    }
  }
  return ghosts;
}

/**
 * Read self_findings to compute, per autonomous experiment_id, whether
 * it has ever emitted anything other than 'pass'. The verdict mix is
 * the signal for "is this probe actually informative or just a tickle."
 */
export async function readAutonomousVerdictMix(
  ctx: ExperimentContext,
): Promise<{ totalAutonomous: number; alwaysPass: number }> {
  const since = new Date(
    Date.now() - LEDGER_LOOKBACK_DAYS * 24 * HOUR_MS,
  ).toISOString();
  let rows: FindingRow[] = [];
  try {
    const { data } = await ctx.db
      .from<FindingRow>('self_findings')
      .select('experiment_id, verdict')
      .gte('ran_at', since)
      .limit(5000);
    rows = (data ?? []) as FindingRow[];
  } catch {
    return { totalAutonomous: 0, alwaysPass: 0 };
  }

  const verdictsByExp = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!isAutonomousExperimentId(row.experiment_id)) continue;
    const set = verdictsByExp.get(row.experiment_id) ?? new Set<string>();
    set.add(row.verdict);
    verdictsByExp.set(row.experiment_id, set);
  }

  let alwaysPass = 0;
  for (const verdicts of verdictsByExp.values()) {
    if (verdicts.size === 1 && verdicts.has('pass')) alwaysPass += 1;
  }
  return { totalAutonomous: verdictsByExp.size, alwaysPass };
}

export function isAutonomousExperimentId(id: string): boolean {
  return AUTHOR_FILE_PREFIX_RE.test(id);
}
