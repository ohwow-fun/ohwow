/**
 * Pattern-mined skill generator (phase C of the unified-skill plan).
 *
 * The failure-mined path in `synthesis-generator.ts` uses a CDP probe,
 * an LLM, a strict TypeScript template, a lint pass, and a compiled
 * `.ts` file on disk to turn a flailing ReAct loop into a
 * deterministic browser tool. That makes sense for failures, where the
 * evidence is a target URL plus a selector manifest.
 *
 * Pattern-mined candidates are different animals: the evidence is a
 * recurring tool-call sequence that already worked, observed by the
 * 24h miner across three or more successful tasks. The sequence is
 * made of tools the runtime already knows how to dispatch. There is
 * no target URL. There is no new code to generate. The only thing the
 * runtime is missing is a row that names the sequence and records it
 * as a first-class skill the LLM can pick from its tool list.
 *
 * Scope (intentionally narrow)
 *
 *   - Insert a persistent `agent_workforce_skills` row with
 *     `skill_type='code'`, `source_type='pattern-mined'`, and the
 *     tool sequence serialized into `definition.tool_sequence`.
 *   - Produce a stable snake_case name from the pattern hash so
 *     re-mining the same sequence is an idempotent upsert.
 *   - Return the inserted skill id so the autolearner can log it and
 *     pattern-mined test assertions can verify the row shape.
 *
 * Out of scope (deferred to phase D)
 *
 *   - Writing a `.ts` handler file that the runtime skill loader
 *     compiles and hot-registers. Pattern skills ship without a
 *     handler for now; the row is persistent evidence of the mined
 *     sequence and a UI/logging hook, but the LLM won't see it in
 *     its tool list until the loader learns to synthesize a
 *     sequence-runner from `definition.tool_sequence` at boot.
 *   - Calling the actual tools in sequence. A runnable handler needs
 *     a dispatch helper that can invoke both static and runtime
 *     tools uniformly; building it crosses too many module
 *     boundaries for the launch-week follow-up window and will be
 *     revisited post-week-2.
 *
 * This is the honest minimum that closes the data-flow loop: miner →
 * bus → autolearner → code-skill row. Everything downstream of row
 * creation is a separate phase.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';
import type { PatternSynthesisCandidate } from '../../scheduling/synthesis-failure-detector.js';

export interface PatternGeneratorInput {
  db: DatabaseAdapter;
  workspaceId: string;
  candidate: PatternSynthesisCandidate;
}

export interface PatternGeneratorOk {
  ok: true;
  skillId: string;
  name: string;
  reused?: boolean;
}

export interface PatternGeneratorErr {
  ok: false;
  stage: 'lookup' | 'insert';
  error: string;
}

export type PatternGeneratorResult = PatternGeneratorOk | PatternGeneratorErr;

function newSkillId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `skill_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 10)}`;
}

/** Build the deterministic skill name from the pattern id + sequence length. */
export function patternSkillName(candidate: PatternSynthesisCandidate): string {
  return `pattern_${candidate.patternId}`;
}

/** Build a human-readable description from the tool sequence. */
export function patternSkillDescription(candidate: PatternSynthesisCandidate): string {
  const chain = candidate.toolSequence.join(' -> ');
  const pct = Math.round(candidate.avgSuccessRate * 100);
  return `Pattern-mined sequence (${candidate.support} hits, ${pct}% success): ${chain}`;
}

interface ExistingSkillRow {
  id: string;
  name: string;
  is_active?: number;
}

async function findExistingPatternSkill(
  db: DatabaseAdapter,
  workspaceId: string,
  name: string,
): Promise<ExistingSkillRow | null> {
  try {
    const result = await db
      .from<ExistingSkillRow>('agent_workforce_skills')
      .select('id, name, is_active')
      .eq('workspace_id', workspaceId)
      .eq('name', name)
      .eq('skill_type', 'code')
      .limit(1);
    const rows = (result.data ?? []) as ExistingSkillRow[];
    return rows[0] ?? null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, workspaceId, name },
      '[pattern-generator] lookup failed',
    );
    return null;
  }
}

/**
 * Persist a pattern-mined skill row. Idempotent on `patternId`: if a
 * row with the deterministic pattern name already exists for the
 * workspace, returns it with `reused: true` instead of inserting a
 * duplicate.
 */
export async function generateCodeSkillFromPattern(
  input: PatternGeneratorInput,
): Promise<PatternGeneratorResult> {
  const { db, workspaceId, candidate } = input;
  const name = patternSkillName(candidate);

  const existing = await findExistingPatternSkill(db, workspaceId, name);
  if (existing) {
    logger.info(
      { name, skillId: existing.id },
      '[pattern-generator] pattern already persisted, reusing',
    );
    return { ok: true, skillId: existing.id, name, reused: true };
  }

  const skillId = newSkillId();
  const nowIso = new Date().toISOString();
  const definition = {
    source: 'pattern-mined',
    tool_sequence: candidate.toolSequence,
    support: candidate.support,
    avg_success_rate: candidate.avgSuccessRate,
    source_task_ids: candidate.sourceTaskIds,
    manifest_version: 1,
  };

  try {
    await db.from('agent_workforce_skills').insert({
      id: skillId,
      workspace_id: workspaceId,
      name,
      description: patternSkillDescription(candidate),
      skill_type: 'code',
      source_type: 'pattern-mined',
      definition: JSON.stringify(definition),
      agent_ids: candidate.agentId ? JSON.stringify([candidate.agentId]) : '[]',
      pattern_support: candidate.support,
      is_active: 1,
      // No script file in phase C. The row is a persistent pattern
      // record; a runnable handler is deferred to phase D when the
      // loader learns how to synthesize a sequence-runner from
      // definition.tool_sequence.
      script_path: null,
      selectors: '{}',
      origin_trace_id: candidate.sourceTaskIds[0] ?? null,
      success_count: 0,
      fail_count: 0,
      promoted_at: null,
      triggers: '[]',
      created_at: nowIso,
      updated_at: nowIso,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err: error, name },
      '[pattern-generator] insert failed',
    );
    return { ok: false, stage: 'insert', error };
  }

  logger.info(
    { name, skillId, sequenceLength: candidate.toolSequence.length, support: candidate.support },
    '[pattern-generator] pattern skill row persisted',
  );
  return { ok: true, skillId, name };
}
