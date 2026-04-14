/**
 * ExperimentProposalGenerator — Phase 7-C.
 *
 * The question-generating layer, upstream of the code writer.
 * Every run it reads the ledger + live system state and asks
 * "what's unexplained?", producing experiment briefs as findings
 * with category='experiment_proposal'. Each brief is a structured
 * JSON payload describing a new experiment's slug, template,
 * cadence, and template-specific parameters — exactly the shape
 * fillExperimentTemplate (Phase 7-B) consumes.
 *
 * The proposal generator is narrow on purpose and grows one rule
 * at a time. Today it runs two:
 *
 *   Rule 1 (model_latency_probe proposal):
 *     For each model_id in llm_calls that has at least MIN_SAMPLES
 *     recent calls AND no existing experiment with
 *     slug=`model-latency-<sanitized-id>` (checked via existing
 *     findings with that subject), propose a new latency probe
 *     targeted at that model. Thresholds are derived from the
 *     observed latency distribution — warn at p90, fail at p99 —
 *     so the generated experiment's alert shape matches the
 *     baseline at generation time.
 *
 *   Rule 2 (migration_schema_probe proposal):
 *     Code-reading rule. Scans src/db/migrations/*.sql at runtime,
 *     regex-extracts every `CREATE TABLE [IF NOT EXISTS] <name>`
 *     statement, and proposes one schema-drift canary per migration
 *     file whose slug hasn't been seen in the dedupe window. The
 *     generated probes are read-only — a single SELECT on
 *     sqlite_master — so they're safe to run frequently. Bounded
 *     per tick by MAX_MIGRATION_PROPOSALS_PER_TICK so the author
 *     side doesn't get a 120-brief backlog on a fresh DB.
 *
 * Future rules could cover: per-tool reliability probes,
 * per-trigger-type coverage probes, per-agent-config health probes,
 * per-provider cost probes. Each additional rule is another pass
 * through probe() that adds to the proposals list.
 *
 * Why this is a separate experiment from the author
 * -------------------------------------------------
 * Separation of concerns. The generator's job is to produce
 * well-structured briefs. The author's job (Phase 7-D) is to
 * turn briefs into code and commit. Keeping them apart means:
 *   - The generator can be tested without involving git at all
 *   - Operators can inspect briefs in the ledger before the
 *     author picks them up
 *   - A kill switch on 7-D (safeSelfCommit disabled) leaves 7-C
 *     still producing briefs that an operator can choose to
 *     hand-implement
 *   - Future LLM-backed generators can swap in without touching
 *     the author side
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  Experiment,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import type {
  ExperimentBrief,
  MigrationSchemaProbeParams,
  ModelLatencyProbeParams,
} from '../experiment-template.js';
import { validateBrief } from '../experiment-template.js';
import { writeFinding } from '../findings-store.js';
import { getSelfCommitStatus } from '../self-commit.js';

/** How many recent llm_calls rows to inspect per model for latency stats. */
const SAMPLE_WINDOW = 200;
/**
 * Minimum calls a model needs before it's eligible for a proposal.
 * Lowered from 20 → 5 for the supervised observation loop: on the
 * current daemon's traffic shape (~5 distinct models, most with <20
 * samples in a week), a 20-sample floor starved the pipeline of
 * new proposals. 5 samples is enough to establish rough p50/p90/p99
 * for threshold derivation; if the resulting experiment produces
 * noisy findings, the adaptive scheduler will stretch its cadence.
 */
const MIN_CALLS_FOR_PROPOSAL = 5;
/** How far back to look for existing proposals to avoid duplicates. */
const DEDUPE_WINDOW_DAYS = 14;

/**
 * Rule 2 throttle: never emit more than N brand-new migration
 * proposals in a single tick. The repo has ~120 migration files,
 * so on the first run after this rule ships every slug would be
 * "new" and the author (5m cadence) would fall hours behind. We
 * fan the work out across ticks — dedupe catches the already-
 * emitted briefs, and the next tick picks up where this one
 * stopped.
 */
const MAX_MIGRATION_PROPOSALS_PER_TICK = 3;
/** Default cadence baked into the generated schema probes. */
const MIGRATION_PROBE_EVERY_MS = 60 * 60 * 1000; // 1h
/** Hard cap on expected_tables per brief — mirrors validateBrief. */
const MIGRATION_MAX_TABLES_PER_PROBE = 50;
/** Slug length ceiling (validateBrief enforces the same value). */
const SLUG_MAX_LENGTH = 50;

interface LlmCallRow {
  model: string;
  latency_ms: number;
  created_at: string;
}

interface ProposalGeneratorEvidence extends Record<string, unknown> {
  inspected_models: number;
  existing_proposals: number;
  new_proposals: number;
  skipped_due_to_low_samples: number;
  migrations_scanned: number;
  migration_files_with_tables: number;
  new_migration_proposals: number;
  migration_repo_root_unavailable: boolean;
  proposals: ExperimentBrief[];
}

/**
 * Turn a model id like "qwen/qwen3.5-35b-a3b" into a slug-safe
 * fragment: "qwen-qwen3-5-35b-a3b-latency".
 */
function modelToSlug(modelId: string): string {
  const cleaned = modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${cleaned}-latency`;
}

/**
 * Turn a migration basename like "016-dashboard-tables.sql" into
 * "migration-schema-016-dashboard-tables". Strips the .sql suffix,
 * lowercases, and sanitizes — leading digits are fine because the
 * full slug is prefixed with "migration-schema-" (which starts
 * with a letter as required by validateBrief).
 */
function migrationFileToSlug(basename: string): string {
  const noExt = basename.replace(/\.sql$/i, '');
  const cleaned = noExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `migration-schema-${cleaned}`;
}

/**
 * Regex-extract every `CREATE TABLE [IF NOT EXISTS] <name>`
 * statement from a .sql file's contents. Case-insensitive, tolerates
 * whitespace variation, dedupes within one file, and preserves the
 * order of first appearance so the emitted brief is deterministic
 * across runs. Quoted/bracketed identifiers are NOT unwrapped —
 * if a migration uses `"foo"` or `[foo]` this parser skips them.
 * That's fine: the goal is coverage of the common case, not a
 * full SQL parser.
 */
function parseCreateTables(sqlContent: string): string[] {
  const ident = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  const seen = new Set<string>();
  const result: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = ident.exec(sqlContent)) !== null) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

/** Percentile of a sorted ascending array. Linear interpolation, clamped. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor((p / 100) * sortedAsc.length)),
  );
  return sortedAsc[idx];
}

export class ExperimentProposalGenerator implements Experiment {
  id = 'experiment-proposal-generator';
  name = 'Experiment proposal generator (Phase 7-C)';
  category = 'other' as const;
  hypothesis =
    'Every model that appears in llm_calls with meaningful traffic should have a dedicated latency probe in the self-bench ledger. Models without one are candidates for auto-generation.';
  // 2m cadence + runOnBoot: true during the supervised observability
  // window. The generator is read-only — probe + intervene just scan
  // llm_calls and dedupe against the ledger, no git mutation, no LLM,
  // no cost — so it's safe to run frequently. Paired with the
  // experiment-author on a 5m cadence: every generator tick can
  // surface a new model, and the author picks them up within a few
  // minutes rather than hours. Revert to 10m once we're bored
  // watching the self-improvement loop live.
  cadence = { everyMs: 2 * 60 * 1000, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    // 1. Pull recent llm_calls grouped by model. One broader query,
    //    bucket in memory.
    const since = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { data: callsData } = await ctx.db
      .from<LlmCallRow>('llm_calls')
      .select('model, latency_ms, created_at')
      .gte('created_at', since)
      .limit(5000);

    const calls = (callsData ?? []) as LlmCallRow[];
    const byModel = new Map<string, number[]>();
    for (const call of calls) {
      if (typeof call.latency_ms !== 'number' || call.latency_ms < 0) continue;
      const bucket = byModel.get(call.model) ?? [];
      bucket.push(call.latency_ms);
      if (bucket.length <= SAMPLE_WINDOW) byModel.set(call.model, bucket);
    }

    // 2. Read prior proposals — both active ones and ones that
    //    have already been authored. Dedupe by brief.slug so we
    //    don't re-propose the same model every hour.
    const existingProposals = await this.readExistingProposalSlugs(ctx);

    const proposals: ExperimentBrief[] = [];
    let skippedLowSamples = 0;

    for (const [model, latencies] of byModel.entries()) {
      if (latencies.length < MIN_CALLS_FOR_PROPOSAL) {
        skippedLowSamples += 1;
        continue;
      }
      const slug = modelToSlug(model);
      if (existingProposals.has(slug)) continue;

      // Derive warn/fail thresholds from the observed distribution.
      const sorted = [...latencies].sort((a, b) => a - b);
      const p50 = percentile(sorted, 50);
      const p90 = percentile(sorted, 90);
      const p99 = percentile(sorted, 99);

      // Guard against degenerate p90 == p50. Give the warn threshold
      // a 20% headroom above p50 if the distribution is tight.
      const warnMs = Math.max(p90, Math.round(p50 * 1.2));
      // fail must be strictly greater than warn — clamp to at least
      // warn+500ms so a very flat distribution still gets a
      // meaningful ceiling.
      const failMs = Math.max(p99, warnMs + 500);

      // sample_size is the rolling window the generated experiment
      // will probe at runtime. min_samples is the floor below which
      // the experiment returns 'warning' instead of a verdict.
      // Clamp min_samples to sample_size so the brief is structurally
      // valid even for low-traffic models — validateBrief requires
      // min_samples <= sample_size, and hardcoding min_samples=10
      // broke that invariant when we lowered MIN_CALLS_FOR_PROPOSAL.
      const sampleSize = Math.min(50, latencies.length);
      const minSamples = Math.min(10, sampleSize);

      const brief: ExperimentBrief = {
        slug,
        name: `Latency probe: ${model}`,
        hypothesis: `${model} p50 latency stays below ${warnMs}ms on the rolling ${SAMPLE_WINDOW}-call window.`,
        everyMs: 30 * 60 * 1000, // 30m default cadence
        template: 'model_latency_probe',
        params: {
          model_id: model,
          sample_size: sampleSize,
          warn_latency_ms: warnMs,
          fail_latency_ms: failMs,
          min_samples: minSamples,
        } satisfies ModelLatencyProbeParams,
      };
      proposals.push(brief);
    }

    // 3. Rule 2 — migration schema probes. Code-reading rule:
    //    scan src/db/migrations/*.sql, extract CREATE TABLE names,
    //    emit one brief per migration file (newest first), capped
    //    per tick. Dedupe is handled by the same slug-collision
    //    mechanism Rule 1 uses.
    const migrationSummary = this.proposeMigrationSchemaProbes(
      proposals,
      existingProposals,
    );

    const evidence: ProposalGeneratorEvidence = {
      inspected_models: byModel.size,
      existing_proposals: existingProposals.size,
      new_proposals: proposals.length,
      skipped_due_to_low_samples: skippedLowSamples,
      migrations_scanned: migrationSummary.migrations_scanned,
      migration_files_with_tables: migrationSummary.migration_files_with_tables,
      new_migration_proposals: migrationSummary.new_migration_proposals,
      migration_repo_root_unavailable: migrationSummary.repo_root_unavailable,
      proposals,
    };

    const summary =
      byModel.size === 0 && migrationSummary.migrations_scanned === 0
        ? 'no llm_calls rows and no migrations readable — nothing to propose'
        : proposals.length === 0
          ? `inspected ${byModel.size} model(s) + ${migrationSummary.migrations_scanned} migration(s), nothing new to propose (${existingProposals.size} already covered)`
          : `inspected ${byModel.size} model(s) + ${migrationSummary.migrations_scanned} migration(s), generated ${proposals.length} new proposal(s) (${migrationSummary.new_migration_proposals} migration)`;

    return {
      subject: null,
      summary,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ProposalGeneratorEvidence;
    // Rule 1 and Rule 2 are both signal sources. If BOTH are
    // silent (no models AND no migrations readable), the generator
    // can't do its job — warning. Otherwise any proposals landing
    // in the ledger are work queue entries, not problems, so pass.
    if (ev.inspected_models === 0 && ev.migrations_scanned === 0) {
      return 'warning';
    }
    return 'pass';
  }

  /**
   * Writes each new brief as its own self_findings row with
   * category='experiment_proposal' + subject=`proposal:<slug>`.
   * The author experiment (Phase 7-D) polls these rows to pick up
   * work. Briefs are stored as JSON in the evidence column so the
   * ledger stays queryable and the author can deserialize cleanly.
   */
  async intervene(
    _verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    const ev = result.evidence as ProposalGeneratorEvidence;
    if (ev.proposals.length === 0) return null;

    const proposalFindingIds: string[] = [];
    for (const brief of ev.proposals) {
      try {
        const id = await writeFinding(ctx.db, {
          experimentId: this.id,
          category: 'experiment_proposal',
          subject: `proposal:${brief.slug}`,
          hypothesis: `Proposed new experiment: ${brief.name}`,
          verdict: 'warning',
          summary: `new proposal: ${brief.slug} (${brief.template})`,
          evidence: {
            is_experiment_proposal: true,
            brief,
            claimed: false,
          },
          interventionApplied: null,
          ranAt: new Date().toISOString(),
          durationMs: 0,
        });
        proposalFindingIds.push(id);
      } catch {
        // Best effort; next run will pick up anything we missed.
      }
    }

    if (proposalFindingIds.length === 0) return null;

    return {
      description: `wrote ${proposalFindingIds.length} experiment proposal(s) to ledger`,
      details: {
        proposal_finding_ids: proposalFindingIds,
        proposal_count: proposalFindingIds.length,
        slugs: ev.proposals.map((p) => p.slug),
      },
    };
  }

  /**
   * Read every existing proposal slug from the last
   * DEDUPE_WINDOW_DAYS so we don't re-propose something we (or a
   * previous author run) already handled. A slug collision is the
   * dedupe key — once the author commits an experiment, it stops
   * being a "new model" because the llm_calls query still sees its
   * traffic but the proposal dedupe catches the match.
   */
  private async readExistingProposalSlugs(
    ctx: ExperimentContext,
  ): Promise<Set<string>> {
    const since = new Date(
      Date.now() - DEDUPE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    try {
      const { data } = await ctx.db
        .from<{ subject: string; ran_at: string }>('self_findings')
        .select('subject, ran_at')
        .eq('category', 'experiment_proposal')
        .gte('ran_at', since)
        .limit(500);
      const rows = (data ?? []) as Array<{ subject: string | null }>;
      const set = new Set<string>();
      for (const row of rows) {
        if (row.subject && row.subject.startsWith('proposal:')) {
          set.add(row.subject.slice('proposal:'.length));
        }
      }
      return set;
    } catch {
      return new Set();
    }
  }

  /**
   * Rule 2 — scan src/db/migrations/*.sql and emit briefs.
   * Mutates the passed-in `proposals` array (appending new briefs)
   * and returns a small summary struct for the evidence field. Runs
   * synchronously because it's just fs + regex — no async work to
   * do. Fails closed: any unreadable path, missing repo root, or
   * parse error results in zero new proposals and a flagged
   * evidence field, never a thrown exception that would take down
   * the Rule 1 pass.
   *
   * Dedupe reuses the same `existingProposals` set that Rule 1
   * uses — slug collisions are the only dedupe key — so a
   * migration brief that's already in the ledger is silently
   * skipped here on the next tick.
   */
  private proposeMigrationSchemaProbes(
    proposals: ExperimentBrief[],
    existingProposals: Set<string>,
  ): {
    migrations_scanned: number;
    migration_files_with_tables: number;
    new_migration_proposals: number;
    repo_root_unavailable: boolean;
  } {
    const status = getSelfCommitStatus();
    if (!status.repoRoot) {
      return {
        migrations_scanned: 0,
        migration_files_with_tables: 0,
        new_migration_proposals: 0,
        repo_root_unavailable: true,
      };
    }

    const migrationsDir = path.join(status.repoRoot, 'src', 'db', 'migrations');
    let entries: string[];
    try {
      entries = fs.readdirSync(migrationsDir);
    } catch {
      return {
        migrations_scanned: 0,
        migration_files_with_tables: 0,
        new_migration_proposals: 0,
        repo_root_unavailable: true,
      };
    }

    // Newest-first so the per-tick cap emits recent migrations
    // before legacy ones. Migration files are numerically prefixed
    // (001-, 002-, ...); a lexical descending sort is the right
    // order because the prefixes are zero-padded.
    const sqlFiles = entries
      .filter((name) => name.endsWith('.sql'))
      .sort((a, b) => b.localeCompare(a));

    let filesWithTables = 0;
    let newCount = 0;

    for (const basename of sqlFiles) {
      if (newCount >= MAX_MIGRATION_PROPOSALS_PER_TICK) break;

      const slug = migrationFileToSlug(basename);
      if (slug.length > SLUG_MAX_LENGTH) continue; // validateBrief would reject anyway
      if (existingProposals.has(slug)) continue;

      let tables: string[];
      try {
        const contents = fs.readFileSync(
          path.join(migrationsDir, basename),
          'utf-8',
        );
        tables = parseCreateTables(contents);
      } catch {
        continue;
      }

      if (tables.length === 0) continue;
      filesWithTables += 1;

      // Hard cap at MIGRATION_MAX_TABLES_PER_PROBE — a single
      // migration should never create 50+ tables, but if one does
      // we truncate the list and log that fact via evidence. The
      // probe will still be useful for the first N tables.
      const expectedTables = tables.slice(0, MIGRATION_MAX_TABLES_PER_PROBE);

      const brief: ExperimentBrief = {
        slug,
        name: `Migration schema probe: ${basename}`,
        hypothesis: `All tables created in ${basename} remain present in the live sqlite schema.`,
        everyMs: MIGRATION_PROBE_EVERY_MS,
        template: 'migration_schema_probe',
        params: {
          migration_file: basename,
          expected_tables: expectedTables,
        } satisfies MigrationSchemaProbeParams,
      };

      // Validate before pushing. If validation fails for any
      // reason (e.g. a migration file we mis-parse), skip silently
      // rather than letting the generator emit a brief the author
      // will refuse 30 seconds later.
      if (validateBrief(brief) !== null) continue;

      proposals.push(brief);
      existingProposals.add(slug); // prevent same-tick duplicates
      newCount += 1;
    }

    return {
      migrations_scanned: sqlFiles.length,
      migration_files_with_tables: filesWithTables,
      new_migration_proposals: newCount,
      repo_root_unavailable: false,
    };
  }
}
