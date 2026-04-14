/**
 * Doc-vs-code drift audit
 *
 * The repo is full of invariants that live in prose: CLAUDE.md rules,
 * comment blocks that reference specific constants, commit messages
 * with "bug #N fix: X has a 60s timeout" language, tool descriptions
 * that promise a given return shape, migration file naming
 * conventions, and so on. Every one of those is a claim that can
 * drift out of sync with the code as the code evolves, and when it
 * does the docs quietly start to lie.
 *
 * This audit turns a hand-curated list of such claims into
 * executable verifiers. Each claim has an id, a human-readable
 * description, a reference to the doc it came from (for traceability
 * when a verifier fails and the operator needs to decide whether
 * the code or the doc is wrong), and a `verify` function that
 * returns a structured result. The runner executes every verifier
 * and produces a severity-tagged report.
 *
 * Design choices:
 *
 * 1. Hand-curated, not model-generated. A cheap LLM could extract
 *    claims from prose automatically, but the payoff wouldn't match
 *    the cost: claim extraction is a high-variance step that needs
 *    review anyway, and the more durable artifact is a checked-in
 *    list that grows one entry per commit that introduces a new
 *    invariant. The first run is the seed — future commits are
 *    expected to append entries, not to rewrite the verifier.
 *
 * 2. Verifiers live next to the claim list so each invariant is a
 *    closed-form check that doesn't rely on regex-matching arbitrary
 *    source. A verifier can read a file, run a grep, spawn git log,
 *    or import a runtime constant — whichever is cleanest for the
 *    claim it's pinning.
 *
 * 3. Three severity tiers, same shape as the other self-bench
 *    audits: clean, minor (doc drift, cosmetic), major (real
 *    invariant violation that would mislead a future contributor or
 *    agent).
 *
 * The companion live test runs every claim against the repo and
 * fails on any major finding. Minor findings are printed but don't
 * stop the bench — they're cleanup candidates.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, relative } from 'node:path';

// ============================================================================
// TYPES
// ============================================================================

export interface DriftCtx {
  /** Absolute path to the repo root. */
  repoRoot: string;
  /** Read a file relative to repoRoot. Throws on missing. */
  readFile: (relPath: string) => string;
  /** Check whether a file exists relative to repoRoot. */
  fileExists: (relPath: string) => boolean;
  /** Run a ripgrep command (or equivalent) against the repo. Returns matching lines, one per entry. */
  grep: (pattern: string, opts?: { include?: string; exclude?: string[] }) => string[];
  /** Run a git command via execSync and return stdout. Callers should handle errors. */
  git: (args: string) => string;
  /** List every .ts source file under a directory, skipping __tests__ and node_modules. */
  listSources: (relDir: string) => string[];
}

export type DriftSeverity = 'clean' | 'minor' | 'major';

export interface DriftResult {
  passed: boolean;
  severity: DriftSeverity;
  /** Short verdict line shown in the report. */
  verdict: string;
  /** Optional extra context — relevant file:line pointers or offending samples. */
  evidence?: string[];
}

export interface DriftClaim {
  id: string;
  /** Human-readable description of the invariant this claim pins. */
  description: string;
  /** Where the claim came from (doc path, commit SHA, comment location). */
  source: string;
  /** When the verifier fails, is this a real invariant violation (major) or a cosmetic drift (minor)? */
  severityOnFail: DriftSeverity;
  /** Verifier function. Returns a structured result the runner uses to build the report. */
  verify: (ctx: DriftCtx) => DriftResult;
}

export interface DriftRunResult {
  startedAt: string;
  finishedAt: string;
  results: Array<{ claim: DriftClaim; result: DriftResult }>;
  summary: {
    total: number;
    clean: number;
    minor: number;
    major: number;
  };
}

// ============================================================================
// CONTEXT FACTORY
// ============================================================================

export function createDriftCtx(repoRoot: string): DriftCtx {
  const resolvedRoot = resolve(repoRoot);
  return {
    repoRoot: resolvedRoot,
    readFile(relPath) {
      return readFileSync(join(resolvedRoot, relPath), 'utf-8');
    },
    fileExists(relPath) {
      return existsSync(join(resolvedRoot, relPath));
    },
    grep(pattern, opts) {
      const flags = ['-n', '--no-messages'];
      if (opts?.include) flags.push('--include', opts.include);
      if (opts?.exclude) {
        for (const ex of opts.exclude) flags.push('--exclude-dir', ex);
      }
      // Use BSD/GNU grep via execSync; cross-platform enough for this use.
      try {
        const args = [...flags, '-rE', pattern, resolvedRoot].map(escapeShellArg).join(' ');
        const out = execSync(`grep ${args}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
        return out.split('\n').filter(Boolean);
      } catch (err) {
        // grep exits 1 when no match — that's not an error for our use
        const e = err as { status?: number; stdout?: string };
        if (e.status === 1) return [];
        throw err;
      }
    },
    git(args) {
      return execSync(`git ${args}`, { cwd: resolvedRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    },
    listSources(relDir) {
      const out: string[] = [];
      const root = join(resolvedRoot, relDir);
      const walk = (dir: string) => {
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch { return; }
        for (const name of entries) {
          if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue;
          const full = join(dir, name);
          const st = statSync(full);
          if (st.isDirectory()) walk(full);
          else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
            out.push(relative(resolvedRoot, full));
          }
        }
      };
      walk(root);
      return out;
    },
  };
}

function escapeShellArg(arg: string): string {
  if (/^[\w./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

// ============================================================================
// RUNNER + REPORT
// ============================================================================

export function runDriftAudit(claims: DriftClaim[], ctx: DriftCtx): DriftRunResult {
  const startedAt = new Date().toISOString();
  const results = claims.map((claim) => {
    let result: DriftResult;
    try {
      result = claim.verify(ctx);
    } catch (err) {
      result = {
        passed: false,
        severity: claim.severityOnFail,
        verdict: `verifier threw: ${err instanceof Error ? err.message : String(err)}`,
        evidence: [],
      };
    }
    return { claim, result };
  });
  const finishedAt = new Date().toISOString();
  return {
    startedAt,
    finishedAt,
    results,
    summary: {
      total: results.length,
      clean: results.filter((r) => r.result.severity === 'clean').length,
      minor: results.filter((r) => r.result.severity === 'minor').length,
      major: results.filter((r) => r.result.severity === 'major').length,
    },
  };
}

export function formatDriftReport(run: DriftRunResult): string {
  const lines: string[] = [];
  lines.push(
    `doc↔code drift audit — ${run.summary.total} claims, ` +
    `${run.summary.major} major / ${run.summary.minor} minor / ${run.summary.clean} clean`,
  );
  lines.push('');
  const order = (r: typeof run.results[number]) => {
    if (r.result.severity === 'major') return 0;
    if (r.result.severity === 'minor') return 1;
    return 2;
  };
  const sorted = [...run.results].sort((a, b) => order(a) - order(b));
  for (const { claim, result } of sorted) {
    const tag = result.severity === 'major' ? '🔴' : result.severity === 'minor' ? '🟡' : '🟢';
    lines.push(`${tag} ${claim.id}: ${result.verdict}`);
    lines.push(`    source: ${claim.source}`);
    if (result.evidence && result.evidence.length > 0) {
      for (const ev of result.evidence.slice(0, 5)) {
        lines.push(`    evidence: ${ev}`);
      }
      if (result.evidence.length > 5) {
        lines.push(`    evidence: ... and ${result.evidence.length - 5} more`);
      }
    }
  }
  return lines.join('\n');
}

// ============================================================================
// HELPERS — reusable verifier primitives
// ============================================================================

/**
 * Scan a source file for `export const NAME = VALUE;` or
 * `const NAME = VALUE;` and return the literal VALUE as a string.
 * Intentionally permissive: matches the first occurrence that
 * starts with the given name, which is enough for our constant
 * pinning use-case since every const we check is module-scoped
 * and unique in its file.
 */
export function extractConstLiteral(source: string, name: string): string | null {
  const re = new RegExp(`\\bconst\\s+${name}\\s*(?::\\s*[^=]+)?\\s*=\\s*([^;\\n]+)`);
  const match = source.match(re);
  if (!match) return null;
  return match[1].trim();
}

/**
 * Pull the numeric value out of an extracted literal. Handles
 * `60_000`, `60000`, `1_000 * 60`, `Math.max(...)` is not handled —
 * only simple numeric literals and `N_NNN` underscore separators.
 */
export function parseNumericLiteral(literal: string): number | null {
  const stripped = literal.replace(/_/g, '').replace(/\s/g, '');
  const n = Number(stripped);
  if (Number.isFinite(n)) return n;
  return null;
}
