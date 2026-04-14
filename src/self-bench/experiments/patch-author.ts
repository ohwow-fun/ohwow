/**
 * PatchAuthorExperiment — capstone application of Layers 1-9.
 *
 * Reads self_findings for warning|fail rows whose evidence.affected_files
 * intersect a tier-2 path, filters out findings already addressed by an
 * existing autonomous patch (commits carrying Fixes-Finding-Id: <id>),
 * and records the remaining candidates as a single ledger row per tick.
 *
 * Observe-only on first ship
 * --------------------------
 * intervene() does NOT call a model and does NOT call safeSelfCommit yet.
 * Every preceding layer (1-9) was built so that *when* this experiment
 * starts authoring patches, the unsafe outcomes are structurally
 * impossible. But before flipping that switch, the discovery half needs
 * a few cycles in production to confirm:
 *   1. The candidate stream is non-empty when expected and empty
 *      otherwise (no false positives from stale findings, no misses
 *      from path normalization bugs).
 *   2. The "already patched" filter actually filters — a patched-but-
 *      unhealed candidate must reappear here once the cool-off watcher
 *      reverts it, not vanish forever.
 *   3. The tier-2 surface is the intended one (currently:
 *      src/lib/format-duration.ts only).
 *
 * Once those hold, a follow-up commit wires the model call + Layer 8
 * provenance prompt + Layer 4 AST-bounded patch + Layer 2 trailer +
 * safeSelfCommit. Until then, this experiment's whole job is to
 * surface what *would* be patched so the operator can audit the
 * judgment before automation acts.
 */

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
import { getSelfCommitStatus } from '../self-commit.js';
import { getAllowedPrefixes, resolvePathTier } from '../path-trust-tiers.js';
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
  readonly cadence = { everyMs: 6 * HOUR, runOnBoot: false };

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
    _ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    if (verdict !== 'warning') return null;
    const ev = result.evidence as CandidatesEvidence;
    if (ev.candidates.length === 0) return null;
    // Observe-only. Record what we would do; do not call a model or
    // safeSelfCommit. The next layer wires both.
    for (const c of ev.candidates) {
      logger.info(
        {
          findingId: c.findingId,
          experimentId: c.experimentId,
          subject: c.subject,
          verdict: c.verdict,
          tier2Files: c.tier2Files,
        },
        '[patch-author] candidate identified (observe-only — no patch authored)',
      );
    }
    return {
      description: `surfaced ${ev.candidates.length} tier-2 patch candidate(s) (observe-only)`,
      details: { candidates: ev.candidates },
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

/** All currently-registered tier-2 prefixes (longest-prefix-match candidates). */
export function listTier2Prefixes(): string[] {
  return getAllowedPrefixes().filter(
    (prefix) => resolvePathTier(prefix).tier === 'tier-2',
  );
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
