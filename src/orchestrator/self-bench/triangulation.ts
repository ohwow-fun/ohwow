/**
 * Triangulation Harness — ground-truth-free self-bench
 *
 * The M0.21 moonshot demonstrated the closed-loop self-improvement
 * pattern but cheated on the trigger: a human passed ground-truth
 * answers in the prompt and the model just compared. In a production
 * cron loop there is no human oracle. The right trigger is
 * SELF-DISAGREEMENT: the same proprioception question is computed via
 * two (or more) independent query paths, and a mismatch fires
 * investigation. Pass = both paths return the same value; failure =
 * disagreement, automatically delegated to a sub-orchestrator with
 * focus='investigate'.
 *
 * This file defines the harness shape and the initial check set
 * covering the same surface area as the M0.21 questions, plus the
 * specific deliverables_since_24h check that surfaced the timestamp
 * format drift. The harness is consumed by:
 *   - integration tests under self-bench/__tests__/
 *   - a scripted nightly bench (M0.23 follow-up) that drives it
 *     against the live workspace via a single chat dispatch
 *
 * Critical: triangulation does NOT replace human review. It catches
 * cases where one query path is wrong but happens to look plausible
 * in isolation (e.g. list_tasks collapsing pending+approved into
 * completed, or list_deliverables silently dropping rows because of a
 * timestamp format mismatch). It does NOT catch cases where BOTH
 * paths share the same bug. Adding a third resolver is the way to
 * harden a check that's been bitten by a shared-bug scenario.
 */

import type { LocalToolContext } from '../local-tool-types.js';
import { logger } from '../../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * A single triangulation check: one proprioception question with N
 * independent ways to answer it.
 */
export interface TriangulationCheck {
  /** Stable id used to namespace persisted state. Lowercase, snake_case. */
  id: string;
  /** Human-readable description of the question. */
  description: string;
  /**
   * Two or more independent resolvers. The harness runs every
   * resolver and reports the values; a check passes iff all values
   * are equal under `compare`.
   */
  resolvers: TriangulationResolver[];
  /**
   * Equality comparator. Defaults to deep-equal via JSON.stringify.
   * Override when the values are loose-shaped (e.g. set comparison,
   * tolerance for off-by-one timing artifacts).
   */
  compare?: (values: unknown[]) => boolean;
}

export interface TriangulationResolver {
  /** Short name surfaced in disagreement reports and logs. */
  name: string;
  /** The actual query path. Returns whatever shape the check expects. */
  run: (ctx: TriangulationCtx) => Promise<unknown>;
}

/**
 * Minimal context the harness threads into resolvers. Exposes the
 * underlying LocalToolContext (db, workspaceId, etc.) plus a small
 * set of convenience helpers most resolvers need so they don't all
 * have to re-implement the same shell-out / JSON-parse boilerplate.
 */
export interface TriangulationCtx {
  toolCtx: LocalToolContext;
  /** Run a single read-only sqlite query against the runtime db and return the rows. */
  sqlite: (query: string) => Promise<unknown[]>;
  /** Read a JSON file (e.g. ~/.ohwow/config.json) and parse it. Throws on parse failure. */
  readJsonFile: (path: string) => Promise<Record<string, unknown>>;
  /** Workspace id for SQL filters. */
  workspaceId: string;
}

export interface TriangulationResolverResult {
  name: string;
  value: unknown;
  latencyMs: number;
  error?: string;
}

export interface TriangulationCheckResult {
  checkId: string;
  description: string;
  passed: boolean;
  resolverValues: TriangulationResolverResult[];
  /** Populated when `passed === false`. Short human description of which resolvers disagreed. */
  disagreement?: string;
}

export interface TriangulationRunResult {
  startedAt: string;
  finishedAt: string;
  totalChecks: number;
  passedChecks: number;
  failedChecks: TriangulationCheckResult[];
  results: TriangulationCheckResult[];
}

// ============================================================================
// EQUALITY HELPERS
// ============================================================================

/** Default equality: structural via JSON.stringify with sorted keys. */
export function defaultCompare(values: unknown[]): boolean {
  if (values.length < 2) return true;
  const reference = stableStringify(values[0]);
  for (let i = 1; i < values.length; i++) {
    if (stableStringify(values[i]) !== reference) return false;
  }
  return true;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

// ============================================================================
// HARNESS RUNNER
// ============================================================================

/**
 * Run every check in a list. Each resolver runs sequentially within a
 * check (so we can correlate latencies), but checks themselves are
 * sequential too — the harness is not a load test, it's a
 * proprioception probe. Total wall-clock for the default check set is
 * a few seconds.
 *
 * Failures (disagreement) are collected but do NOT auto-trigger
 * investigation here — the integration layer (a scripted bench or
 * the parent orchestrator chat that called this) is responsible for
 * deciding when to delegate. Keeping the harness pure means it works
 * inside unit tests without spinning up a sub-orchestrator.
 */
export async function runTriangulation(
  checks: TriangulationCheck[],
  ctx: TriangulationCtx,
): Promise<TriangulationRunResult> {
  const startedAt = new Date().toISOString();
  const results: TriangulationCheckResult[] = [];

  for (const check of checks) {
    const resolverValues: TriangulationResolverResult[] = [];
    for (const resolver of check.resolvers) {
      const t0 = Date.now();
      try {
        const value = await resolver.run(ctx);
        resolverValues.push({ name: resolver.name, value, latencyMs: Date.now() - t0 });
      } catch (err) {
        resolverValues.push({
          name: resolver.name,
          value: null,
          latencyMs: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const compare = check.compare ?? defaultCompare;
    const values = resolverValues.map((r) => r.value);
    const anyError = resolverValues.some((r) => r.error);
    const passed = !anyError && compare(values);

    let disagreement: string | undefined;
    if (!passed) {
      const summary = resolverValues
        .map((r) => `${r.name}=${r.error ? `ERROR(${r.error})` : safePreview(r.value)}`)
        .join(' vs ');
      disagreement = `[${check.id}] ${summary}`;
    }

    results.push({
      checkId: check.id,
      description: check.description,
      passed,
      resolverValues,
      disagreement,
    });

    if (!passed) {
      logger.warn({ checkId: check.id, disagreement }, '[triangulation] check disagreed');
    }
  }

  const finishedAt = new Date().toISOString();
  const failedChecks = results.filter((r) => !r.passed);
  return {
    startedAt,
    finishedAt,
    totalChecks: results.length,
    passedChecks: results.length - failedChecks.length,
    failedChecks,
    results,
  };
}

function safePreview(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value.length > 80 ? value.slice(0, 77) + '...' : value;
  const json = JSON.stringify(value);
  return json.length > 100 ? json.slice(0, 97) + '...' : json;
}

// ============================================================================
// INVESTIGATION PROMPT BUILDER
// ============================================================================

/**
 * Format a failed triangulation check as a structured investigation
 * prompt for the `delegate_subtask({focus: 'investigate'})` sub-
 * orchestrator. Keeps the discrepancy concrete (resolver names, exact
 * values, expected shape) so the investigator does not waste budget
 * re-discovering what failed.
 *
 * The triangulation harness intentionally does not call this itself —
 * the parent orchestrator decides when to delegate, gets to see the
 * full TriangulationCheckResult, and can choose to investigate the
 * failure, cluster failures, or escalate to the user.
 */
export function buildInvestigatePromptForFailure(failure: TriangulationCheckResult): string {
  const lines: string[] = [];
  lines.push(`Triangulation check "${failure.checkId}" failed: ${failure.description}`);
  lines.push('');
  lines.push('The same proprioception question was answered via two independent query paths and they disagreed:');
  lines.push('');
  for (const resolver of failure.resolverValues) {
    if (resolver.error) {
      lines.push(`- **${resolver.name}** (${resolver.latencyMs}ms): ERROR — ${resolver.error}`);
    } else {
      lines.push(`- **${resolver.name}** (${resolver.latencyMs}ms): \`${safePreview(resolver.value)}\``);
    }
  }
  lines.push('');
  lines.push('Find the ROOT CAUSE of the disagreement. Either one resolver is wrong (and you should locate the buggy code path), or both are right and there is a hidden bifurcation in the data (and you should locate the producer that introduced it). Do NOT conclude "data drift", "environment issue", or "model error" without first reading the relevant tool handler source AND the underlying data shape.');
  lines.push('');
  lines.push('Follow the investigate-focus protocol exactly: expand search variations inline, fan out via local_search_content, read top hits, form at least 2 hypotheses with concrete confirm_query/confirm_result, bisect, conclude with the structured JSON schema.');
  return lines.join('\n');
}
