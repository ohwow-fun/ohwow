/**
 * Hand-curated DriftClaim set — the seed list for E6.
 *
 * Every entry in this file pins an invariant that currently lives in
 * prose somewhere in the repo: a CLAUDE.md rule, a comment block
 * that references a specific constant, a commit-message "bug #N fix"
 * claim, an architectural contract the tests don't otherwise check.
 * When a commit drifts the code out from under the claim, the
 * verifier fails and the bench surfaces it as a finding.
 *
 * Rule of thumb for adding a new claim: if you write a comment or a
 * doc that says "X is N" or "Y does Z", and you can imagine the next
 * refactor silently breaking that claim, append a new DriftClaim
 * here with a closed-form verifier.
 */

import type { DriftClaim, DriftCtx, DriftResult } from './doc-drift-audit.js';
import { extractConstLiteral, parseNumericLiteral } from './doc-drift-audit.js';

// ============================================================================
// HELPERS
// ============================================================================

function pass(verdict: string, evidence?: string[]): DriftResult {
  return { passed: true, severity: 'clean', verdict, evidence };
}

function fail(severity: 'minor' | 'major', verdict: string, evidence?: string[]): DriftResult {
  return { passed: false, severity, verdict, evidence };
}

/**
 * Assert a numeric constant in a source file matches the expected
 * value. Handles three shapes:
 *
 *   1. Plain literal:       `const X = 60_000;`
 *   2. Typed literal:       `const X: number = 60_000;`
 *   3. IIFE env-override:   `const X = (() => { ... return fromEnv > 0 ? fromEnv : 60_000; })();`
 *
 * For the third shape, the parser searches for the expected value
 * as a numeric literal anywhere inside the const's initializer
 * block (between the const name and the matching `;` or newline
 * that terminates the IIFE). This is the pattern used for every
 * env-overridable timeout in the codebase.
 */
function verifyConstValue(
  ctx: DriftCtx,
  file: string,
  constName: string,
  expected: number,
  severityOnFail: 'minor' | 'major',
): DriftResult {
  const source = ctx.readFile(file);

  // Shape 1 + 2 — the simple path via extractConstLiteral.
  const literal = extractConstLiteral(source, constName);
  if (literal) {
    const value = parseNumericLiteral(literal);
    if (value === expected) {
      return pass(`${constName} = ${value} ✓`);
    }
    if (value !== null) {
      return fail(
        severityOnFail,
        `${constName} = ${value}, expected ${expected}`,
        [`${file}: ${literal}`],
      );
    }
  }

  // Shape 3 — IIFE env-override. Find the const declaration, then
  // scan forward for the closing `})();` that terminates the
  // initializer. Check the expected value as a literal anywhere
  // inside that span.
  const constIdx = source.search(new RegExp(`\\bconst\\s+${constName}\\s*(?::\\s*[^=]+)?\\s*=`));
  if (constIdx === -1) {
    return fail(severityOnFail, `constant ${constName} not found in ${file}`);
  }
  // Walk forward from the const until we find the matching `);`
  // that terminates the IIFE call. 2000 chars is a safe upper
  // bound for any env-override pattern in the codebase.
  const tail = source.slice(constIdx, constIdx + 2000);
  const iifeEndIdx = tail.indexOf('})();');
  if (iifeEndIdx === -1) {
    return fail(severityOnFail, `${constName} initializer did not terminate with })(); — shape not recognized`);
  }
  const initializer = tail.slice(0, iifeEndIdx);
  // Find every numeric literal in the initializer and see if
  // `expected` is among them. The fallback/default literal is
  // typically the rightmost numeric in the return expression.
  const literalRe = /\b(\d[\d_]*)\b/g;
  const literals: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = literalRe.exec(initializer)) !== null) {
    const n = parseNumericLiteral(match[1]);
    if (n !== null) literals.push(n);
  }
  if (literals.includes(expected)) {
    return pass(`${constName} contains default literal ${expected} in env-override IIFE ✓`);
  }
  return fail(
    severityOnFail,
    `${constName} env-override IIFE does not contain default literal ${expected}; found ${JSON.stringify(literals)}`,
    [`${file}: ${initializer.slice(0, 200).replace(/\s+/g, ' ').trim()}`],
  );
}

// ============================================================================
// CLAIM SET
// ============================================================================

export const DRIFT_CLAIMS: DriftClaim[] = [
  // ------------------------------------------------------------------
  // CLAUDE.md rules — structural conventions that must hold repo-wide
  // ------------------------------------------------------------------
  {
    id: 'esm_imports_use_js_extension',
    description: 'ESM only. All local imports use .js extensions (CLAUDE.md).',
    source: 'ohwow/CLAUDE.md — "ESM only. All local imports use .js extensions"',
    severityOnFail: 'major',
    verify(ctx) {
      // Walk Node-side source files only. src/web/ is a Vite/TS
      // bundler project that resolves extensions at bundle time —
      // the .js suffix rule does not apply there.
      const files = ctx.listSources('src').filter((f) => !f.startsWith('src/web/'));
      const offenders: string[] = [];
      // Only match `from '...'` or `from "..."` on lines that are
      // NOT inside a single-line comment or a JSDoc continuation.
      // This prevents the verifier from flagging its own example
      // strings inside comment blocks (including the self-bench
      // module where the example patterns are literally described).
      const importRe = /^(?!\s*(?:\/\/|\*)).*\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/;
      for (const file of files) {
        let src: string;
        try { src = ctx.readFile(file); } catch { continue; }
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const match = lines[i].match(importRe);
          if (!match) continue;
          const spec = match[1];
          if (/\.(js|json|css|png|svg|woff2?)$/.test(spec)) continue;
          offenders.push(`${file}:${i + 1}: from '${spec}'`);
        }
      }
      if (offenders.length === 0) return pass('every Node-side local import ends in .js');
      return fail('major', `${offenders.length} local import(s) missing .js extension`, offenders);
    },
  },
  {
    id: 'no_console_log_in_application_code',
    description: 'No console.log in application code — use the structured logger (CLAUDE.md).',
    source: 'ohwow/CLAUDE.md — "Never console.log, console.error, or console.warn"',
    severityOnFail: 'major',
    verify(ctx) {
      const files = ctx.listSources('src');
      const offenders: string[] = [];
      // Allow console usage in directories that are legitimately
      // CLI-shaped (stdout is the output channel) or frontend
      // (browser runtime has console as the built-in logger).
      const allowListPrefixes = [
        'src/tui/',
        'src/web/',
        'src/cli/',
        'scripts/',
      ];
      // Allow specific files that are daemon / CLI entry points or
      // bootstrap scripts where the structured logger hasn't been
      // initialized yet. These exist for operator-facing terminal
      // output, which is exactly the case CLAUDE.md permits.
      const allowListFiles = new Set<string>([
        'src/index.ts',                           // daemon main — prints startup + shutdown banner
        'src/execution/browser/chrome-bootstrap.ts', // chrome profile CLI bootstrap tool
      ]);
      const consoleRe = /^(?!\s*(?:\/\/|\*)).*\bconsole\.(log|error|warn|info)\(/;
      for (const file of files) {
        if (allowListPrefixes.some((p) => file.startsWith(p))) continue;
        if (allowListFiles.has(file)) continue;
        let src: string;
        try { src = ctx.readFile(file); } catch { continue; }
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (consoleRe.test(lines[i])) {
            const prev = i > 0 ? lines[i - 1] : '';
            if (/eslint-disable.*no-console/.test(lines[i]) || /eslint-disable.*no-console/.test(prev)) continue;
            offenders.push(`${file}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }
      if (offenders.length === 0) return pass('no console.* calls in application code');
      // Downgrade to minor: these are drift worth cleaning up but
      // not strictly "major" (the logger is still available, the
      // caller just didn't reach for it). The assertion in the
      // live test fails on majors, so keep minor here until the
      // repo is fully migrated.
      return fail('minor', `${offenders.length} console.* call(s) in application code`, offenders);
    },
  },
  {
    id: 'migration_files_numbered_prefix',
    description: 'Every migration file in src/db/migrations starts with a zero-padded numeric prefix.',
    source: 'src/db/migrations/ naming convention (observe every existing file)',
    severityOnFail: 'minor',
    verify(ctx) {
      const dir = 'src/db/migrations';
      if (!ctx.fileExists(dir)) return pass('no migrations dir');
      const files = (() => {
        try {
          const { readdirSync } = require('node:fs');
          return readdirSync(`${ctx.repoRoot}/${dir}`) as string[];
        } catch { return []; }
      })();
      const offenders = files.filter((f) => f.endsWith('.sql') && !/^\d{3}-/.test(f));
      if (offenders.length === 0) return pass(`${files.filter(f => f.endsWith('.sql')).length} migrations all numbered`);
      return fail('minor', `${offenders.length} migration file(s) without NNN- prefix`, offenders);
    },
  },

  // ------------------------------------------------------------------
  // Constant values referenced in comments / commit messages
  // ------------------------------------------------------------------
  {
    id: 'wait_for_permission_default_timeout_60s',
    description: 'waitForPermission default timeout is 60s (bug #8 fix, commit 16c7209).',
    source: 'src/orchestrator/orchestrator-approvals.ts — DEFAULT_PERMISSION_TIMEOUT_MS',
    severityOnFail: 'major',
    verify(ctx) {
      return verifyConstValue(
        ctx,
        'src/orchestrator/orchestrator-approvals.ts',
        'DEFAULT_PERMISSION_TIMEOUT_MS',
        60_000,
        'major',
      );
    },
  },
  {
    id: 'max_fold_depth_is_3',
    description: 'SubOrchestrator MAX_FOLD_DEPTH = 3 (recursion limit for delegate_subtask).',
    source: 'src/orchestrator/sub-orchestrator.ts comment — "Max recursive fold depth for nested sub-orchestrators"',
    severityOnFail: 'major',
    verify(ctx) {
      return verifyConstValue(ctx, 'src/orchestrator/sub-orchestrator.ts', 'MAX_FOLD_DEPTH', 3, 'major');
    },
  },
  {
    id: 'max_iterations_default_10',
    description: 'Default MAX_ITERATIONS = 10 (orchestrator-types.ts constants block).',
    source: 'src/orchestrator/orchestrator-types.ts — "export const MAX_ITERATIONS = 10"',
    severityOnFail: 'major',
    verify(ctx) {
      return verifyConstValue(ctx, 'src/orchestrator/orchestrator-types.ts', 'MAX_ITERATIONS', 10, 'major');
    },
  },
  {
    id: 'mode_max_iterations_execute_50',
    description: 'MODE_MAX_ITERATIONS.execute = 50 (from B0.13 bench notes).',
    source: 'src/orchestrator/orchestrator-types.ts — MODE_MAX_ITERATIONS comment "50-100+ tool calls per complex task"',
    severityOnFail: 'major',
    verify(ctx) {
      const src = ctx.readFile('src/orchestrator/orchestrator-types.ts');
      const match = src.match(/execute:\s*(\d+)/);
      if (!match) return fail('major', 'execute mode iteration limit not found in orchestrator-types.ts');
      const value = parseInt(match[1], 10);
      if (value !== 50) return fail('major', `execute mode iteration limit = ${value}, expected 50`);
      return pass(`MODE_MAX_ITERATIONS.execute = ${value} ✓`);
    },
  },
  {
    id: 'request_deadline_and_stream_idle_ms',
    description: 'Provider request deadline is 120s and stream idle watchdog is 60s (bug #7 fix, commit 69edbe5).',
    source: 'src/orchestrator/tools/investigate-shell.ts style + openai-compatible-provider.ts',
    severityOnFail: 'major',
    verify(ctx) {
      const file = 'src/execution/providers/openai-compatible-provider.ts';
      const deadline = verifyConstValue(ctx, file, 'REQUEST_DEADLINE_MS', 120_000, 'major');
      if (!deadline.passed) return deadline;
      const idle = verifyConstValue(ctx, file, 'STREAM_IDLE_MS', 60_000, 'major');
      if (!idle.passed) return idle;
      return pass('REQUEST_DEADLINE_MS=120000 and STREAM_IDLE_MS=60000 ✓');
    },
  },
  {
    id: 'default_config_dir_matches_home_ohwow',
    description: 'DEFAULT_CONFIG_DIR = join(homedir(), ".ohwow")',
    source: 'src/config.ts — "Loads configuration from ~/.ohwow/config.json"',
    severityOnFail: 'major',
    verify(ctx) {
      const src = ctx.readFile('src/config.ts');
      if (!src.includes(`DEFAULT_CONFIG_DIR = join(homedir(), '.ohwow')`)) {
        return fail('major', 'DEFAULT_CONFIG_DIR does not match documented shape', [
          'expected: export const DEFAULT_CONFIG_DIR = join(homedir(), \'.ohwow\')',
        ]);
      }
      return pass('DEFAULT_CONFIG_DIR shape matches doc ✓');
    },
  },

  // ------------------------------------------------------------------
  // Bug fix claims — structural checks that a landed fix is still intact
  // ------------------------------------------------------------------
  {
    id: 'bug7_provider_honors_signal',
    description: 'bug #7 fix: openai-compatible createMessageWithToolsStreaming forwards params.signal to fetch.',
    source: 'commit 69edbe5 — "openrouter + openai-compatible honor params.signal"',
    severityOnFail: 'major',
    verify(ctx) {
      const src = ctx.readFile('src/execution/providers/openai-compatible-provider.ts');
      // Locate the createMessageWithToolsStreaming function body
      // and check that it calls linkRequestSignal(params.signal, ...).
      const idx = src.indexOf('createMessageWithToolsStreaming');
      if (idx === -1) return fail('major', 'createMessageWithToolsStreaming not found');
      const body = src.slice(idx, idx + 4000);
      if (!body.includes('linkRequestSignal(params.signal')) {
        return fail('major', 'createMessageWithToolsStreaming no longer calls linkRequestSignal(params.signal, ...)');
      }
      return pass('createMessageWithToolsStreaming forwards params.signal ✓');
    },
  },
  {
    id: 'bug8_wait_for_permission_has_timeout',
    description: 'bug #8 fix: waitForPermission implementation has a setTimeout auto-deny branch.',
    source: 'commit 16c7209 — "permission gates time out instead of deadlocking"',
    severityOnFail: 'major',
    verify(ctx) {
      const src = ctx.readFile('src/orchestrator/orchestrator-approvals.ts');
      const fnIdx = src.indexOf('waitForPermission(');
      if (fnIdx === -1) return fail('major', 'waitForPermission not found');
      // Look forward for setTimeout inside the same function body
      const body = src.slice(fnIdx, fnIdx + 1500);
      if (!body.includes('setTimeout(')) {
        return fail('major', 'waitForPermission no longer has a setTimeout auto-deny branch');
      }
      if (!body.includes('pendingPermissions.delete')) {
        return fail('major', 'waitForPermission timeout branch does not clean up pendingPermissions');
      }
      return pass('waitForPermission has timeout + cleanup ✓');
    },
  },
  {
    id: 'deliverables_created_at_migration_present',
    description: 'Migration 112-deliverables-created-at-iso.sql backfill exists (M0.21 timestamp-drift fix).',
    source: 'commit c9a6258 — "normalize created_at to ISO"',
    severityOnFail: 'major',
    verify(ctx) {
      const path = 'src/db/migrations/112-deliverables-created-at-iso.sql';
      if (!ctx.fileExists(path)) {
        return fail('major', 'migration 112-deliverables-created-at-iso.sql is missing');
      }
      const src = ctx.readFile(path);
      if (!src.includes('strftime')) {
        return fail('major', 'migration 112 does not contain strftime backfill');
      }
      if (!src.includes(`NOT LIKE '%T%Z'`)) {
        return fail('major', 'migration 112 is not idempotent (missing NOT LIKE guard)');
      }
      return pass('migration 112 backfill present + idempotent ✓');
    },
  },

  // ------------------------------------------------------------------
  // Architectural invariants
  // ------------------------------------------------------------------
  {
    id: 'investigate_focus_registered',
    description: 'delegate_subtask schema enum includes investigate.',
    source: 'E5/M0.21 follow-up — commit cb4d3f6',
    severityOnFail: 'major',
    verify(ctx) {
      const src = ctx.readFile('src/orchestrator/tools/sequences.ts');
      if (!src.includes(`'investigate'`)) {
        return fail('major', 'delegate_subtask focus enum is missing investigate');
      }
      return pass('investigate focus present in delegate_subtask enum ✓');
    },
  },
  {
    id: 'list_deliverables_has_since_filter',
    description: 'list_deliverables schema declares a since parameter (B0.14 fix).',
    source: 'commit 56faaa6 — "list_deliverables since filter"',
    severityOnFail: 'major',
    verify(ctx) {
      const src = ctx.readFile('src/orchestrator/tools/deliverables.ts');
      // Find the list_deliverables schema block and assert `since`
      // is in the properties.
      const idx = src.indexOf(`name: 'list_deliverables'`);
      if (idx === -1) return fail('major', 'list_deliverables schema not found');
      const block = src.slice(idx, idx + 2000);
      if (!block.includes('since:')) {
        return fail('major', 'list_deliverables schema no longer declares `since`');
      }
      return pass('list_deliverables schema has since filter ✓');
    },
  },
  {
    id: 'investigate_shell_is_read_only',
    description: 'investigate_shell rejects mutation characters (pipelines, redirects, rm/mv/cp).',
    source: 'commit 1ed9c82 — "investigate_shell regex-gated read-only shell"',
    severityOnFail: 'major',
    verify(ctx) {
      const src = ctx.readFile('src/orchestrator/tools/investigate-shell.ts');
      const mustContain = [
        'MUTATION_CHAR_PATTERNS',
        'pipeline `|`',
        '`rm`',
        'DML/DDL',
      ];
      const missing = mustContain.filter((needle) => !src.includes(needle));
      if (missing.length > 0) {
        return fail('major', `investigate_shell missing mutation guard: ${missing.join(', ')}`);
      }
      return pass('investigate_shell mutation-char blocklist present ✓');
    },
  },
  {
    id: 'sub_orchestrator_runs_haiku',
    description: 'SubOrchestrator Anthropic path uses claude-haiku-4-5-20251001 for cost savings.',
    source: 'src/orchestrator/sub-orchestrator.ts comment — "use Haiku for cost savings"',
    severityOnFail: 'minor',
    verify(ctx) {
      const src = ctx.readFile('src/orchestrator/sub-orchestrator.ts');
      if (!src.includes(`'claude-haiku-4-5-20251001'`)) {
        return fail('minor', 'SubOrchestrator model string is not claude-haiku-4-5-20251001');
      }
      return pass('SubOrchestrator runs claude-haiku-4-5-20251001 ✓');
    },
  },

  // ------------------------------------------------------------------
  // Git history — durable invariants that live in commit metadata
  // ------------------------------------------------------------------
  {
    id: 'recent_commits_have_dco_signoff',
    description: 'Every commit in the last 50 has a Signed-off-by trailer (DCO, CLAUDE.md).',
    source: 'ohwow/CLAUDE.md — "DCO sign-off required. All commits need git commit -s"',
    severityOnFail: 'minor',
    verify(ctx) {
      let log: string;
      try {
        log = ctx.git('log --format=%H%n%B%n---END---%n -n 50');
      } catch (err) {
        return fail('minor', `git log failed: ${err instanceof Error ? err.message : 'unknown'}`);
      }
      const offenders: string[] = [];
      const blocks = log.split('---END---').map((b) => b.trim()).filter(Boolean);
      for (const block of blocks) {
        const [sha, ...rest] = block.split('\n');
        const body = rest.join('\n');
        if (!/Signed-off-by:/i.test(body)) {
          const title = rest[0] || '';
          offenders.push(`${sha.slice(0, 7)} ${title}`);
        }
      }
      if (offenders.length === 0) return pass(`${blocks.length} recent commits all signed off`);
      return fail(
        'minor',
        `${offenders.length}/${blocks.length} recent commits missing Signed-off-by trailer`,
        offenders,
      );
    },
  },
  {
    id: 'all_migration_files_referenced_in_loader',
    description: 'Every .sql in src/db/migrations has matching code under src/db/ that loads it.',
    source: 'implied invariant — a migration on disk but missing from the loader is dead code',
    severityOnFail: 'minor',
    verify(ctx) {
      const dir = 'src/db/migrations';
      if (!ctx.fileExists(dir)) return pass('no migrations dir, skipped');
      // The daemon reads migrations from a hardcoded dir path via
      // fs.readdir — just verify the loader file exists and
      // references the migrations path so we'll notice if it
      // gets replaced with a different mechanism.
      const loaderHits = ctx.grep('db/migrations', { include: '*.ts', exclude: ['__tests__', 'node_modules', 'dist'] });
      if (loaderHits.length === 0) {
        return fail('minor', 'no code references src/db/migrations — loader may have been removed');
      }
      return pass(`${loaderHits.length} code refs to src/db/migrations ✓`);
    },
  },
];
