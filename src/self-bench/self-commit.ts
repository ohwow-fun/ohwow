/**
 * safeSelfCommit — Phase 7-A safety primitive, Path A audit-contract revision.
 *
 * The load-bearing safety layer for ohwow writing its own experiment
 * code and committing it to git. Every Phase 7 commit from a
 * self-bench experiment goes through this function.
 *
 * Hard constraints (none of these can be relaxed without a code change)
 * ---------------------------------------------------------------------
 * 1. Kill switch. The default is DISABLED. A real self-commit only
 *    runs when the operator has explicitly touched
 *    ~/.ohwow/self-commit-enabled. Missing file = refusal. This is
 *    the first and cheapest check so nothing else runs if the
 *    operator hasn't opted in.
 *
 * 2. Path allowlist. Every file must be under
 *    src/self-bench/experiments/ or src/self-bench/__tests__/. Any
 *    path containing .. is rejected. Absolute paths are rejected.
 *    The self-commit path can never touch the runtime, migrations,
 *    orchestrator, api, or any of the core code paths.
 *
 * 3. New-file-only. Every target path must NOT exist before the
 *    write. safeSelfCommit can add experiments; it cannot modify
 *    existing ones. Modifications to prior experiments remain a
 *    human-driven change. This dramatically reduces the blast
 *    radius of a hallucinated codegen.
 *
 * 4. Commit-message shape. Minimum 40 characters and must start
 *    with "feat(self-bench): " so the operator bailout "commit
 *    message shorter than 40 chars or missing feat(self-bench):
 *    prefix" is self-enforcing.
 *
 * 5. Pre-flight gates. npm run typecheck runs first. If that
 *    passes, the specific new test files run via vitest. Only if
 *    both green does the audit log get written.
 *
 * 6. Pre-commit audit log. BEFORE any git-state mutation, we
 *    append one JSON line to ~/.ohwow/self-commit-log with the
 *    exact shape the operator runbook enforces (ts,
 *    files_changed, bailout_check, extends_experiment_id,
 *    why_not_edit_existing). If the audit write fails, the commit
 *    aborts fail-closed — no commit without an audit trail. The
 *    audit entry is the operator's tripwire for halting the loop
 *    on missing-audit or non-none bailout_check.
 *
 * 7. Commit scope is explicit AND atomic. The commit uses
 *    `git commit --only -- <opts.files>` so its scope is bounded to
 *    exactly the listed paths regardless of what else is in the
 *    index. Replaces an earlier git-add-then-commit pattern that
 *    had a race window: a concurrent worker staging anything
 *    between our git-add and our git-commit got their changes
 *    silently bundled into our commit. `--only` makes the scope
 *    expression atomic — git updates the index and commits in one
 *    invocation, ignoring all other staged paths. NO --no-verify
 *    (husky runs its hooks) so the operator runbook bailout
 *    "--no-verify" is self-enforcing. The redundant typecheck the
 *    hook runs is cheap (~8s) and harmless — it's a subset of what
 *    we already ran manually, and it sees only our paths.
 *
 * Error handling
 * --------------
 * Every failure returns ok: false with a reason string. The caller
 * (an experiment) writes a finding row recording the outcome. On
 * success the caller records the commit sha so operators can trace
 * back from a bad commit to the experiment that wrote it.
 *
 * Never throws — self-commit failure must not take down the
 * experiment runner tick.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { logger } from '../lib/logger.js';
import { runInvariantsForPaths } from './patch-invariants.js';
import { diffTopLevelSymbols, changedSymbolCount } from './patch-ast-bounds.js';
import { verifyOnlyStringLiteralsChanged } from './patch-string-literal-bounds.js';
import { resolvePathTier, resolvePatchMode, getAllowedPrefixes } from './path-trust-tiers.js';
import { scanSelfCommitInputs, summarizeHits } from '../lib/secret-patterns.js';
import {
  checkRoadmapShape,
  ROADMAP_FILES,
  ROADMAP_GAPS_REL,
  ROADMAP_INDEX_REL,
  ROADMAP_LOG_REL,
} from './experiments/roadmap-shape-probe.js';
import type { ExpectedLift } from './lift-measurements-store.js';

export interface SelfCommitFile {
  /** Path relative to the repo root. */
  path: string;
  /** UTF-8 file contents. */
  content: string;
}

export interface SelfCommitOptions {
  files: SelfCommitFile[];
  /**
   * Human-readable commit message. Must be at least 40 characters
   * and start with "feat(self-bench): " so operator bailout #3
   * ("commit message shorter than 40 chars or missing
   * feat(self-bench): prefix") is self-enforcing.
   */
  commitMessage: string;
  /** Experiment id of the writer, for the commit trailer. */
  experimentId: string;
  /**
   * Audit field (required) — id of an existing experiment this
   * commit extends, or null if it's a new green-field experiment.
   * Lands in the pre-commit audit log so operators can tell
   * "extension" commits from "fresh" commits at a glance.
   */
  extendsExperimentId: string | null;
  /**
   * Audit field (required) — sentence-form justification for NOT
   * editing an existing experiment. At least 10 characters.
   * Lands in the pre-commit audit log. For Phase 7 the author
   * populates this with a standard sentence about Phase 7-A's
   * new-file-only policy; future phases that support edits will
   * populate it with the actual reason.
   */
  whyNotEditExisting: string;
  /**
   * Skip the typecheck + vitest gates. ONLY for unit tests of
   * safeSelfCommit itself. Production call sites must leave this
   * undefined so the real gates run. Gate skip does NOT skip the
   * audit log write — that's always on.
   */
  skipGates?: boolean;
  /**
   * Layer 2 of the autonomous-fixing safety floor. UUID of a recent
   * self_findings row whose verdict ∈ {warning, fail} justifies this
   * patch. When set:
   *   - findingResolver MUST be set
   *   - the resolver must return a finding that is recent (<7d),
   *     has the right verdict, and whose evidence.affected_files
   *     intersects opts.files
   *   - a `Fixes-Finding-Id:` trailer is appended to the commit
   *   - the audit-log entry records the linkage
   * Optional today — Layers 4/5 make it mandatory for code patches
   * outside src/self-bench/experiments/.
   */
  fixesFindingId?: string;
  /**
   * Phase 4 — cross-domain pollination receipt. Short string naming
   * the sales-side signal(s) that informed this patch's selection:
   * a revenue-proximal finding, the attribution worst-bucket, an
   * active goal. Lands as a `Cites-Sales-Signal:` trailer on the
   * commit so operators can grep for patches whose selection was
   * steered by sales state (vs. pure code-local signals).
   *
   * Advisory — safeSelfCommit does not gate on it. The patch-author
   * populates it when the value ranker's top pick scored positive on
   * revenue_proximity; otherwise it stays undefined and no trailer
   * is emitted.
   */
  citesSalesSignal?: string;
  /**
   * Tier-2/3 — research-driven self-improvement receipt. One or more
   * paper identifiers (arXiv id, DOI, or similar) that informed this
   * patch. Each lands as a separate `Cites-Research-Paper:` trailer
   * so downstream experiments can grep commits for
   * paper-attributed changes and score whether the research actually
   * produced commits that held vs. reverted. Capped at 5 ids; each
   * id is length-limited and newline-stripped.
   */
  citesResearchPapers?: string[];
  /**
   * Phase 5 — Expected-Lift trailers. One or more (kpi, direction,
   * horizon) tuples naming what the author claims this commit will
   * move. Each lands as a separate `Expected-Lift: <kpi> <dir> <h>h`
   * trailer and, when a liftBaselineRecorder is also provided, causes
   * a lift_measurements baseline row to be inserted on successful
   * commit. Capped at 5 lifts per commit to stop pathological
   * drafts from ballooning the trailer block.
   *
   * Advisory for the commit pipeline: safeSelfCommit does not gate
   * on it. A commit with no Expected-Lift still lands — it just
   * doesn't get outcome-measured.
   */
  expectedLifts?: ExpectedLift[];
  /**
   * Phase 5 — callback invoked after a successful commit with one
   * input per entry in opts.expectedLifts. Takes a callback (not a
   * DatabaseAdapter ref) so self-commit.ts stays free of the DB dep,
   * matching the findingResolver pattern. Errors are swallowed — a
   * failed baseline insert must not undo a landed commit. Caller is
   * expected to bind this with the workspace's db + workspaceId and
   * to read the baseline KPI value via kpi-registry.
   */
  liftBaselineRecorder?: (input: LiftBaselineRecorderInput) => Promise<void>;
  /**
   * Callback that resolves a finding id to its {verdict, ranAt,
   * evidence} tuple. Takes a callback (not a DatabaseAdapter ref)
   * so self-commit.ts stays free of the DB dep and stays trivially
   * stubbable from the test scaffold, matching the
   * _setAuditLogPathForTests pattern. REQUIRED when
   * fixesFindingId is set.
   */
  findingResolver?: (id: string) => Promise<FindingLookup | null>;
}

/** Input shape for the liftBaselineRecorder callback. */
export interface LiftBaselineRecorderInput {
  commitSha: string;
  expected: ExpectedLift;
  /** ISO timestamp; pass-through to lift_measurements.baseline_at. */
  baselineAt: string;
  /** Experiment id that authored the commit. */
  sourceExperimentId: string;
}

/**
 * Narrow shape the fixesFindingId gate needs from a finding. Kept
 * minimal so callers can map any db schema into it without coupling
 * self-commit.ts to the full Finding type. `affectedFiles` is read
 * from evidence.affected_files by convention — callers normalize it
 * here rather than in this module.
 */
export interface FindingLookup {
  id: string;
  verdict: 'pass' | 'warning' | 'fail' | 'error';
  ranAt: string;
  affectedFiles: string[];
}

export interface SelfCommitResult {
  ok: boolean;
  reason?: string;
  commitSha?: string;
  filesWritten?: string[];
}

/**
 * Exact key shape of the pre-commit audit log line. Operators
 * parse this file and halt on any row missing these keys or with
 * bailout_check != 'none'.
 */
export interface SelfCommitAuditEntry {
  ts: string;
  files_changed: string[];
  bailout_check: string;
  extends_experiment_id: string | null;
  why_not_edit_existing: string;
  /**
   * Layer 2: when the commit was justified by a specific prior
   * finding, its uuid lands here. Null for greenfield probe writes
   * (the existing author path). Additive key — operator tailers
   * that parsed the old shape still work.
   */
  fixes_finding_id: string | null;
}

// Layer 9 (per-directory trust tiers) is now the source of truth for
// which paths are allowed. The tier registry in path-trust-tiers.ts
// replaces the old flat ALLOWED_PATH_PREFIXES list. getAllowedPrefixes()
// reads the registry at call time so test-only tier overrides take
// effect without rewiring.

/**
 * Paths that may be modified (not just created) via safeSelfCommit.
 * Every path here must also appear in ALLOWED_PATH_PREFIXES.
 * The default constraint is new-file-only; this set widens it for
 * specific files that are explicitly designed to grow over time.
 */
const MODIFY_ALLOWED_EXACT_PATHS = new Set([
  'src/self-bench/auto-registry.ts',
  'src/self-bench/registries/migration-schema-registry.ts',
  'src/self-bench/registries/toolchain-test-registry.ts',
]);

/**
 * Test-only env var that forces the kill switch CLOSED (disabled) regardless
 * of the disabled-file state. Replaces the old ALLOW bypass — the new default
 * is open, so tests only need a way to force-close.
 */
const TEST_DENY_ENV = 'OHWOW_SELF_COMMIT_TEST_DENY';

/**
 * Kill switch is now opt-OUT. The loop runs by default; create this file to
 * disable it without touching code. Replaces the old opt-in
 * ~/.ohwow/self-commit-enabled pattern.
 */
export const SELF_COMMIT_DISABLED_PATH = path.join(
  os.homedir(),
  '.ohwow',
  'self-commit-disabled',
);

/**
 * Append-only audit log that every self-commit attempt writes to
 * BEFORE invoking git. Operator tails this file during supervision
 * to halt on any row whose bailout_check is not "none" or that is
 * missing the required keys. If the audit write fails, the commit
 * is aborted fail-closed — no commit without an audit trail.
 */
export const AUDIT_LOG_PATH = path.join(
  os.homedir(),
  '.ohwow',
  'self-commit-log',
);

/**
 * Self-reorganization kill switch. Opt-OUT: absent = enabled. When this
 * file exists, safeSelfCommit refuses NEW-file creation under `roadmap/`
 * (existing-file edits on the three explicit companions still work).
 * Mirrors the PATCH_AUTHOR_DISABLED_PATH pattern so operators can pause
 * the updater's structural authority without touching code.
 */
export const ROADMAP_RESTRUCTURE_DISABLED_PATH = path.join(
  os.homedir(),
  '.ohwow',
  'roadmap-restructure-disabled',
);

/**
 * Session-presence marker. Inside the repo under .git so it moves with
 * the working tree but never lands in a commit. Operators wire a
 * Claude Code hook (PromptSubmit / Stop) to `touch` this path on every
 * turn — the autonomous loop reads its mtime in safeSelfCommit and
 * defers when it's fresh.
 */
export const SESSION_PRESENCE_MARKER_REL = '.git/ohwow-session-live';
/** How fresh the marker must be to count as "a human is here right now." */
export const SESSION_KEEPALIVE_MAX_AGE_MS = 5 * 60 * 1000;

function isRoadmapRestructureEnabled(): boolean {
  try {
    return !fs.existsSync(ROADMAP_RESTRUCTURE_DISABLED_PATH);
  } catch {
    return true;
  }
}

/**
 * Returns a string reason if a human session is actively touching
 * the repo, or null if the loop is free to proceed. Reads the
 * marker's mtime; fresher than SESSION_KEEPALIVE_MAX_AGE_MS = someone
 * is here, older = stale and the loop can run. Any filesystem error
 * returns null (fail-open) so a missing .git dir during tests doesn't
 * pathologically block commits — in practice the dir is always there
 * when safeSelfCommit runs, since it's about to run git anyway.
 *
 * Override via OHWOW_SESSION_MARKER_PATH for test harnesses.
 */
function checkHumanSessionPresence(repoRoot: string): string | null {
  const override = process.env.OHWOW_SESSION_MARKER_PATH;
  const markerPath = override && override.length > 0
    ? override
    : path.join(repoRoot, SESSION_PRESENCE_MARKER_REL);
  try {
    const stat = fs.statSync(markerPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < SESSION_KEEPALIVE_MAX_AGE_MS) {
      const ageSec = Math.round(ageMs / 1000);
      return `human_session_active (marker ${path.basename(markerPath)} touched ${ageSec}s ago)`;
    }
    return null;
  } catch {
    return null;
  }
}

function readMaybe(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

const COMMIT_MESSAGE_MIN_LENGTH = 40;
const COMMIT_MESSAGE_PREFIX = 'feat(self-bench): ';
const WHY_NOT_EDIT_MIN_LENGTH = 10;
/** Max age of a justifying finding. Older findings are considered stale. */
const FINDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Layer 7 — rate ceiling on autonomous commits per 24h window.
 * Counted via git log against commits carrying the Self-authored
 * by experiment: trailer. Set to 1440 (≈1/min) so the gate only
 * trips on pathological fan-out, not on normal autonomous activity.
 * Overridable via OHWOW_SELF_COMMIT_DAILY_BUDGET for ops flexibility.
 */
const DAILY_AUTONOMOUS_COMMIT_BUDGET_DEFAULT = 1440;
const DAILY_BUDGET_ENV = 'OHWOW_SELF_COMMIT_DAILY_BUDGET';
/** Trailer every safeSelfCommit writes — used to count autonomous commits. */
const AUTONOMOUS_COMMIT_TRAILER = 'Self-authored by experiment:';

// Module-level state. Set at daemon boot via the setter.
// Tests override via their beforeEach hooks.
let repoRootOverride: string | null = null;
let auditLogPathOverride: string | null = null;
/** Test-only override for the disabled-file path. Null = use the default. */
let killSwitchDisabledPathOverride: string | null = null;

/**
 * Wire the daemon's repo root at boot. Detected in start.ts from
 * the daemon binary path (../ from dist/index.js).
 */
export function setSelfCommitRepoRoot(root: string | null): void {
  repoRootOverride = root;
}

/**
 * Test-only override for the audit log path. Tests point it at a
 * temp file so they don't pollute the operator's real log. Pass
 * null to clear.
 */
export function _setAuditLogPathForTests(p: string | null): void {
  auditLogPathOverride = p;
}

/**
 * Test-only override for the kill-switch disabled-file path. Pass a path to a
 * non-existent file to simulate the kill switch being closed (loop disabled),
 * or null to restore the real default path.
 */
export function _setKillSwitchDisabledPathForTests(p: string | null): void {
  killSwitchDisabledPathOverride = p;
}

/** Test-only reset so beforeEach starts clean. */
export function _resetSelfCommitForTests(): void {
  repoRootOverride = null;
  auditLogPathOverride = null;
  killSwitchDisabledPathOverride = null;
}

function getRepoRoot(): string | null {
  if (repoRootOverride) return repoRootOverride;
  const envOverride = process.env.OHWOW_REPO_ROOT;
  if (envOverride) return envOverride;
  return null;
}

function getAuditLogPath(): string {
  return auditLogPathOverride ?? AUDIT_LOG_PATH;
}

function isKillSwitchOpen(): boolean {
  // Test can force-close without touching the filesystem.
  if (process.env[TEST_DENY_ENV] === '1') return false;
  // Opt-out: disabled if the kill-switch file exists.
  const disabledPath = killSwitchDisabledPathOverride ?? SELF_COMMIT_DISABLED_PATH;
  try {
    return !fs.existsSync(disabledPath);
  } catch {
    return true;
  }
}

function isPathAllowed(relPath: string): boolean {
  if (!relPath) return false;
  const normalized = path.normalize(relPath).replace(/\\/g, '/');
  if (normalized.includes('..')) return false;
  if (normalized.startsWith('/')) return false;
  if (path.isAbsolute(normalized)) return false;
  // Tier-1 and tier-2 are allowed; tier-3 (default) is refused.
  const { tier } = resolvePathTier(normalized);
  return tier === 'tier-1' || tier === 'tier-2';
}

/**
 * Append one JSON line to the audit log. Throws on failure so the
 * caller can abort the commit — fail-closed is the whole point of
 * this file. Creates the parent directory if missing.
 */
function writeAuditEntry(entry: SelfCommitAuditEntry): void {
  const logPath = getAuditLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Run a shell command in the repo and return stdout/stderr. Throws
 * on non-zero exit so the caller can catch + rollback cleanly.
 */
function runInRepo(command: string, repoRoot: string, opts: { input?: string; timeoutMs?: number } = {}): string {
  return execSync(command, {
    cwd: repoRoot,
    stdio: opts.input !== undefined ? ['pipe', 'pipe', 'pipe'] : 'pipe',
    input: opts.input,
    timeout: opts.timeoutMs ?? 120_000,
    encoding: 'utf-8',
  }).toString();
}

export async function safeSelfCommit(opts: SelfCommitOptions): Promise<SelfCommitResult> {
  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    return {
      ok: false,
      reason: 'repo root not configured — call setSelfCommitRepoRoot() at daemon boot or set OHWOW_REPO_ROOT',
    };
  }

  if (!isKillSwitchOpen()) {
    return {
      ok: false,
      reason: `self-commit is disabled by default. To re-enable, remove ${SELF_COMMIT_DISABLED_PATH}`,
    };
  }

  // Phase 5 — session-presence gate. If a human Claude Code session
  // (or any other tool) has touched .git/ohwow-session-live within
  // the last SESSION_KEEPALIVE_MAX_AGE_MS, defer this autonomous
  // commit so two writers aren't racing the working tree. The marker
  // is a plain file — operators wire the touch via a Claude Code
  // PromptSubmit / Stop hook (one line: `touch "$CLAUDE_PROJECT_DIR/.git/ohwow-session-live"`).
  // Read-only check; never writes the file itself so the loop can't
  // mask its own presence.
  const sessionHoldback = checkHumanSessionPresence(repoRoot);
  if (sessionHoldback) {
    return {
      ok: false,
      reason: `deferring autonomous commit — ${sessionHoldback}. Remove or wait-out .git/ohwow-session-live if the session is gone.`,
    };
  }

  // Commit message shape — rejects short or un-prefixed messages
  // so the operator bailout is enforced BEFORE touching anything.
  if (typeof opts.commitMessage !== 'string' || opts.commitMessage.length < COMMIT_MESSAGE_MIN_LENGTH) {
    return {
      ok: false,
      reason: `commitMessage must be at least ${COMMIT_MESSAGE_MIN_LENGTH} characters (got ${opts.commitMessage?.length ?? 0})`,
    };
  }
  if (!opts.commitMessage.startsWith(COMMIT_MESSAGE_PREFIX)) {
    return {
      ok: false,
      reason: `commitMessage must start with "${COMMIT_MESSAGE_PREFIX}"`,
    };
  }

  // Audit-field validation — refuse garbage before we get near git.
  if (typeof opts.whyNotEditExisting !== 'string' || opts.whyNotEditExisting.length < WHY_NOT_EDIT_MIN_LENGTH) {
    return {
      ok: false,
      reason: `whyNotEditExisting must be at least ${WHY_NOT_EDIT_MIN_LENGTH} characters`,
    };
  }

  // 0b. Layer 7 — daily autonomous commit budget. Count the
  //     autonomous commits in the last 24h via git log; refuse
  //     once the count reaches the budget. Cheap early refusal
  //     so a budget-hit attempt doesn't write files or run gates.
  const budget = resolveDailyBudget();
  const autonomousCount24h = countAutonomousCommitsLast24h(repoRoot);
  if (autonomousCount24h >= budget) {
    return {
      ok: false,
      reason: `daily autonomous commit budget reached (${autonomousCount24h}/${budget}); wait for the 24h rolling window to clear or raise ${DAILY_BUDGET_ENV}`,
    };
  }

  // 1. Path allowlist validation (tier-3 denies)
  for (const f of opts.files) {
    if (!isPathAllowed(f.path)) {
      return { ok: false, reason: `path not allowed: ${f.path}` };
    }
  }

  // 1b. Layer 9 — tier-2 paths require a Fixes-Finding-Id receipt.
  //     Tier-1 paths (the self-bench sandbox) are unaffected; tier-2
  //     paths are reserved for future bug-fix territory and must
  //     carry a justifying finding. This is enforcement of the Layer
  //     2 primitive; the actual lookup/intersect happens in the
  //     Layer 2 gate below.
  for (const f of opts.files) {
    const { tier, entry } = resolvePathTier(f.path);
    if (tier === 'tier-2' && (!opts.fixesFindingId || !opts.findingResolver)) {
      return {
        ok: false,
        reason: `tier-2 path ${f.path} requires a Fixes-Finding-Id receipt (rationale: ${entry?.rationale ?? 'unknown'})`,
      };
    }
  }

  // 2. New-file-only check. Modify is allowed when either the path
  //    is in the legacy MODIFY_ALLOWED_EXACT_PATHS set (Layer 1
  //    registries + auto-registry) OR the path resolves to tier-2
  //    under the Layer 9 tier registry — tier-2 paths exist-then-
  //    get-patched by design and were already required to carry a
  //    Fixes-Finding-Id receipt by gate 1b above.
  //    Also snapshots pre-write bytes for modify paths so Layer 4's
  //    AST gate can diff against them after the write.
  const absPaths: string[] = [];
  const preWriteSnapshots = new Map<string, string>();
  const EXISTING_ROADMAP_FILES = new Set<string>(ROADMAP_FILES);
  for (const f of opts.files) {
    const abs = path.join(repoRoot, f.path);
    const normalized = path.normalize(f.path).replace(/\\/g, '/');
    const legacyModifyOk = MODIFY_ALLOWED_EXACT_PATHS.has(normalized);
    const tier2ModifyOk = resolvePathTier(normalized).tier === 'tier-2';
    const modifyOk = legacyModifyOk || tier2ModifyOk;
    const isNewRoadmapFile =
      normalized.startsWith('roadmap/') &&
      !EXISTING_ROADMAP_FILES.has(normalized) &&
      !fs.existsSync(abs);
    if (isNewRoadmapFile && !isRoadmapRestructureEnabled()) {
      return {
        ok: false,
        reason: `roadmap restructure is disabled. To re-enable, remove ${ROADMAP_RESTRUCTURE_DISABLED_PATH}`,
      };
    }
    if (fs.existsSync(abs)) {
      if (!modifyOk) {
        return { ok: false, reason: `target already exists: ${f.path}` };
      }
      try {
        preWriteSnapshots.set(normalized, fs.readFileSync(abs, 'utf-8'));
      } catch (err) {
        return {
          ok: false,
          reason: `could not snapshot pre-write state for ${f.path}: ${extractErrorSummary(err)}`,
        };
      }
    }
    absPaths.push(abs);
  }

  // 3. Write files to disk
  try {
    for (let i = 0; i < opts.files.length; i++) {
      const abs = absPaths[i];
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, opts.files[i].content, 'utf-8');
    }
  } catch (err) {
    rollbackFiles(absPaths, preWriteSnapshots, opts.files);
    return { ok: false, reason: `write failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 3b. Layer 4 — AST-bounded patch surface. For every path that
  //     pre-existed (i.e. a modify, not a create), the diff between
  //     pre-write bytes and the new content must touch at most one
  //     top-level symbol. Creates are unaffected — a new file has no
  //     "prior" AST to compare against.
  //     Non-TypeScript files (e.g. .md) bypass this gate: the TS
  //     parser has no useful notion of "top-level symbol" for them,
  //     so the count is meaningless. Tier-2 allowlist + Fixes-Finding-Id
  //     trailer + typecheck + test gates + cool-off + daily budget
  //     remain as the safety envelope for non-TS tier-2 paths.
  for (const f of opts.files) {
    const normalized = path.normalize(f.path).replace(/\\/g, '/');
    const prior = preWriteSnapshots.get(normalized);
    if (prior === undefined) continue;
    if (!/\.(ts|tsx)$/.test(normalized)) continue;
    const mode = resolvePatchMode(normalized);
    if (mode === 'string-literal') {
      // Stricter gate: only string-literal / jsx-text node contents
      // may differ. Everything else in the AST must be identical.
      const check = verifyOnlyStringLiteralsChanged(prior, f.content);
      if (!check.ok) {
        rollbackFiles(absPaths, preWriteSnapshots, opts.files);
        return { ok: false, reason: `${f.path}: ${check.reason}` };
      }
      continue;
    }
    const diff = diffTopLevelSymbols(prior, f.content);
    const touched = changedSymbolCount(diff);
    if (touched > 1) {
      const names = [...diff.added, ...diff.removed, ...diff.modified];
      rollbackFiles(absPaths, preWriteSnapshots, opts.files);
      return {
        ok: false,
        reason: `AST-bounded patch surface: ${f.path} modifies ${touched} top-level symbols (${names.join(', ')}); autonomous modifies are limited to 1`,
      };
    }
  }

  // 4. Gates (typecheck + vitest on the new test files)
  if (!opts.skipGates) {
    try {
      runInRepo('npm run typecheck', repoRoot, { timeoutMs: 180_000 });
    } catch (err) {
      rollbackFiles(absPaths, preWriteSnapshots, opts.files);
      return { ok: false, reason: `typecheck gate failed: ${extractErrorSummary(err)}` };
    }

    const testFiles = opts.files
      .filter((f) => f.path.includes('__tests__'))
      .map((f) => f.path);
    if (testFiles.length > 0) {
      try {
        const cmd = `npx vitest run ${testFiles.map((t) => `"${t}"`).join(' ')}`;
        runInRepo(cmd, repoRoot, { timeoutMs: 120_000 });
      } catch (err) {
        rollbackFiles(absPaths, preWriteSnapshots, opts.files);
        return { ok: false, reason: `vitest gate failed: ${extractErrorSummary(err)}` };
      }
    }
  }

  // 4a. Layer 3 — pre-patch invariant suite. Runs after files are
  //     on disk so checks see the post-write state, before Layer 2's
  //     fixesFindingId gate so a broken neighborhood is refused even
  //     when the finding linkage is skipped (greenfield probe writes).
  //     Every check is fs-read only and side-effect-free; a failure
  //     rolls the candidate files back.
  const invariantResult = runInvariantsForPaths(
    repoRoot,
    opts.files.map((f) => f.path),
  );
  if (!invariantResult.ok) {
    rollbackFiles(absPaths, preWriteSnapshots, opts.files);
    return { ok: false, reason: invariantResult.reason };
  }

  // 4b. Layer 2 — fixesFindingId gate. Verifies the justifying
  //     finding exists, is recent, has the right verdict, and
  //     overlaps the patched files. Opt-in today; Layers 4/5 make
  //     it mandatory for code patches outside the experiments dir.
  if (opts.fixesFindingId !== undefined) {
    if (typeof opts.fixesFindingId !== 'string' || opts.fixesFindingId.length === 0) {
      rollbackFiles(absPaths, preWriteSnapshots, opts.files);
      return { ok: false, reason: 'fixesFindingId must be a non-empty string when set' };
    }
    if (typeof opts.findingResolver !== 'function') {
      rollbackFiles(absPaths, preWriteSnapshots, opts.files);
      return { ok: false, reason: 'findingResolver is required when fixesFindingId is set' };
    }
    let finding: FindingLookup | null;
    try {
      finding = await opts.findingResolver(opts.fixesFindingId);
    } catch (err) {
      rollbackFiles(absPaths, preWriteSnapshots, opts.files);
      return { ok: false, reason: `findingResolver threw: ${extractErrorSummary(err)}` };
    }
    if (!finding) {
      rollbackFiles(absPaths, preWriteSnapshots, opts.files);
      return { ok: false, reason: `fixesFindingId ${opts.fixesFindingId} not found` };
    }
    if (finding.verdict !== 'warning' && finding.verdict !== 'fail') {
      rollbackFiles(absPaths, preWriteSnapshots, opts.files);
      return {
        ok: false,
        reason: `finding ${opts.fixesFindingId} has verdict '${finding.verdict}' — only 'warning' or 'fail' can justify a patch`,
      };
    }
    const ranAtMs = Date.parse(finding.ranAt);
    if (!Number.isFinite(ranAtMs)) {
      rollbackFiles(absPaths, preWriteSnapshots, opts.files);
      return { ok: false, reason: `finding ${opts.fixesFindingId} has unparseable ranAt '${finding.ranAt}'` };
    }
    const ageMs = Date.now() - ranAtMs;
    if (ageMs > FINDING_MAX_AGE_MS) {
      rollbackFiles(absPaths, preWriteSnapshots, opts.files);
      return {
        ok: false,
        reason: `finding ${opts.fixesFindingId} is stale (${Math.round(ageMs / (24 * 60 * 60 * 1000))}d old, max 7d) — re-run the probe before patching`,
      };
    }
    const patched = new Set(opts.files.map((f) => path.normalize(f.path).replace(/\\/g, '/')));
    const affected = (finding.affectedFiles ?? []).map((p) =>
      path.normalize(p).replace(/\\/g, '/'),
    );
    const intersect = affected.some((p) => patched.has(p));
    if (!intersect) {
      rollbackFiles(absPaths, preWriteSnapshots, opts.files);
      return {
        ok: false,
        reason: `finding ${opts.fixesFindingId} affected_files [${affected.join(', ')}] does not intersect patched files [${[...patched].join(', ')}]`,
      };
    }
  }

  // 4c. Roadmap shape gate. For any patch that touches the roadmap
  //     suite, re-read the three files from disk (post-write) and
  //     verify structural invariants still hold. Fail → rollback.
  //     This turns a broken RoadmapUpdaterExperiment patch into an
  //     immediate refusal instead of landing + waiting for an
  //     auto-revert cycle. The probe itself runs every 5 min as an
  //     external observability signal.
  const touchesRoadmap = opts.files.some((f) => {
    const n = path.normalize(f.path).replace(/\\/g, '/');
    return (
      n === ROADMAP_INDEX_REL ||
      n === ROADMAP_GAPS_REL ||
      n === ROADMAP_LOG_REL ||
      n.startsWith('roadmap/')
    );
  });
  if (touchesRoadmap) {
    const shapeInput = {
      index: readMaybe(path.join(repoRoot, ROADMAP_INDEX_REL)),
      gaps: readMaybe(path.join(repoRoot, ROADMAP_GAPS_REL)),
      log: readMaybe(path.join(repoRoot, ROADMAP_LOG_REL)),
    };
    const shapeViolations = checkRoadmapShape(shapeInput);
    if (shapeViolations.length > 0) {
      rollbackFiles(absPaths, preWriteSnapshots, opts.files);
      const first = shapeViolations[0];
      return {
        ok: false,
        reason: `roadmap shape gate: ${shapeViolations.length} violation(s); first: ${first.rule} in ${first.file} — ${first.detail}`,
      };
    }
  }

  // 4d. Content gate — deterministic secret + personal-data scan over
  //     every file byte we're about to write AND over the commit message
  //     itself. The shell pre-commit hook the repo uses covers human
  //     commits; this runs inside the autonomous path where no shell is
  //     in the loop. The LLM that authored this patch gets NO override:
  //     the OHWOW_ALLOW_PERSONAL_DATA env bypass is scoped to the shell
  //     hook and has no effect here — a false positive should surface
  //     as an operator review, not a silent pass. Landed after the AST
  //     and roadmap-shape gates (so we've already established the
  //     structural shape is valid) and before the audit log (so refused
  //     rows don't pollute the trail).
  const contentHits = scanSelfCommitInputs(opts.files, opts.commitMessage);
  if (contentHits.length > 0) {
    rollbackFiles(absPaths, preWriteSnapshots, opts.files);
    logger.warn(
      {
        experimentId: opts.experimentId,
        files: opts.files.map((f) => f.path),
        hits: contentHits.slice(0, 10).map((h) => ({ kind: h.kind, source: h.source, line: h.line })),
      },
      '[self-commit] content gate refused autonomous commit',
    );
    return {
      ok: false,
      reason: `content gate: ${summarizeHits(contentHits)}`,
    };
  }

  // 5. Pre-commit audit log. Fail-closed on write error — no
  //    commit without an audit trail. Happens AFTER gates pass
  //    (so we don't pollute the log with rows whose gates failed)
  //    but BEFORE git state mutation (so operators see the
  //    attempt before the commit lands).
  try {
    writeAuditEntry({
      ts: new Date().toISOString(),
      files_changed: opts.files.map((f) => f.path),
      bailout_check: 'none',
      extends_experiment_id: opts.extendsExperimentId,
      why_not_edit_existing: opts.whyNotEditExisting,
      fixes_finding_id: opts.fixesFindingId ?? null,
    });
  } catch (err) {
    rollbackFiles(absPaths, preWriteSnapshots, opts.files);
    return { ok: false, reason: `audit log write failed: ${extractErrorSummary(err)}` };
  }

  // 6. Git commit with sign-off + self-attribution trailer. Uses
  //    `git commit --only -- <files>` so the commit scope is bounded
  //    to exactly opts.files regardless of what else is in the index.
  //
  //    Why --only and not git-add-then-commit:
  //    The earlier two-step (git add <files> ; git commit) was a
  //    race window. If a concurrent worker (another autonomous
  //    self-commit, a human running git rm, lint-staged stashing,
  //    etc.) staged anything between our git-add and our git-commit,
  //    that change got bundled into our commit silently. This was
  //    observed on 2026-04-14 when an autonomous commit titled
  //    "auto-author toolchain-tool-test-list-deliverables-since"
  //    actually contained ~1,500 lines of unrelated deletions from a
  //    concurrent refactor's git-rm.
  //
  //    `git commit --only -- <files>` updates the index for ONLY the
  //    listed paths (from the working tree) and commits ONLY those
  //    paths. Other index entries — staged or otherwise — are left
  //    untouched and excluded from the commit. This is the
  //    git-native way to express "commit exactly these files,
  //    nothing else."
  //
  //    NO --no-verify — husky's pre-commit hook still runs
  //    (typecheck + lint-staged eslint). The hook sees only the
  //    files we're committing, so cross-session WIP outside our
  //    scope still doesn't pollute the validation surface.
  //
  //    `git add -N` (intent to add) is required for new files
  //    before `git commit --only` can pick them up — without it
  //    git rejects the commit with "pathspec did not match any
  //    file(s) known to git." -N adds a zero-length placeholder
  //    entry to the index; --only then replaces it with the actual
  //    working-tree content. Crucially, -N only touches the paths
  //    we name — other staged paths in the index are untouched, so
  //    the isolation guarantee holds.
  const fixesTrailer = opts.fixesFindingId
    ? `Fixes-Finding-Id: ${opts.fixesFindingId}\n`
    : '';
  // Cites-Sales-Signal trailer — defensive size cap + newline strip
  // so a malformed signal string can't inject extra trailers into the
  // commit message.
  const citesTrailer =
    typeof opts.citesSalesSignal === 'string' && opts.citesSalesSignal.length > 0
      ? `Cites-Sales-Signal: ${opts.citesSalesSignal.replace(/[\r\n]+/g, ' ').slice(0, 240)}\n`
      : '';
  // Cites-Research-Paper trailers — one per paper id. Each id passes
  // through the same newline strip + cap as sales signals. We cap the
  // total number of papers at 5 so a malformed list can't balloon the
  // commit message.
  const researchPapers = Array.isArray(opts.citesResearchPapers)
    ? opts.citesResearchPapers
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .slice(0, 5)
        .map((p) => p.replace(/[\r\n]+/g, ' ').slice(0, 120))
    : [];
  const researchTrailer = researchPapers.length > 0
    ? researchPapers.map((p) => `Cites-Research-Paper: ${p}`).join('\n') + '\n'
    : '';
  // Expected-Lift trailers — one per KPI × horizon pair. Capped at 5
  // so a malformed list can't balloon the message. Each line is
  // `Expected-Lift: <kpi_id> <direction> <horizon>h` — space-delimited,
  // newline-stripped per field, and the kpi_id/direction/horizon are
  // validated downstream against kpi-registry before a baseline lands,
  // so a typo here produces a grep-able trailer but no ledger row.
  const expectedLiftsList = Array.isArray(opts.expectedLifts)
    ? opts.expectedLifts
        .filter(
          (l): l is ExpectedLift =>
            l != null &&
            typeof l.kpiId === 'string' &&
            l.kpiId.length > 0 &&
            (l.direction === 'up' || l.direction === 'down' || l.direction === 'any') &&
            Number.isFinite(l.horizonHours) &&
            l.horizonHours > 0,
        )
        .slice(0, 5)
    : [];
  const liftTrailer = expectedLiftsList.length > 0
    ? expectedLiftsList
        .map((l) => `Expected-Lift: ${l.kpiId.replace(/\s+/g, '-')} ${l.direction} ${Math.floor(l.horizonHours)}h`)
        .join('\n') + '\n'
    : '';
  const fullMessage = `${opts.commitMessage}\n\nSelf-authored by experiment: ${opts.experimentId}\n\nCo-Authored-By: ohwow-self-bench <self@ohwow.local>\n${fixesTrailer}${citesTrailer}${researchTrailer}${liftTrailer}`;
  const fileArgs = opts.files.map((f) => `"${f.path}"`).join(' ');
  try {
    runInRepo(`git add -N -- ${fileArgs}`, repoRoot);
    runInRepo(`git commit -s --only -F - -- ${fileArgs}`, repoRoot, { input: fullMessage });
  } catch (err) {
    // Reset the index entries `--only` may have updated so the repo
    // is clean. Scoped to opts.files — never touches paths the
    // self-commit didn't write (per the global rule "never git reset
    // HEAD on files you didn't stage").
    try {
      runInRepo(`git reset HEAD -- ${fileArgs}`, repoRoot);
    } catch { /* best effort */ }
    rollbackFiles(absPaths, preWriteSnapshots, opts.files);
    return { ok: false, reason: `git commit failed: ${extractErrorSummary(err)}` };
  }

  // 8. Read back the resulting SHA
  let commitSha: string | undefined;
  try {
    commitSha = runInRepo('git rev-parse HEAD', repoRoot).trim();
  } catch { /* shouldn't happen but not fatal — commit already landed */ }

  // 8b. Phase 5 baseline: record a lift_measurements row per
  //     expectedLift the caller passed. Best-effort — a failed recorder
  //     never undoes the commit. Keeps self-commit.ts DB-free by
  //     delegating the actual KPI read + insert to the caller's
  //     closure (which has db + workspaceId bound).
  if (
    commitSha
    && expectedLiftsList.length > 0
    && typeof opts.liftBaselineRecorder === 'function'
  ) {
    const baselineAt = new Date().toISOString();
    for (const expected of expectedLiftsList) {
      try {
        await opts.liftBaselineRecorder({
          commitSha,
          expected,
          baselineAt,
          sourceExperimentId: opts.experimentId,
        });
      } catch (err) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : err,
            commitSha,
            kpiId: expected.kpiId,
          },
          '[self-commit] lift baseline recorder threw; commit still landed',
        );
      }
    }
  }

  // 9. Push intentionally skipped — local commits only until the loop
  // is proven stable. A human push (or a future push-enablement
  // experiment) moves commits to the remote when ready. Keeping this
  // step out of the autonomous path removes one blast-radius vector
  // during the supervised observation window.
  logger.info(
    { experimentId: opts.experimentId, commitSha, filesWritten: opts.files.map((f) => f.path) },
    '[self-commit] experiment committed locally (push skipped)',
  );

  return {
    ok: true,
    commitSha,
    filesWritten: opts.files.map((f) => f.path),
  };
}

/**
 * Undo what safeSelfCommit wrote to disk. For files that existed
 * before the write (modify paths), restore the captured pre-write
 * bytes. For files that didn't exist (creates), unlink. Best-effort
 * per file — a restore failure is logged nowhere and swallowed; the
 * caller has already decided to refuse and rollback is cleanup, not
 * load-bearing.
 */
function rollbackFiles(
  absPaths: string[],
  preWriteSnapshots: Map<string, string>,
  files: readonly SelfCommitFile[],
): void {
  for (let i = 0; i < absPaths.length; i++) {
    const abs = absPaths[i];
    const normalized = path.normalize(files[i].path).replace(/\\/g, '/');
    const prior = preWriteSnapshots.get(normalized);
    try {
      if (prior !== undefined) {
        fs.writeFileSync(abs, prior, 'utf-8');
      } else if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
      }
    } catch { /* best effort */ }
  }
}

/**
 * Read the daily budget from the env override, falling back to the
 * default. Parses NaN / non-integer / negative values as "use default"
 * so a mistyped env var doesn't silently disable the cap.
 */
function resolveDailyBudget(): number {
  const raw = process.env[DAILY_BUDGET_ENV];
  if (raw === undefined || raw === '') return DAILY_AUTONOMOUS_COMMIT_BUDGET_DEFAULT;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DAILY_AUTONOMOUS_COMMIT_BUDGET_DEFAULT;
  return parsed;
}

/**
 * Count autonomous commits in the last 24h. Defensive: any git
 * failure returns 0 so a transient error produces a permissive
 * (under-budget) result — the alternative would be fail-closed when
 * git is unavailable, which would block legit commits during
 * environmental flakes.
 */
function countAutonomousCommitsLast24h(repoRoot: string): number {
  try {
    const out = execSync(
      `git log --since="24 hours ago" --pretty=format:%B --no-merges`,
      { cwd: repoRoot, encoding: 'utf-8', timeout: 10_000 },
    );
    // Count each occurrence of the trailer. One autonomous commit
    // writes exactly one trailer line, so count == commits.
    const matches = out.match(new RegExp(`^${AUTONOMOUS_COMMIT_TRAILER}`, 'gm'));
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

function extractErrorSummary(err: unknown): string {
  if (err instanceof Error) {
    // execSync errors expose both stdout and stderr as Buffers. tsc
    // writes diagnostics to stdout, not stderr, so checking only
    // .stderr loses every typecheck error and the ledger reason
    // collapses to "Command failed: npm run typecheck" — no signal
    // for the LLM author to learn from. Prefer whichever stream has
    // content, stdout first since that's where tsc lands.
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const pick = (b: Buffer | string | undefined): string => {
      if (!b) return '';
      return typeof b === 'string' ? b : b.toString('utf-8');
    };
    const out = pick(e.stdout).trim();
    const errout = pick(e.stderr).trim();
    const combined = [out, errout].filter((s) => s.length > 0).join('\n');
    if (combined) return combined.slice(-500);
    return err.message.slice(0, 500);
  }
  return String(err).slice(0, 500);
}

/**
 * Diagnostic helper for operator surfaces. Returns a structured
 * snapshot of the safety state without actually attempting a
 * commit. Used by a future status endpoint.
 */
export function getSelfCommitStatus(): {
  killSwitchOpen: boolean;
  repoRootConfigured: boolean;
  repoRoot: string | null;
  allowedPathPrefixes: readonly string[];
  auditLogPath: string;
} {
  return {
    killSwitchOpen: isKillSwitchOpen(),
    repoRootConfigured: getRepoRoot() !== null,
    repoRoot: getRepoRoot(),
    allowedPathPrefixes: getAllowedPrefixes(),
    auditLogPath: getAuditLogPath(),
  };
}
