/**
 * PatchAuthorExperiment — capstone application of Layers 1-9.
 *
 * Reads self_findings for warning|fail rows whose evidence.affected_files
 * intersect a tier-2 path, filters out findings already addressed by an
 * existing autonomous patch (commits carrying Fixes-Finding-Id: <id>),
 * surfaces the remaining set as patch candidates, and (when the
 * patch-author kill switch is open) drafts and commits one patch per
 * tick via the full Layer 1-9 pipeline.
 *
 * Two-switch model
 * ----------------
 * ~/.ohwow/self-commit-enabled — gate on safeSelfCommit (Layer 1+).
 * ~/.ohwow/patch-author-enabled — gate on this experiment's intervene
 * step. Both must be present for an autonomous patch to land. Either
 * being closed leaves the experiment in observe-only mode (records
 * candidates in the ledger, doesn't draft a patch).
 *
 * Per-tick budget
 * ---------------
 * One patch per tick by design. Tighter than safeSelfCommit's daily
 * budget (24/day). Keeps each tick's blast radius to a single file
 * change so a runaway model output can't fan out into a sweep.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import {
  getSelfCommitStatus,
  safeSelfCommit,
  type FindingLookup,
} from '../self-commit.js';
import { getAllowedPrefixes, resolvePathTier, resolvePatchMode } from '../path-trust-tiers.js';
import {
  parseStringLiteralEditsResponse,
  applyStringLiteralEdits,
  type StringLiteralEdit,
} from './string-literal-patch.js';
import {
  buildProvenancePrompt,
  validateProvenanceInputs,
  type ProvenanceInput,
} from '../patch-prompt-provenance.js';
import { runLlmCall } from '../../execution/llm-organ.js';
import { logger } from '../../lib/logger.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Findings older than this are stale per safeSelfCommit's 7d window. */
const FINDING_LOOKBACK_MS = 7 * DAY;

interface FindingRow {
  id: string;
  experiment_id: string;
  subject: string | null;
  verdict: string;
  ran_at: string;
  evidence: unknown;
}

export interface PatchCandidate {
  findingId: string;
  experimentId: string;
  subject: string | null;
  verdict: string;
  ranAt: string;
  /** Subset of affected_files that resolve to tier-2 paths. */
  tier2Files: string[];
}

interface CandidatesEvidence extends Record<string, unknown> {
  repo_root: string | null;
  tier2_prefixes: string[];
  findings_scanned: number;
  candidates: PatchCandidate[];
  reason?: string;
}

export class PatchAuthorExperiment implements Experiment {
  readonly id = 'patch-author';
  readonly name = 'Autonomous patch author (observe-only)';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'Recent warning|fail findings whose affected_files intersect a tier-2 ' +
    'path describe a real, currently-broken contract that the autonomous ' +
    'loop could fix. Surfacing them as patch candidates lets the operator ' +
    'audit the judgment before model-driven authoring is enabled.';
  readonly cadence = { everyMs: 10 * 60 * 1000, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const { repoRoot } = getSelfCommitStatus();
    const tier2Prefixes = listTier2Prefixes();
    if (tier2Prefixes.length === 0) {
      const evidence: CandidatesEvidence = {
        repo_root: repoRoot,
        tier2_prefixes: [],
        findings_scanned: 0,
        candidates: [],
        reason: 'no_tier2_paths',
      };
      return {
        subject: 'meta:patch-author',
        summary: 'no tier-2 paths registered — nothing to author against',
        evidence,
      };
    }

    const findings = await this.fetchRecentFindings(ctx);
    const alreadyPatched = repoRoot
      ? collectFindingIdsAlreadyPatched(repoRoot, FINDING_LOOKBACK_MS)
      : new Set<string>();

    const candidates: PatchCandidate[] = [];
    for (const row of findings) {
      if (row.verdict !== 'warning' && row.verdict !== 'fail') continue;
      if (alreadyPatched.has(row.id)) continue;
      const affected = extractAffectedFiles(row.evidence);
      const tier2Files = affected.filter((f) => resolvePathTier(f).tier === 'tier-2');
      if (tier2Files.length === 0) continue;
      // Cheap extra filter: if the finding's evidence lists specific
      // violation literals, require at least one of them to appear
      // verbatim in one of the tier-2 source files. DOM-scraped
      // findings often attribute runtime data (e.g. a person's role)
      // to a page path; that data isn't in source, so a patch-author
      // LLM call would waste a token budget refusing at the applier.
      // When evidence has no literals to inspect, the gate stays
      // permissive so every finding shape keeps working.
      if (repoRoot && !evidenceLiteralsAppearInSource(repoRoot, tier2Files, row.evidence)) {
        continue;
      }
      candidates.push({
        findingId: row.id,
        experimentId: row.experiment_id,
        subject: row.subject,
        verdict: row.verdict,
        ranAt: row.ran_at,
        tier2Files,
      });
    }

    const evidence: CandidatesEvidence = {
      repo_root: repoRoot,
      tier2_prefixes: tier2Prefixes,
      findings_scanned: findings.length,
      candidates,
    };
    const summary =
      candidates.length === 0
        ? `${findings.length} finding(s) scanned, 0 tier-2 patch candidates`
        : `${candidates.length} tier-2 patch candidate(s): ${candidates
            .map((c) => `${c.experimentId}/${c.findingId.slice(0, 8)}`)
            .join(', ')}`;
    return { subject: 'meta:patch-author', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as CandidatesEvidence;
    if (ev.reason === 'no_tier2_paths') return 'pass';
    if (ev.candidates.length === 0) return 'pass';
    return 'warning';
  }

  async intervene(
    verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    if (verdict !== 'warning') return null;
    const ev = result.evidence as CandidatesEvidence;
    if (ev.candidates.length === 0) return null;

    // Observe-only path: log the candidates; do not draft a patch.
    if (!isPatchAuthorEnabled()) {
      for (const c of ev.candidates) {
        logger.info(
          {
            findingId: c.findingId,
            experimentId: c.experimentId,
            tier2Files: c.tier2Files,
          },
          '[patch-author] candidate observed (kill switch closed — no patch)',
        );
      }
      return {
        description: `observe-only: surfaced ${ev.candidates.length} tier-2 candidate(s); ${PATCH_AUTHOR_ENABLED_PATH} not present`,
        details: { mode: 'observe-only', candidates: ev.candidates },
      };
    }

    // Authoring path: pick one candidate per tick.
    const candidate = ev.candidates[0];
    const repoRoot = ev.repo_root;
    if (!repoRoot) {
      return {
        description: 'no repo root configured — cannot author a patch',
        details: { mode: 'error', candidate },
      };
    }
    if (!ctx.engine?.modelRouter) {
      return {
        description: 'no model router on engine — cannot author a patch',
        details: { mode: 'error', candidate },
      };
    }

    const outcome = await this.draftAndCommit(candidate, repoRoot, ctx);
    return {
      description: outcome.description,
      details: { mode: 'authoring', candidate, ...outcome.details },
    };
  }

  private async draftAndCommit(
    candidate: PatchCandidate,
    repoRoot: string,
    ctx: ExperimentContext,
  ): Promise<{ description: string; details: Record<string, unknown> }> {
    const targetPath = candidate.tier2Files[0];
    const sourceContent = readRepoFile(repoRoot, targetPath);
    if (sourceContent === null) {
      return {
        description: `could not read source file ${targetPath}`,
        details: { stage: 'read-source', target: targetPath },
      };
    }

    const findingRow = await fetchFindingRow(ctx, candidate.findingId);
    if (!findingRow) {
      return {
        description: `finding ${candidate.findingId} not found in db`,
        details: { stage: 'read-finding' },
      };
    }
    const findingBlob = JSON.stringify(
      {
        id: findingRow.id,
        experiment_id: findingRow.experiment_id,
        verdict: findingRow.verdict,
        summary: findingRow.summary ?? '',
        hypothesis: findingRow.hypothesis ?? '',
        evidence: findingRow.evidence,
      },
      null,
      2,
    );

    const provenanceInputs: ProvenanceInput[] = [
      { source: 'finding', ref: candidate.findingId, content: findingBlob },
      { source: 'source-file', ref: targetPath, content: sourceContent },
    ];
    const validation = validateProvenanceInputs(provenanceInputs, repoRoot);
    if (!validation.ok) {
      return {
        description: `provenance validation failed: ${validation.reason}`,
        details: { stage: 'provenance' },
      };
    }
    const promptBody = buildProvenancePrompt(provenanceInputs);

    const patchMode = resolvePatchMode(targetPath);
    const sys =
      patchMode === 'string-literal'
        ? buildStringLiteralSystemPrompt(targetPath)
        : buildWholeFileSystemPrompt(targetPath);

    const llm = await runLlmCall(
      {
        modelRouter: ctx.engine.modelRouter!,
        db: ctx.db,
        workspaceId: ctx.workspaceId,
      },
      {
        purpose: 'reasoning',
        system: sys,
        prompt: promptBody,
        max_tokens: 4096,
        temperature: 0,
      },
    );
    if (!llm.ok) {
      return {
        description: `model call failed: ${llm.error}`,
        details: { stage: 'model' },
      };
    }

    let newContent: string;
    let editsApplied: StringLiteralEdit[] | null = null;
    if (patchMode === 'string-literal') {
      const parsed = parseStringLiteralEditsResponse(llm.data.text);
      if (!Array.isArray(parsed)) {
        return {
          description: `string-literal edits parse failed: ${parsed.error}`,
          details: { stage: 'parse', raw: llm.data.text.slice(0, 500) },
        };
      }
      const applied = applyStringLiteralEdits(sourceContent, parsed);
      if (!applied.ok || !applied.content) {
        return {
          description: `string-literal edits could not be applied: ${applied.reason}`,
          details: { stage: 'apply', edits: parsed, raw: llm.data.text.slice(0, 500) },
        };
      }
      newContent = applied.content;
      editsApplied = parsed;
    } else {
      newContent = stripCodeFences(llm.data.text);
      if (!newContent || newContent.length < 20) {
        return {
          description: 'model returned empty or implausibly short patch',
          details: { stage: 'parse', length: newContent.length },
        };
      }
    }

    const findingResolver = (id: string): Promise<FindingLookup | null> =>
      resolveFindingForCommit(ctx, id);

    const commitMessage =
      `feat(self-bench): patch ${path.basename(targetPath)} for finding ${candidate.findingId.slice(0, 8)}\n\n` +
      `Autonomous tier-2 patch in response to finding ${candidate.findingId} ` +
      `(experiment=${candidate.experimentId}, verdict=${candidate.verdict}).\n` +
      `Hypothesis: ${findingRow.hypothesis ?? '(none)'}\n` +
      `Summary: ${findingRow.summary ?? '(none)'}\n`;

    const commit = await safeSelfCommit({
      files: [{ path: targetPath, content: newContent }],
      commitMessage,
      experimentId: this.id,
      extendsExperimentId: null,
      whyNotEditExisting:
        `Tier-2 patch path: this commit MODIFIES ${targetPath} in response to finding ${candidate.findingId}; the patch is the intervention.`,
      fixesFindingId: candidate.findingId,
      findingResolver,
    });
    if (!commit.ok) {
      return {
        description: `safeSelfCommit refused: ${commit.reason}`,
        details: { stage: 'commit', reason: commit.reason, model: llm.data.model_used },
      };
    }
    return {
      description: `landed autonomous patch ${commit.commitSha?.slice(0, 12)} on ${targetPath}`,
      details: {
        stage: 'committed',
        commitSha: commit.commitSha,
        patchMode,
        edits: editsApplied,
        model: llm.data.model_used,
        provider: llm.data.provider,
        cost_cents: llm.data.cost_cents,
      },
    };
  }

  private async fetchRecentFindings(
    ctx: ExperimentContext,
  ): Promise<FindingRow[]> {
    const since = new Date(Date.now() - FINDING_LOOKBACK_MS).toISOString();
    try {
      const { data } = await ctx.db
        .from<FindingRow>('self_findings')
        .select('id, experiment_id, subject, verdict, ran_at, evidence')
        .gte('ran_at', since)
        .limit(2000);
      return (data ?? []) as FindingRow[];
    } catch {
      return [];
    }
  }
}

function buildWholeFileSystemPrompt(targetPath: string): string {
  return (
    'You patch one TypeScript file in response to one self-bench finding. ' +
    'Output ONLY the full new contents of the source file shown in the ' +
    '<source name="source-file"> block. No markdown fences, no commentary, ' +
    'no diff. The output must be valid TypeScript that preserves the file\'s ' +
    "public API and only changes what the finding describes. Keep changes " +
    'minimal — one top-level symbol modified at most. The file you are ' +
    `editing is referenced by ref="${targetPath}".`
  );
}

function buildStringLiteralSystemPrompt(targetPath: string): string {
  return (
    'You patch one TypeScript/TSX file by emitting a JSON array of ' +
    'string-literal edits. The file is referenced by ref="' +
    targetPath +
    '" in the <source name="source-file"> block. Rules:\n' +
    '  1. Output ONLY a JSON array. No markdown fences, no commentary.\n' +
    '  2. Each element is {"find": string, "replace": string, ' +
    '"occurrence"?: number}.\n' +
    '  3. `find` must match characters that live INSIDE a string ' +
    'literal, template-literal chunk, or JSX text in the source. Do ' +
    'NOT include surrounding quotes, JSX tags, or any syntax outside ' +
    'the string.\n' +
    '  4. `find` must match the source exactly. Whitespace matters. ' +
    'If `find` could match more than once, include a 1-based ' +
    '`occurrence` to disambiguate.\n' +
    '  5. Only fix what the finding describes. Do not touch unrelated ' +
    'strings. No identifier renames, no logic changes, no imports.\n' +
    '  6. `replace` must differ from `find` and must obey the ' +
    'project copywriting rules the finding cites.\n' +
    'Example: [{"find":"Failed to save.","replace":"Couldn\'t save. ' +
    'Try again?"}]'
  );
}

/** All currently-registered tier-2 prefixes (longest-prefix-match candidates). */
export function listTier2Prefixes(): string[] {
  return getAllowedPrefixes().filter(
    (prefix) => resolvePathTier(prefix).tier === 'tier-2',
  );
}

/**
 * Does at least one violation literal from `evidence.violations[]`
 * appear verbatim in any of `tier2Files`? Returns true (permissive)
 * when evidence has no violations array or no usable literal
 * strings — other finding shapes keep flowing through unchanged.
 * Short literals (<3 chars) are ignored so a stray single-character
 * match like "—" on its own can't hide a real miss.
 */
export function evidenceLiteralsAppearInSource(
  repoRoot: string,
  tier2Files: readonly string[],
  evidence: unknown,
): boolean {
  if (!evidence || typeof evidence !== 'object') return true;
  const violations = (evidence as Record<string, unknown>).violations;
  if (!Array.isArray(violations)) return true;
  const literals: string[] = [];
  for (const v of violations) {
    if (!v || typeof v !== 'object') continue;
    const lit = (v as Record<string, unknown>).literal;
    const match = (v as Record<string, unknown>).match;
    if (typeof lit === 'string' && lit.length >= 3) literals.push(lit);
    else if (typeof match === 'string' && match.length >= 3) literals.push(match);
  }
  if (literals.length === 0) return true;
  for (const file of tier2Files) {
    let src: string;
    try {
      src = fs.readFileSync(path.join(repoRoot, file), 'utf-8');
    } catch {
      continue;
    }
    for (const lit of literals) {
      if (src.includes(lit)) return true;
    }
  }
  return false;
}

/** Pull a string[] out of evidence.affected_files; safe against missing/bad shapes. */
export function extractAffectedFiles(evidence: unknown): string[] {
  if (!evidence || typeof evidence !== 'object') return [];
  const raw = (evidence as Record<string, unknown>).affected_files;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .map((p) => path.normalize(p).replace(/\\/g, '/'));
}

/**
 * Patch-author kill switch. Distinct from self-commit-enabled and
 * auto-revert-enabled so the operator can open authoring without
 * opening reverts (and vice versa). Default closed.
 */
export const PATCH_AUTHOR_ENABLED_PATH = path.join(
  os.homedir(),
  '.ohwow',
  'patch-author-enabled',
);

const PATCH_AUTHOR_TEST_BYPASS_ENV = 'OHWOW_PATCH_AUTHOR_TEST_ALLOW';

export function isPatchAuthorEnabled(): boolean {
  if (process.env[PATCH_AUTHOR_TEST_BYPASS_ENV] === '1') return true;
  try {
    return fs.existsSync(PATCH_AUTHOR_ENABLED_PATH);
  } catch {
    return false;
  }
}

function readRepoFile(repoRoot: string, relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(repoRoot, relPath), 'utf-8');
  } catch {
    return null;
  }
}

interface FullFindingRow {
  id: string;
  experiment_id: string;
  verdict: string;
  ran_at: string;
  hypothesis: string | null;
  summary: string | null;
  evidence: unknown;
}

async function fetchFindingRow(
  ctx: ExperimentContext,
  findingId: string,
): Promise<FullFindingRow | null> {
  try {
    const { data } = await ctx.db
      .from<FullFindingRow>('self_findings')
      .select('id, experiment_id, verdict, ran_at, hypothesis, summary, evidence')
      .eq('id', findingId)
      .limit(1);
    const rows = (data ?? []) as FullFindingRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a finding into the narrow shape safeSelfCommit's Layer 2 gate
 * needs. Maps verdict (string) to the typed union and pulls
 * affected_files out of evidence.
 */
async function resolveFindingForCommit(
  ctx: ExperimentContext,
  findingId: string,
): Promise<FindingLookup | null> {
  const row = await fetchFindingRow(ctx, findingId);
  if (!row) return null;
  const verdict =
    row.verdict === 'pass' ||
    row.verdict === 'warning' ||
    row.verdict === 'fail' ||
    row.verdict === 'error'
      ? row.verdict
      : 'fail';
  return {
    id: row.id,
    verdict,
    ranAt: row.ran_at,
    affectedFiles: extractAffectedFiles(row.evidence),
  };
}

/**
 * Strip a single fenced code block if the model wrapped its answer.
 * Permissive about the fence language tag. Trims leading/trailing
 * whitespace either way.
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  if (fence) return fence[1].trim();
  return trimmed;
}

/**
 * Scan git log for autonomous commits in the lookback window carrying a
 * Fixes-Finding-Id: <uuid> trailer. Those finding ids have already been
 * addressed and should not appear as fresh candidates. Pure read.
 */
export function collectFindingIdsAlreadyPatched(
  repoRoot: string,
  windowMs: number,
): Set<string> {
  const since = Math.ceil(windowMs / 1000);
  const out = new Set<string>();
  let log: string;
  try {
    log = execSync(
      `git log --since=${since}.seconds.ago --pretty=format:%B%x1e`,
      { cwd: repoRoot, encoding: 'utf-8', timeout: 30_000 },
    );
  } catch {
    return out;
  }
  const records = log.split('\x1e');
  for (const rec of records) {
    const m = rec.match(/^Fixes-Finding-Id:\s*([^\s]+)\s*$/m);
    if (m && m[1]) out.add(m[1]);
  }
  return out;
}
