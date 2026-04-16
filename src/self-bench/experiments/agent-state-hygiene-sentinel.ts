/**
 * AgentStateHygieneSentinelExperiment — detects agent state values
 * that carry self-reinforcing "fallback" decision markers.
 *
 * Why this exists
 * ---------------
 * 2026-04-16 we found a second, subtler loop in the X posting pipeline.
 * After we disabled the broken `post_tweet_synth` skills, the
 * content-cadence agent ("The Voice") ran and — finding no working
 * browser tool — wrote its state key `tweet_to_post` with a shape
 * like `{text:"...", status:"posting_manually", reason:"drafted for
 * manual posting"}`. Every subsequent cadence tick then:
 *
 *   1. called get_state('tweet_to_post')
 *   2. read back status=posting_manually
 *   3. treated the fallback decision as authoritative
 *   4. produced a markdown deliverable "## Tweet Ready for Manual
 *      Posting" without ever calling x_compose_tweet
 *
 * The deliverable-action-sentinel catches the task OUTPUT pattern
 * but doesn't see the persistent STATE layer that's driving the
 * decision. This experiment fills the gap: it scans the
 * agent_workforce_task_state table for values that contain fallback
 * decision markers and flags them so an operator (or a future
 * auto-cleaner) can invalidate the poison.
 *
 * The markers are deliberately conservative — they match terminal
 * "I gave up" decisions, not in-progress ones. A state row with
 * status=`pending_manual_review` is a legitimate pause. A row with
 * status=`posting_manually` or reason=`cannot automate` is the
 * sticky kind we want to catch.
 *
 * Not an intervener. The sentinel only surfaces; remediation is
 * explicit (operator clears the key, or a future pairing with the
 * narrated-failure gate auto-clears keys written inside a failed
 * task's state-changelog window).
 */

import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { executeStateTool } from '../../execution/state/index.js';
import { logger } from '../../lib/logger.js';

const PROBE_EVERY_MS = 5 * 60 * 1000;
/** Minimum flagged rows required to move past `pass`. */
const MIN_SAMPLES = 1;
/** Minimum flagged rows required for the `fail` verdict. Single state
 *  poisonings are sometimes intentional (an operator set a flag);
 *  fail only when the pattern repeats across agents/keys. */
const MIN_FAIL_SAMPLES = 2;

/**
 * Lowercase substrings treated as fallback-decision markers. Matched
 * against the raw `value` column (which is JSON text for object-shaped
 * values). Kept narrow so legitimate state like
 * `{awaiting_manual_approval:true}` doesn't spuriously flag — we want
 * "the agent decided to skip / do it manually / could not proceed",
 * not "something is queued for human review".
 *
 * Exported so operators can extend via a runtime_settings override
 * in a future patch without recompiling.
 */
export const STATE_POISON_MARKERS: readonly string[] = [
  'posting_manually',
  'post_manually',
  'manual_post_required',
  'manual_posting',
  'cannot_automate',
  'automation_failed',
  'gave_up',
  'skipped_due_to_auth',
  'auth_unavailable',
  'credentials_missing',
  'login_required',
  'fallback_to_manual',
] as const;

interface CandidateStateRow {
  agent_id: string;
  key: string;
  /**
   * SQLite stores `value` as TEXT, but our DB adapter JSON-parses any
   * row that happens to be valid JSON before handing it back — so the
   * read surface is `string | object | null | number | boolean`.
   * Widen the type; `matchMarker` stringifies defensively.
   */
  value: unknown;
  updated_at: string | null;
}

interface FlaggedState {
  agent_id: string;
  key: string;
  marker: string;
  value_preview: string;
  updated_at: string | null;
}

export interface AgentStateHygieneEvidence extends Record<string, unknown> {
  rows_scanned: number;
  flagged_rows: number;
  poisoned_fraction: number;
  /** Top 10 flagged state rows, newest first. */
  flagged: FlaggedState[];
  /** Count grouped by (agent_id, key) so repeats are visible. */
  by_agent_key: Array<{ agent_id: string; key: string; count: number }>;
  __tracked_field: 'flagged_rows';
}

/**
 * Remove poisoned fields from a state value while preserving the
 * useful payload (e.g. the `text` field of a tweet draft). Returns
 * `null` when the value can't be sanitized (primitive, array, or the
 * whole object consists of poisoned fields) — intervene() writes
 * `{}` in that case rather than deleting the row, so cloud-sync's
 * updatedAt-newer-wins compare accepts the local update at next boot.
 *
 * Fields are considered "poisoned" when either their KEY name or
 * their string VALUE matches any entry in STATE_POISON_MARKERS
 * (case-insensitive substring). We strip the whole field pair rather
 * than just the value, because state readers check for the presence
 * of keys like `status` / `reason` to branch — leaving
 * `status: undefined` would be semantically ambiguous.
 *
 * Exported for unit tests.
 */
export function sanitizePoisonedValue(raw: unknown): Record<string, unknown> {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return {}; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const source = parsed as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const keyLower = key.toLowerCase();
    if (STATE_POISON_MARKERS.some((m) => keyLower.includes(m))) continue;
    if (typeof value === 'string') {
      const valueLower = value.toLowerCase();
      if (STATE_POISON_MARKERS.some((m) => valueLower.includes(m))) continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

/**
 * Normalize an arbitrary `value` column read into a lowercase search
 * haystack. SQLite returns TEXT, but the DB adapter transparently
 * JSON-parses valid-JSON rows into objects/arrays before they reach
 * here — so we must JSON.stringify anything non-string before the
 * substring scan. Primitives coerce with `String()`. Null returns
 * null so the caller short-circuits.
 */
function matchMarker(value: unknown): string | null {
  if (value == null) return null;
  let haystack: string;
  if (typeof value === 'string') {
    haystack = value;
  } else if (typeof value === 'object') {
    try {
      haystack = JSON.stringify(value);
    } catch {
      return null;
    }
  } else {
    haystack = String(value);
  }
  const lower = haystack.toLowerCase();
  for (const marker of STATE_POISON_MARKERS) {
    if (lower.includes(marker)) return marker;
  }
  return null;
}

export class AgentStateHygieneSentinelExperiment implements Experiment {
  readonly id = 'agent-state-hygiene-sentinel';
  readonly name = 'Agent state hygiene sentinel';
  readonly category: ExperimentCategory = 'tool_reliability';
  readonly hypothesis =
    'Agent state written during a failed action can carry fallback decision markers (status=posting_manually, reason=cannot automate, etc.) that become self-reinforcing: every subsequent task reads the marker, treats the fallback as authoritative, and never re-attempts the action. A single flagged key indicates the observability layer should warn; repeated keys across agents indicate the remediation path is missing.';
  readonly cadence = { everyMs: PROBE_EVERY_MS, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    let rows: CandidateStateRow[] = [];
    try {
      const result = await ctx.db
        .from('agent_workforce_task_state')
        .select('agent_id, key, value, updated_at')
        .eq('workspace_id', ctx.workspaceId)
        .limit(2000);
      rows = ((result.data ?? []) as unknown as CandidateStateRow[]).filter((r) => r != null);
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : err },
        '[agent-state-hygiene-sentinel] query failed',
      );
      const evidence: AgentStateHygieneEvidence = {
        rows_scanned: 0,
        flagged_rows: 0,
        poisoned_fraction: 0,
        flagged: [],
        by_agent_key: [],
        __tracked_field: 'flagged_rows',
      };
      return { subject: 'agent-state:summary', summary: 'query failed; skipping', evidence };
    }

    const flagged: FlaggedState[] = [];
    const pairCounts = new Map<string, number>();
    for (const row of rows) {
      const marker = matchMarker(row.value);
      if (!marker) continue;
      const pairKey = `${row.agent_id}::${row.key}`;
      pairCounts.set(pairKey, (pairCounts.get(pairKey) ?? 0) + 1);
      if (flagged.length < 10) {
        const preview = typeof row.value === 'string'
          ? row.value
          : (() => { try { return JSON.stringify(row.value); } catch { return String(row.value); } })();
        flagged.push({
          agent_id: row.agent_id,
          key: row.key,
          marker,
          value_preview: preview.slice(0, 240),
          updated_at: row.updated_at,
        });
      }
    }

    // Sort flagged newest-first so operators see the most recent
    // poison at the top of evidence without scanning the whole list.
    flagged.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));

    const byAgentKey = Array.from(pairCounts.entries())
      .map(([key, count]) => {
        const [agent_id, ...keyParts] = key.split('::');
        return { agent_id, key: keyParts.join('::'), count };
      })
      .sort((a, b) => b.count - a.count);

    const rate = rows.length === 0 ? 0 : flagged.length / rows.length;

    const evidence: AgentStateHygieneEvidence = {
      rows_scanned: rows.length,
      flagged_rows: flagged.length,
      poisoned_fraction: rate,
      flagged,
      by_agent_key: byAgentKey,
      __tracked_field: 'flagged_rows',
    };

    let summary: string;
    if (rows.length === 0) {
      summary = 'no task-state rows in workspace';
    } else if (flagged.length === 0) {
      summary = `scanned ${rows.length} state row(s), no fallback-decision markers`;
    } else {
      const top = byAgentKey[0];
      summary = `${flagged.length}/${rows.length} state row(s) carry fallback markers; top: agent ${top.agent_id.slice(0, 8)} key "${top.key}" (marker "${flagged[0].marker}")`;
    }

    return { subject: 'agent-state:summary', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as AgentStateHygieneEvidence;
    if (ev.flagged_rows < MIN_SAMPLES) return 'pass';
    if (ev.flagged_rows >= MIN_FAIL_SAMPLES) return 'fail';
    return 'warning';
  }

  /**
   * Idempotently clean each flagged row by writing a sanitized value
   * through `executeStateTool('set_state', ...)`. Routing through the
   * state adapter (not raw SQL) matters for two reasons:
   *
   *   1. The adapter stamps `updated_at = new Date().toISOString()`
   *      (ISO T-Z format). The cloud-sync compare at boot uses
   *      `entry.updatedAt > local.updated_at`; with both sides in
   *      ISO format the comparison reflects actual time, and our
   *      fresh write beats the stale cloud snapshot.
   *   2. The adapter writes to `agent_workforce_state_changelog`,
   *      which `engine.collectStateUpdates` then reports to cloud on
   *      the next task cycle. That teaches the cloud snapshot the
   *      new value so the poison doesn't re-sync forever.
   *
   * This is the structural complement to the probe: the probe makes
   * poison visible; intervene makes it disappear. On the next tick
   * the same (agent_id, key) pair won't match any marker so verdict
   * naturally returns to `pass` — no separate "validate rollback"
   * step needed.
   */
  async intervene(
    verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    if (verdict !== 'warning' && verdict !== 'fail') return null;
    const ev = result.evidence as AgentStateHygieneEvidence;
    if (ev.flagged.length === 0) return null;

    const cleaned: Array<{ agent_id: string; key: string; marker: string; dropped_keys: string[] }> = [];
    const errors: Array<{ agent_id: string; key: string; error: string }> = [];

    for (const flag of ev.flagged) {
      try {
        // Re-read the row so we sanitize the CURRENT value rather
        // than the snapshot captured in the probe's evidence preview
        // (which is also truncated to 240 chars).
        const { data: row } = await ctx.db
          .from('agent_workforce_task_state')
          .select('value, value_type, scope, scope_id')
          .eq('workspace_id', ctx.workspaceId)
          .eq('agent_id', flag.agent_id)
          .eq('key', flag.key)
          .maybeSingle();
        if (!row) continue;
        const typed = row as { value: unknown; value_type: string; scope?: string; scope_id?: string | null };

        const before = typed.value;
        const sanitized = sanitizePoisonedValue(before);
        const beforeKeys = (before && typeof before === 'object' && !Array.isArray(before))
          ? Object.keys(before as Record<string, unknown>)
          : [];
        const droppedKeys = beforeKeys.filter((k) => !Object.prototype.hasOwnProperty.call(sanitized, k));

        const writeResult = await executeStateTool(
          'set_state',
          {
            key: flag.key,
            value: sanitized,
            scope: typed.scope ?? 'agent',
            scope_id: typed.scope_id ?? null,
          },
          {
            db: ctx.db,
            workspaceId: ctx.workspaceId,
            agentId: flag.agent_id,
          },
        );
        if (writeResult.is_error) {
          errors.push({ agent_id: flag.agent_id, key: flag.key, error: writeResult.content });
          continue;
        }
        cleaned.push({
          agent_id: flag.agent_id,
          key: flag.key,
          marker: flag.marker,
          dropped_keys: droppedKeys,
        });
      } catch (err) {
        errors.push({
          agent_id: flag.agent_id,
          key: flag.key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (cleaned.length === 0 && errors.length === 0) return null;

    logger.info(
      { cleaned_count: cleaned.length, error_count: errors.length },
      '[agent-state-hygiene-sentinel] intervention complete',
    );

    return {
      description: `Sanitized ${cleaned.length}/${ev.flagged.length} poisoned state row(s) by dropping fallback-decision fields`,
      details: { cleaned, errors },
    };
  }
}
