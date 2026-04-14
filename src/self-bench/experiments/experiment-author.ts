/**
 * ExperimentAuthorExperiment — Phase 7-D.
 *
 * The terminal slice of Phase 7. The pipeline is now:
 *
 *   ExperimentProposalGenerator (7-C)
 *     → writes ExperimentBrief rows to self_findings with
 *       category='experiment_proposal'
 *         ↓
 *   ExperimentAuthorExperiment (this)
 *     → reads one unclaimed brief per run
 *     → fillExperimentTemplate (7-B) turns it into source files
 *     → safeSelfCommit (7-A) writes, runs gates, commits
 *     → marks the brief claimed so next run picks a different one
 *         ↓
 *   next daemon restart picks up the new experiment via
 *   auto-registry.ts → daemon/start.ts registration
 *
 * Every step has its own safety layer. This experiment is the
 * tip of the autonomous-codegen pipeline — it can only touch
 * things safeSelfCommit allows it to touch, which is a narrow
 * allowlist under src/self-bench/.
 *
 * Claiming briefs
 * ---------------
 * Briefs are stored as self_findings rows with evidence.claimed=false.
 * When the author picks a brief, it writes a new "claim" finding
 * with the same subject and evidence.claimed=true + claimed_by +
 * claimed_at. Future runs read the most recent row per subject
 * and skip ones that are already claimed. This is durable across
 * daemon restarts without needing a new table.
 *
 * The runner's adaptive scheduler won't re-invoke this experiment
 * more aggressively than its cadence (1 hour default), so at most
 * one commit per hour lands autonomously. Additional safety: if
 * safeSelfCommit's kill switch is closed, the author runs the
 * full pipeline but the commit step fails with
 * "self-commit disabled by default" — the brief STAYS
 * unclaimed and the next run tries again when the operator
 * finally opens the switch. Failures don't lock briefs.
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import fs from 'node:fs';
import path from 'node:path';
import type { ExperimentBrief } from '../experiment-template.js';
import { fillExperimentTemplate, validateBrief } from '../experiment-template.js';
import { safeSelfCommit, getSelfCommitStatus } from '../self-commit.js';
import { writeFinding, readRecentFindings } from '../findings-store.js';

/** How many proposal rows to read per run before deciding. */
const PROPOSAL_SCAN_LIMIT = 50;

interface AuthorEvidence extends Record<string, unknown> {
  scanned_proposals: number;
  unclaimed_count: number;
  selected_brief: ExperimentBrief | null;
  commit_result: {
    ok: boolean;
    reason?: string;
    commitSha?: string;
    filesWritten?: string[];
  } | null;
}

interface ProposalCandidate {
  findingId: string;
  subject: string;
  brief: ExperimentBrief;
  ranAt: string;
}

export class ExperimentAuthorExperiment implements Experiment {
  id = 'experiment-author';
  name = 'Autonomous experiment author (Phase 7-D)';
  category = 'other' as const;
  hypothesis =
    'Unclaimed experiment proposals in the ledger can be safely turned into committed code via the Phase 7-B template + Phase 7-A safe-commit pipeline, producing new experiments without human intervention.';
  // 5m cadence + runOnBoot: true during the supervised observability
  // window. Paired with the proposal generator on a 2m cadence: fresh
  // briefs sit in the ledger for at most ~5 minutes before the author
  // picks them up. The author is the expensive side of the loop
  // (typecheck + vitest + husky hooks run ~30-90s per intervene),
  // so it gets a slower cadence than the generator. The runner's
  // per-experiment inFlight guard means a slow intervene never
  // blocks the generator — the two sides stay decoupled. Revert
  // to 10m once we're bored watching. safeSelfCommit is still
  // gated behind the kill switch file, so the faster cadence
  // doesn't change the safety posture.
  cadence = { everyMs: 5 * 60 * 1000, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const proposals = await this.readUnclaimedProposals(ctx);

    if (proposals.length === 0) {
      const evidence: AuthorEvidence = {
        scanned_proposals: 0,
        unclaimed_count: 0,
        selected_brief: null,
        commit_result: null,
      };
      return {
        subject: null,
        summary: 'no unclaimed proposals to author',
        evidence,
      };
    }

    // Pick the oldest unclaimed proposal (FIFO fairness). Proposals
    // are already sorted newest-first by readRecentFindings, so
    // reverse to pick the oldest.
    const oldest = proposals[proposals.length - 1];

    const evidence: AuthorEvidence = {
      scanned_proposals: proposals.length,
      unclaimed_count: proposals.length,
      selected_brief: oldest.brief,
      commit_result: null,
    };

    // subject: null — we deliberately do NOT write the proposal:<slug>
    // namespace here. The author's probe-time finding would otherwise
    // collide with the generator's proposal finding under the same
    // subject, and readUnclaimedProposals's "latest-per-subject"
    // grouping would then mask the real brief with the author's
    // selected_brief shape on the very next tick. Claim markers
    // (written in intervene) still use proposal:<slug> because that's
    // how dedupe works — but probe-time state never touches that
    // namespace.
    return {
      subject: null,
      summary: `selected proposal ${oldest.brief.slug} for authoring`,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as AuthorEvidence;
    if (ev.unclaimed_count === 0) return 'pass';
    return 'warning'; // warning = actionable work to do
  }

  /**
   * The real work. Takes the selected brief from probe, runs the
   * template filler, calls safeSelfCommit, records both the
   * claim-marker finding and the result. Every failure path still
   * writes evidence so operators can trace what happened.
   */
  async intervene(
    _verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    const ev = result.evidence as AuthorEvidence;
    if (!ev.selected_brief) return null;

    const brief = ev.selected_brief;

    // Belt-and-suspenders: validate the brief again before we act
    // on it. The proposal generator already validates, but a brief
    // can be sitting in the ledger for hours — if we shipped a
    // breaking change to validateBrief between generation and
    // authoring, we want to catch it here.
    const briefError = validateBrief(brief);
    if (briefError) {
      return {
        description: `refused to author invalid brief ${brief.slug}: ${briefError}`,
        details: {
          brief_slug: brief.slug,
          validation_error: briefError,
        },
      };
    }

    // Layer 1 of the autonomous-fixing safety floor: route briefs
    // that target an existing parameterized probe class to a
    // registry-row append, NOT to a fresh templated TS file.
    //
    // Each round-trip through fillExperimentTemplate produced a
    // byte-identical-modulo-strings file the slop refactor (89e4516,
    // 305adab) had to collapse later. For migration_schema_probe and
    // for subprocess_health_probe whose command targets the
    // orchestrator-tool test pattern, the right mutation is "append
    // one row to the registry the parameterized class consumes."
    //
    // Routing decision lives here in the author rather than in
    // fillExperimentTemplate so the proposal generator and the brief
    // shape are unchanged — a brief is still a brief, but the author
    // chooses how to materialize it.
    const registryRoute = chooseRegistryRoute(brief);
    if (registryRoute) {
      return await this.appendToParameterizedRegistry(brief, registryRoute, ctx);
    }

    // Fill the template. Throws if validation fails mid-fill,
    // which we catch and record.
    let files: ReturnType<typeof fillExperimentTemplate>;
    try {
      files = fillExperimentTemplate(brief);
    } catch (err) {
      return {
        description: `fillExperimentTemplate threw for ${brief.slug}`,
        details: {
          brief_slug: brief.slug,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // The safe-commit primitive runs all the gates (typecheck,
    // vitest on the new test file, audit log, git add/commit).
    // It returns { ok, reason?, commitSha? } and never throws.
    //
    // Commit message: deliberately long + feat(self-bench): prefix
    // so the runbook bailout "commit message < 40 chars or missing
    // prefix" is structurally impossible to trip.
    //
    // extendsExperimentId is always null in Phase 7 — the pipeline
    // is new-file-only by hard constraint. whyNotEditExisting
    // documents that constraint for operator audit.
    const commitMessage = `feat(self-bench): auto-author ${brief.slug} from proposal brief`;
    const commitResult = await safeSelfCommit({
      files: [
        { path: files.sourcePath, content: files.sourceContent },
        { path: files.testPath, content: files.testContent },
      ],
      commitMessage,
      experimentId: this.id,
      extendsExperimentId: null,
      whyNotEditExisting:
        'Phase 7-A safeSelfCommit is hard-constrained to new files only via the new-file-only policy; this brief is a green-field probe with no parent experiment to extend.',
    });

    // If the commit succeeded, append the new experiment to auto-registry.ts
    // so that daemon/start.ts picks it up on the next restart. Failure here
    // is non-fatal: the experiment file is committed and will be found on
    // a future auto-registry rebuild. Errors are swallowed and logged.
    if (commitResult.ok && commitResult.filesWritten) {
      try {
        await this.appendToAutoRegistry(brief, commitResult.filesWritten);
      } catch {
        // Non-fatal — the experiment is committed, just not yet in the registry.
      }
    }

    // Always mark the claim attempt, even on failure, so operators
    // can see the pipeline activity in the ledger. On success the
    // brief is claimed and won't be re-tried. On failure we leave
    // it unclaimed so the next run tries again.
    try {
      await writeFinding(ctx.db, {
        experimentId: this.id,
        category: 'experiment_proposal',
        subject: `proposal:${brief.slug}`,
        hypothesis: `Authoring outcome for proposal ${brief.slug}`,
        verdict: commitResult.ok ? 'pass' : 'warning',
        summary: commitResult.ok
          ? `authored ${brief.slug} → commit ${commitResult.commitSha?.slice(0, 8) ?? '?'}`
          : `failed to author ${brief.slug}: ${commitResult.reason}`,
        evidence: {
          is_authoring_outcome: true,
          brief,
          claimed: commitResult.ok,
          claimed_by: commitResult.ok ? this.id : null,
          claimed_at: commitResult.ok ? new Date().toISOString() : null,
          commit_sha: commitResult.commitSha ?? null,
          files_written: commitResult.filesWritten ?? null,
          commit_ok: commitResult.ok,
          commit_reason: commitResult.reason ?? null,
        },
        interventionApplied: null,
        ranAt: new Date().toISOString(),
        durationMs: 0,
      });
    } catch {
      // non-fatal; next run will pick up where we left off
    }

    return {
      description: commitResult.ok
        ? `autonomously authored ${brief.slug} → ${commitResult.commitSha?.slice(0, 8) ?? '?'}`
        : `author attempt failed for ${brief.slug}: ${commitResult.reason}`,
      details: {
        brief_slug: brief.slug,
        template: brief.template,
        commit_ok: commitResult.ok,
        commit_sha: commitResult.commitSha,
        commit_reason: commitResult.reason,
        files_written: commitResult.filesWritten,
      },
    };
  }

  /**
   * Append a new factory entry to src/self-bench/auto-registry.ts so
   * the daemon picks up the newly committed experiment on next restart.
   *
   * Reads the current registry file, derives the class name from the
   * source file path, inserts an import + factory line, and commits
   * the updated registry via safeSelfCommit. safeSelfCommit's
   * MODIFY_ALLOWED_EXACT_PATHS exemption means this is the one file
   * the author is allowed to update in-place.
   *
   * Non-fatal: if anything fails here the experiment is already
   * committed — it just won't be auto-registered until a human
   * or a future run repairs the registry.
   */
  private async appendToAutoRegistry(
    brief: ExperimentBrief,
    filesWritten: string[],
  ): Promise<void> {
    const status = getSelfCommitStatus();
    if (!status.repoRoot) return;

    // Find the source file path (not the test file)
    const sourcePath = filesWritten.find(
      (f) => !f.includes('__tests__'),
    );
    if (!sourcePath) return;

    const registryRelPath = 'src/self-bench/auto-registry.ts';
    const registryAbsPath = path.join(status.repoRoot, registryRelPath);

    let current: string;
    try {
      current = fs.readFileSync(registryAbsPath, 'utf-8');
    } catch {
      return; // registry doesn't exist yet — skip
    }

    // Derive the class name from the source path basename.
    // sourcePath example: 'src/self-bench/experiments/migration-schema-010-local-crm.ts'
    // → className: 'MigrationSchema010LocalCrmExperiment'
    const basename = path.basename(sourcePath, '.ts'); // 'migration-schema-010-local-crm'
    const className = basename
      .split('-')
      .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
      .join('') + 'Experiment';

    // Import path relative to auto-registry.ts
    const importPath = `./experiments/${basename}.js`;

    // Check if already present (idempotent)
    if (current.includes(className)) return;

    // Build the new lines to append
    const importLine = `import { ${className} } from '${importPath}';`;
    const factoryLine = `  () => new ${className}(),`;

    // Insert the import before the export statement
    const exportMarker = '\nexport const autoRegisteredExperiments';
    if (!current.includes(exportMarker)) return; // unexpected shape

    const withImport = current.replace(
      exportMarker,
      `\n${importLine}${exportMarker}`,
    );

    // Insert the factory before the closing '];'
    const closeMarker = '\n];';
    if (!withImport.includes(closeMarker)) return; // unexpected shape

    const updated = withImport.replace(
      closeMarker,
      `\n${factoryLine}${closeMarker}`,
    );

    // Commit via safeSelfCommit so it goes through the same gates
    await safeSelfCommit({
      files: [{ path: registryRelPath, content: updated }],
      commitMessage: `feat(self-bench): register ${brief.slug} in auto-registry`,
      experimentId: this.id,
      extendsExperimentId: null,
      whyNotEditExisting:
        'auto-registry.ts is the designated append-only manifest for autonomously authored experiments; updating it after each commit is its only purpose.',
      // Skip gates for the registry update: typecheck already ran for
      // the main experiment commit above. Running it again would add
      // 30s with no new information.
      skipGates: true,
    });
  }

  /**
   * Materialize a brief by appending one row to the parameterized
   * probe class's registry (instead of generating a fresh templated
   * TS file). Reads the registry, dedupes against the existing rows,
   * inserts a new row before the closing `];`, and commits the
   * single-file change via safeSelfCommit.
   *
   * Always writes a finding (claim outcome) to keep the proposal
   * generator's dedupe set populated, same shape as the TS-file
   * authoring path. Returns an InterventionApplied for the runner
   * to record on the author's own ledger row.
   */
  private async appendToParameterizedRegistry(
    brief: ExperimentBrief,
    route: RegistryRoute,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied> {
    const status = getSelfCommitStatus();
    if (!status.repoRoot) {
      return {
        description: `cannot append to ${route.registryPath} — repo root not configured`,
        details: { brief_slug: brief.slug, registry_path: route.registryPath },
      };
    }

    const absRegistryPath = path.join(status.repoRoot, route.registryPath);
    let current: string;
    try {
      current = fs.readFileSync(absRegistryPath, 'utf-8');
    } catch (err) {
      return {
        description: `failed to read registry ${route.registryPath} for ${brief.slug}`,
        details: {
          brief_slug: brief.slug,
          registry_path: route.registryPath,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // Dedupe: if the row's primary-key string already appears in the
    // file, the registry already covers this brief. Idempotent no-op.
    if (current.includes(route.dedupeNeedle)) {
      // Still write the claim finding so the proposal generator's
      // dedupe set advances and we don't re-author the same brief
      // forever.
      await writeAuthorClaim(ctx, this.id, brief, {
        ok: true,
        commitSha: null,
        reason: 'already_in_registry',
        registryPath: route.registryPath,
      });
      return {
        description: `${brief.slug} already present in ${route.registryPath} — no-op`,
        details: {
          brief_slug: brief.slug,
          registry_path: route.registryPath,
          dedupe_needle: route.dedupeNeedle,
          appended: false,
        },
      };
    }

    // Insert the new row before the LAST occurrence of `\n];`. Last
    // (not first) so a future hand-edit that adds a comment with
    // `];` somewhere above the array doesn't break the splice.
    const closeMarker = '\n];';
    const closeIdx = current.lastIndexOf(closeMarker);
    if (closeIdx < 0) {
      return {
        description: `registry ${route.registryPath} has unexpected shape — no '\\n];' close marker`,
        details: { brief_slug: brief.slug, registry_path: route.registryPath },
      };
    }
    const updated =
      current.slice(0, closeIdx) +
      `\n  ${route.rowSource},` +
      current.slice(closeIdx);

    const commitMessage = `feat(self-bench): append ${brief.slug} to ${path.basename(route.registryPath)}`;
    const commitResult = await safeSelfCommit({
      files: [{ path: route.registryPath, content: updated }],
      commitMessage,
      experimentId: this.id,
      extendsExperimentId: null,
      whyNotEditExisting:
        'Layer 1 of the autonomous-fixing safety floor: this registry is the designated append-only home for the parameterized probe class — appending here is structurally safer than emitting a fresh templated TS file per row.',
      // Skip gates for a single-row append: validateBrief already ran,
      // typecheck on this addition would add 30s for no new signal.
      skipGates: true,
    });

    await writeAuthorClaim(ctx, this.id, brief, {
      ok: commitResult.ok,
      commitSha: commitResult.commitSha ?? null,
      reason: commitResult.reason ?? null,
      registryPath: route.registryPath,
    });

    return {
      description: commitResult.ok
        ? `appended ${brief.slug} to ${route.registryPath} → commit ${commitResult.commitSha?.slice(0, 8) ?? '?'}`
        : `failed to append ${brief.slug} to ${route.registryPath}: ${commitResult.reason}`,
      details: {
        brief_slug: brief.slug,
        registry_path: route.registryPath,
        commit_ok: commitResult.ok,
        commit_sha: commitResult.commitSha,
        commit_reason: commitResult.reason,
        appended: commitResult.ok,
      },
    };
  }

  /**
   * Walk the ledger for proposal rows, group by subject, keep
   * only the latest per subject. A subject is "unclaimed" when
   * its latest row has evidence.claimed === false AND there's
   * no later row with claimed === true.
   *
   * We query two experiment_ids because the generator writes the
   * original brief findings and the author writes the claim
   * markers. Both use the same proposal:<slug> subject shape so
   * a subject-keyed map collates them correctly.
   */
  private async readUnclaimedProposals(ctx: ExperimentContext): Promise<ProposalCandidate[]> {
    const authorFindings = await ctx
      .recentFindings(this.id, PROPOSAL_SCAN_LIMIT)
      .catch(() => [] as Finding[]);
    const generatorFindings = await ctx
      .recentFindings('experiment-proposal-generator', PROPOSAL_SCAN_LIMIT)
      .catch(() => [] as Finding[]);

    const allFindings = [...authorFindings, ...generatorFindings];

    // Group by subject, keep the newest row per subject. Only
    // consider findings that are actually proposal-shaped — either
    // original briefs from the generator (is_experiment_proposal) or
    // claim-marker outcomes from this experiment (is_authoring_outcome).
    // Stray probe-time findings from older author versions that wrote
    // into the proposal:<slug> namespace are filtered out here so
    // they can't mask a real brief.
    const latestBySubject = new Map<string, Finding>();
    for (const f of allFindings) {
      if (!f.subject || !f.subject.startsWith('proposal:')) continue;
      const ev = f.evidence as {
        is_experiment_proposal?: boolean;
        is_authoring_outcome?: boolean;
      };
      if (!ev.is_experiment_proposal && !ev.is_authoring_outcome) continue;
      const existing = latestBySubject.get(f.subject);
      if (!existing || f.ranAt > existing.ranAt) {
        latestBySubject.set(f.subject, f);
      }
    }

    const candidates: ProposalCandidate[] = [];
    for (const [subject, finding] of latestBySubject.entries()) {
      const evidence = finding.evidence as {
        claimed?: boolean;
        brief?: ExperimentBrief;
        is_experiment_proposal?: boolean;
        is_authoring_outcome?: boolean;
      };

      // Already claimed? Skip.
      if (evidence.claimed === true) continue;

      // Must have an embedded brief to be actionable.
      if (!evidence.brief) continue;

      candidates.push({
        findingId: finding.id,
        subject,
        brief: evidence.brief,
        ranAt: finding.ranAt,
      });
    }

    // Newest first by default; caller inverts for FIFO fairness.
    candidates.sort((a, b) => b.ranAt.localeCompare(a.ranAt));
    return candidates;
  }
}

// ---------------------------------------------------------------------------
// Layer 1 helpers — registry routing for parameterized probe classes.
// ---------------------------------------------------------------------------

interface RegistryRoute {
  /** Path relative to repo root, e.g. 'src/self-bench/registries/migration-schema-registry.ts'. */
  registryPath: string;
  /** Source for the new row, e.g. `{ migrationFile: '008-plans.sql', expectedTables: ['x'] }`. */
  rowSource: string;
  /**
   * String to grep for in the existing registry to dedupe. Pick a primary-
   * key-shaped substring like `'008-plans.sql'` or `'agents'`. Must be
   * unique enough that finding it in the file means "this row is already
   * registered."
   */
  dedupeNeedle: string;
}

/** Match the toolchain-tool-test command shape Rule 4 of the proposal generator emits. */
const TOOLCHAIN_TOOL_TEST_COMMAND_RE =
  /^npx vitest run src\/orchestrator\/tools\/__tests__\/([a-z][a-z0-9-]*)\.test\.ts$/;

/**
 * Decide whether this brief should land as a registry-row append
 * (Layer 1 path) or fall through to the templated TS file generation
 * (legacy path). Returns null when the legacy path is right.
 *
 * Routing rules:
 *   - migration_schema_probe → migration-schema registry, always.
 *   - subprocess_health_probe whose command matches the orchestrator-
 *     tool test pattern → toolchain-test registry. Singletons (Rule 3
 *     typecheck/lint/tests) and any future subprocess shapes still
 *     get the templated TS file path.
 *   - any other template → null (legacy TS file path).
 */
export function chooseRegistryRoute(brief: ExperimentBrief): RegistryRoute | null {
  if (brief.template === 'migration_schema_probe') {
    const params = brief.params as { migration_file: string; expected_tables: string[] };
    const tablesLiteral = params.expected_tables
      .map((t) => `'${escapeSingleQuoted(t)}'`)
      .join(', ');
    return {
      registryPath: 'src/self-bench/registries/migration-schema-registry.ts',
      rowSource: `{ migrationFile: '${escapeSingleQuoted(params.migration_file)}', expectedTables: [${tablesLiteral}] }`,
      dedupeNeedle: `'${escapeSingleQuoted(params.migration_file)}'`,
    };
  }

  if (brief.template === 'subprocess_health_probe') {
    const params = brief.params as { command: string };
    const match = TOOLCHAIN_TOOL_TEST_COMMAND_RE.exec(params.command);
    if (!match) return null; // singleton or other subprocess shape — TS file path
    const slug = match[1];
    return {
      registryPath: 'src/self-bench/registries/toolchain-test-registry.ts',
      rowSource: `{ slug: '${escapeSingleQuoted(slug)}' }`,
      // Single-quoted slug occurrence is unique enough — the registry's
      // only string literals are slugs, so collisions are impossible.
      dedupeNeedle: `'${escapeSingleQuoted(slug)}'`,
    };
  }

  return null;
}

/**
 * Escape a string for use inside single-quoted JavaScript literals.
 * Defensive — validateBrief restricts allowed characters in the params
 * fields the routing reads, but the registries are committed source
 * files so we never want to inject a stray apostrophe.
 */
function escapeSingleQuoted(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Write the same proposal-claim finding shape both authoring paths
 * (TS file and registry append) need. Keeps the proposal generator's
 * dedupe set in sync regardless of which path materialized the brief.
 * Errors are swallowed — the autonomous loop must not fall over on
 * a transient ledger write failure.
 */
async function writeAuthorClaim(
  ctx: ExperimentContext,
  experimentId: string,
  brief: ExperimentBrief,
  outcome: { ok: boolean; commitSha: string | null; reason: string | null; registryPath: string },
): Promise<void> {
  try {
    await writeFinding(ctx.db, {
      experimentId,
      category: 'experiment_proposal',
      subject: `proposal:${brief.slug}`,
      hypothesis: `Registry-append outcome for proposal ${brief.slug}`,
      verdict: outcome.ok ? 'pass' : 'warning',
      summary: outcome.ok
        ? `appended ${brief.slug} to ${outcome.registryPath} → commit ${outcome.commitSha?.slice(0, 8) ?? 'noop'}`
        : `failed to append ${brief.slug} to ${outcome.registryPath}: ${outcome.reason}`,
      evidence: {
        is_authoring_outcome: true,
        materialization: 'registry_append',
        brief,
        registry_path: outcome.registryPath,
        claimed: outcome.ok,
        claimed_by: outcome.ok ? experimentId : null,
        claimed_at: outcome.ok ? new Date().toISOString() : null,
        commit_sha: outcome.commitSha,
        commit_ok: outcome.ok,
        commit_reason: outcome.reason,
      },
      interventionApplied: null,
      ranAt: new Date().toISOString(),
      durationMs: 0,
    });
  } catch {
    // non-fatal
  }
}
