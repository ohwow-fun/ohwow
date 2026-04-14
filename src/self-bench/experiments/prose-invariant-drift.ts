/**
 * ProseInvariantDriftExperiment — wraps the E6 doc-vs-code drift
 * audit (src/orchestrator/self-bench/doc-drift-audit.ts) as a
 * scheduled experiment. Converts a hand-curated list of prose
 * invariants (CLAUDE.md rules, commit-pinned constant values,
 * architectural conventions, past bug-fix claims) into executable
 * verifiers and runs them on a daily cadence.
 *
 * A 'major' result means a prose claim no longer holds against the
 * current tree — e.g. CLAUDE.md says "ESM imports use .js" but a
 * verifier found local imports without the extension. A 'minor'
 * result is cosmetic drift the verifier chose to downgrade.
 *
 * Read-only. Needs source files on disk; when the repo tree isn't
 * present (production daemon without src/), the probe returns a
 * benign skip row (pass) instead of erroring.
 *
 * No intervene — fixing a prose-vs-code drift is case-by-case:
 * either the code changes to match the claim or the claim gets
 * updated / retired. Neither is safe to automate from a bench tick.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';

import type {
  Experiment,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import {
  runDriftAudit,
  createDriftCtx,
} from '../../orchestrator/self-bench/doc-drift-audit.js';
import { DRIFT_CLAIMS } from '../../orchestrator/self-bench/drift-claims.js';

function resolveRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../..'),
    resolve(here, '../../../..'),
    process.cwd(),
  ];
  for (const candidate of candidates) {
    try {
      statSync(join(candidate, 'CLAUDE.md'));
      return candidate;
    } catch { /* try next */ }
  }
  return process.cwd();
}

const REPO_ROOT = resolveRepoRoot();

interface ProseDriftEvidence extends Record<string, unknown> {
  total: number;
  clean: number;
  minor: number;
  major: number;
  majors: Array<{ id: string; source: string; verdict: string; evidence: string[] }>;
  minors: Array<{ id: string; source: string; verdict: string }>;
  skip_reason: string | null;
}

function emptyEvidence(skipReason: string | null): ProseDriftEvidence {
  return {
    total: 0,
    clean: 0,
    minor: 0,
    major: 0,
    majors: [],
    minors: [],
    skip_reason: skipReason,
  };
}

export class ProseInvariantDriftExperiment implements Experiment {
  id = 'prose-invariant-drift';
  name = 'Doc/prose ↔ code invariant drift audit';
  category = 'other' as const;
  hypothesis =
    'Every prose invariant in CLAUDE.md, commit-pinned constant claims, and architectural comment promises still holds against the current codebase — no silent drift between documentation and code.';
  cadence = { everyMs: 24 * 60 * 60 * 1000, runOnBoot: false };

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    let driftCtx;
    try {
      statSync(join(REPO_ROOT, 'CLAUDE.md'));
      driftCtx = createDriftCtx(REPO_ROOT);
    } catch {
      return {
        subject: null,
        summary: 'skipped — CLAUDE.md not on disk (non-dev daemon)',
        evidence: emptyEvidence('CLAUDE.md not readable'),
      };
    }

    const run = runDriftAudit(DRIFT_CLAIMS, driftCtx);

    const majors = run.results
      .filter((r) => r.result.severity === 'major')
      .map((r) => ({
        id: r.claim.id,
        source: r.claim.source,
        verdict: r.result.verdict,
        evidence: (r.result.evidence ?? []).slice(0, 5),
      }));
    const minors = run.results
      .filter((r) => r.result.severity === 'minor')
      .map((r) => ({
        id: r.claim.id,
        source: r.claim.source,
        verdict: r.result.verdict,
      }));

    const evidence: ProseDriftEvidence = {
      total: run.summary.total,
      clean: run.summary.clean,
      minor: run.summary.minor,
      major: run.summary.major,
      majors,
      minors,
      skip_reason: null,
    };

    const summary = run.summary.major > 0
      ? `${run.summary.major} major invariant(s) drifted — prose claim no longer holds`
      : run.summary.minor > 0
        ? `${run.summary.minor} minor drift(s); ${run.summary.clean} clean of ${run.summary.total}`
        : `all ${run.summary.total} invariant(s) clean`;

    const subject = majors.length > 0
      ? `claim:${majors[0].id}`
      : minors.length > 0
        ? `claim:${minors[0].id}`
        : null;

    return { subject, summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ProseDriftEvidence;
    if (ev.skip_reason) return 'pass';
    if (ev.major > 0) return 'fail';
    if (ev.minor > 0) return 'warning';
    return 'pass';
  }
}
