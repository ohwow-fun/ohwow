/**
 * Layer 3 of the autonomous-fixing safety floor — pre-patch invariant suite.
 *
 * Layer 2 (fixesFindingId) proves a patch is justified by a specific
 * finding. Layer 3 proves the patch did not break the neighborhood.
 *
 * After safeSelfCommit writes the candidate files to the working tree
 * but before it writes the audit log + commits, we run a per-directory
 * suite of mechanical assertions over the post-write state. Any failure
 * rolls back the files and refuses the commit.
 *
 * The checks are intentionally text/regex based — fast (<50ms total),
 * debuggable, no TS-compiler-as-a-library setup. Layer 4 is where we
 * pay for an AST.
 *
 * Extending the suite
 * -------------------
 * Add a new InvariantCheck to the appropriate dir's entry in SUITES.
 * Invariants live in code, not config, on purpose: the autonomous
 * allowlist does NOT include this file, so autonomous authorship can
 * never weaken its own guardrails.
 */

import fs from 'node:fs';
import path from 'node:path';

export type InvariantResult = { ok: true } | { ok: false; reason: string };

export interface InvariantCheck {
  name: string;
  /**
   * `patchedFiles` is the subset of opts.files that fell under the
   * check's suite directory. Checks that enforce properties of
   * newly-added code (blast-radius imports, test shape) should scan
   * ONLY those paths so pre-existing grandfathered code doesn't
   * fail every patch. Checks that enforce tree-wide uniqueness
   * (experiment id, registry key) scan the whole dir — a new file
   * can still collide with existing ones.
   */
  run: (repoRoot: string, patchedFiles: readonly string[]) => InvariantResult;
}

export interface InvariantSuite {
  /** Dir prefix (relative, forward-slashed, trailing slash). */
  directory: string;
  checks: InvariantCheck[];
}

function listFiles(absDir: string, suffix = '.ts'): string[] {
  try {
    return fs
      .readdirSync(absDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(suffix))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

const EXPERIMENT_ID_RE = /(?:readonly\s+)?id(?:\s*:\s*[A-Za-z<>.|[\]'" ]+)?\s*=\s*['"]([^'"]+)['"]/;
const ONLY_RE = /\b(?:describe|it|test)\.only\s*\(/;
const VITEST_IMPORT_RE = /from\s+['"]vitest['"]/;
const FORBIDDEN_RELATIVE_IMPORT_RE =
  /from\s+['"](?:\.\.\/){1,}(?:orchestrator|api|db\/migrations)\/[^'"]+['"]/;

/**
 * Every experiment class should declare a unique string id. Two
 * registered experiments with the same id collide at runtime with
 * only a warn log; this check surfaces the collision at commit time.
 * Parameterized base classes (`*-probe.ts`) are skipped — they get
 * their id from their config row, not from a literal.
 */
export const experimentsIdUniqueness: InvariantCheck = {
  name: 'experiment-id-uniqueness',
  run(repoRoot, _patchedFiles) {
    const dir = path.join(repoRoot, 'src/self-bench/experiments');
    const files = listFiles(dir).filter((f) => !f.endsWith('-probe.ts'));
    const seen = new Map<string, string>();
    for (const f of files) {
      let contents: string;
      try {
        contents = fs.readFileSync(path.join(dir, f), 'utf-8');
      } catch {
        continue;
      }
      const m = contents.match(EXPERIMENT_ID_RE);
      if (!m) continue;
      const id = m[1];
      const prior = seen.get(id);
      if (prior) {
        return {
          ok: false,
          reason: `duplicate experiment id '${id}' in ${f} and ${prior}`,
        };
      }
      seen.set(id, f);
    }
    return { ok: true };
  },
};

/**
 * Experiments are a narrow safety surface — they must not reach into
 * the orchestrator, the HTTP api, or migration SQL. A probe that
 * needs any of those is out of scope for autonomous authorship and
 * should be human-written with full review.
 */
export const experimentsBlastRadius: InvariantCheck = {
  name: 'experiment-blast-radius',
  run(repoRoot, patchedFiles) {
    for (const rel of patchedFiles) {
      let contents: string;
      try {
        contents = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
      } catch {
        continue;
      }
      const m = contents.match(FORBIDDEN_RELATIVE_IMPORT_RE);
      if (m) {
        return {
          ok: false,
          reason: `${rel} imports from a forbidden module: ${m[0]}`,
        };
      }
    }
    return { ok: true };
  },
};

/**
 * Each registry file's rows must have unique slug/id string literals.
 * Layer 1 appends rows via safeSelfCommit; without this check, a
 * duplicate append would silently produce two probes registered
 * against the same subject.
 */
export const registriesUniqueKeys: InvariantCheck = {
  name: 'registry-key-uniqueness',
  run(repoRoot, _patchedFiles) {
    const dir = path.join(repoRoot, 'src/self-bench/registries');
    const files = listFiles(dir);
    for (const f of files) {
      let contents: string;
      try {
        contents = fs.readFileSync(path.join(dir, f), 'utf-8');
      } catch {
        continue;
      }
      const re = /\b(?:slug|id)\s*:\s*['"]([^'"]+)['"]/g;
      const seen = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = re.exec(contents)) !== null) {
        const key = m[1];
        if (!/^[a-z0-9-]+$/.test(key)) {
          return {
            ok: false,
            reason: `registry key '${key}' in ${f} must be [a-z0-9-]+`,
          };
        }
        if (seen.has(key)) {
          return { ok: false, reason: `duplicate registry key '${key}' in ${f}` };
        }
        seen.add(key);
      }
    }
    return { ok: true };
  },
};

/**
 * Test files under src/self-bench/__tests__/ must import from vitest
 * (guards against accidental jest / mocha mixin) and must not ship
 * a leftover `.only` focus.
 */
export const testsShape: InvariantCheck = {
  name: 'tests-shape',
  run(repoRoot, patchedFiles) {
    for (const rel of patchedFiles) {
      let contents: string;
      try {
        contents = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
      } catch {
        continue;
      }
      if (!VITEST_IMPORT_RE.test(contents)) {
        return { ok: false, reason: `${rel} does not import from vitest` };
      }
      if (ONLY_RE.test(contents)) {
        return { ok: false, reason: `${rel} contains a leftover .only focus` };
      }
    }
    return { ok: true };
  },
};

export const SUITES: readonly InvariantSuite[] = [
  {
    directory: 'src/self-bench/experiments/',
    checks: [experimentsIdUniqueness, experimentsBlastRadius],
  },
  {
    directory: 'src/self-bench/registries/',
    checks: [registriesUniqueKeys],
  },
  {
    directory: 'src/self-bench/__tests__/',
    checks: [testsShape],
  },
];

/**
 * Run every suite whose directory prefix matches at least one
 * patched file. Returns the first failure, or ok on clean.
 * Designed to be idempotent + side-effect-free: every check reads
 * the working tree, nothing writes.
 */
export function runInvariantsForPaths(
  repoRoot: string,
  patchedFiles: readonly string[],
): InvariantResult {
  const normalized = patchedFiles.map((p) =>
    path.normalize(p).replace(/\\/g, '/'),
  );
  const applicableSuites = SUITES.filter((s) =>
    normalized.some((p) => p.startsWith(s.directory)),
  );
  for (const suite of applicableSuites) {
    const suiteFiles = normalized.filter((p) => p.startsWith(suite.directory));
    for (const check of suite.checks) {
      const result = check.run(repoRoot, suiteFiles);
      if (!result.ok) {
        return {
          ok: false,
          reason: `invariant '${check.name}' failed for ${suite.directory}: ${result.reason}`,
        };
      }
    }
  }
  return { ok: true };
}
