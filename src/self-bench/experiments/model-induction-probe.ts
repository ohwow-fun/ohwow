/**
 * ModelInductionProbeExperiment — closes the discovery→self-test loop.
 *
 * Reads the most recent model_releases findings (written by
 * ModelReleaseMonitorExperiment), scores candidates by download + like
 * counts, then fires a live LLM round-trip through each candidate model
 * via the runtime model router. The result surfaces in model_health
 * findings so operators can see which freshly discovered models are
 * actually reachable and responsive.
 *
 * Skip policy
 * -----------
 * - Skips when no model_releases findings exist yet (returns
 *   skipped_reason='no_recent_releases').
 * - Skips when ctx.engine.modelRouter is absent (returns
 *   skipped_reason='no_model_router').
 * - Caps candidates to MAX_CANDIDATES_PER_TICK (3) per tick to bound
 *   token spend.
 *
 * Verdict
 * -------
 * - pass:    all tested models responded without error (or skipped).
 * - warning: one or more tested models failed, or skipped (no data).
 * - fail:    candidates_tested > 0 and every probe errored.
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
import { runLlmCall } from '../../execution/llm-organ.js';
import { logger } from '../../lib/logger.js';
import { getRuntimeConfig, setRuntimeConfig } from '../runtime-config.js';

const MAX_CANDIDATES_PER_TICK = 3;

export const TOOL_CALL_PROBE_PROMPT =
  'Respond in exactly one sentence: describe what kind of tasks you are best suited for.';

export interface ModelInductionEvidence extends Record<string, unknown> {
  candidates_found: number;
  candidates_tested: number;
  skipped_reason?: string;
  per_model: Array<{
    model_id: string;
    score: number;
    ok: boolean;
    latency_ms: number;
    response_snippet: string;
    error?: string;
  }>;
}

interface HfModelEntry {
  id: string;
  downloads: number;
  likes: number;
}

interface FamilyScanResult {
  new_hf_models: HfModelEntry[];
}

interface ModelReleaseFinding {
  ran_at: string;
  evidence: string;
}

export class ModelInductionProbeExperiment implements Experiment {
  readonly id = 'model-induction-probe';
  readonly name = 'Model induction probe (live LLM round-trip per fresh release)';
  readonly category: ExperimentCategory = 'model_health';
  readonly hypothesis =
    'Freshly discovered models from HuggingFace are only useful if the runtime can '
    + 'actually reach and invoke them. Firing a live one-sentence probe per top-scored '
    + 'candidate every 24 hours surfaces routing gaps before any agent depends on the model.';
  readonly cadence = { everyMs: 24 * 60 * 60 * 1000, runOnBoot: false };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    // --- Step 1: read recent model_releases findings ---
    const { data: rows, error: dbErr } = await ctx.db
      .from<ModelReleaseFinding>('self_findings')
      .select('ran_at,evidence')
      .eq('experiment_id', 'model-release-monitor')
      .order('ran_at', { ascending: false })
      .limit(3);

    if (dbErr) {
      logger.warn({ err: dbErr }, '[model-induction-probe] DB query error');
    }

    const findings: ModelReleaseFinding[] = rows ?? [];

    // Flatten + deduplicate all new_hf_models across the 3 most recent findings
    const seenIds = new Set<string>();
    const allModels: Array<HfModelEntry & { score: number }> = [];

    for (const finding of findings) {
      let parsed: { families?: FamilyScanResult[] } | null = null;
      try {
        parsed = JSON.parse(finding.evidence) as { families?: FamilyScanResult[] };
      } catch {
        logger.debug({ ran_at: finding.ran_at }, '[model-induction-probe] failed to parse evidence');
        continue;
      }

      for (const family of parsed.families ?? []) {
        for (const model of family.new_hf_models ?? []) {
          if (!seenIds.has(model.id)) {
            seenIds.add(model.id);
            const score = (model.downloads ?? 0) * 0.001 + (model.likes ?? 0) * 0.01;
            allModels.push({ ...model, score });
          }
        }
      }
    }

    if (allModels.length === 0) {
      const evidence: ModelInductionEvidence = {
        candidates_found: 0,
        candidates_tested: 0,
        skipped_reason: 'no_recent_releases',
        per_model: [],
      };
      return {
        subject: null,
        summary: 'skipped: no recent model releases found',
        evidence: evidence as unknown as Record<string, unknown>,
      };
    }

    // Sort descending by score, take top N
    allModels.sort((a, b) => b.score - a.score);
    const candidates = allModels.slice(0, MAX_CANDIDATES_PER_TICK);

    // --- Step 2: guard on model router ---
    if (!ctx.engine?.modelRouter) {
      const evidence: ModelInductionEvidence = {
        candidates_found: allModels.length,
        candidates_tested: 0,
        skipped_reason: 'no_model_router',
        per_model: [],
      };
      return {
        subject: null,
        summary: 'skipped: model router unavailable',
        evidence: evidence as unknown as Record<string, unknown>,
      };
    }

    // --- Step 3: live probe each candidate ---
    const perModel: ModelInductionEvidence['per_model'] = [];

    for (const candidate of candidates) {
      const startMs = Date.now();
      const llm = await runLlmCall(
        {
          modelRouter: ctx.engine.modelRouter,
          db: ctx.db,
          workspaceId: ctx.workspaceId,
          experimentId: this.id,
        },
        {
          prefer_model: candidate.id,
          purpose: 'simple_classification',
          prompt: TOOL_CALL_PROBE_PROMPT,
          max_tokens: 150,
        },
      );
      const latencyMs = Date.now() - startMs;

      if (llm.ok) {
        perModel.push({
          model_id: candidate.id,
          score: candidate.score,
          ok: true,
          latency_ms: latencyMs,
          response_snippet: llm.data.text?.slice(0, 120) ?? '',
        });
      } else {
        logger.debug(
          { model_id: candidate.id, err: llm.error },
          '[model-induction-probe] probe failed',
        );
        perModel.push({
          model_id: candidate.id,
          score: candidate.score,
          ok: false,
          latency_ms: latencyMs,
          response_snippet: '',
          error: llm.error,
        });
      }
    }

    const testedCount = perModel.length;
    const passedCount = perModel.filter((m) => m.ok).length;
    const failedCount = testedCount - passedCount;

    const evidence: ModelInductionEvidence = {
      candidates_found: allModels.length,
      candidates_tested: testedCount,
      per_model: perModel,
    };

    const summary =
      testedCount === 0
        ? 'no candidates probed'
        : `probed ${testedCount} model${testedCount === 1 ? '' : 's'}: ${passedCount} passed, ${failedCount} failed`;

    return {
      subject: perModel[0]?.model_id ?? null,
      summary,
      evidence: evidence as unknown as Record<string, unknown>,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ModelInductionEvidence;

    if (ev.skipped_reason) return 'warning';

    if (ev.candidates_tested > 0 && ev.per_model.every((m) => !m.ok)) return 'fail';
    if (ev.per_model.some((m) => !m.ok)) return 'warning';

    return 'pass';
  }

  async intervene(
    verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    if (verdict === 'pass') {
      const ev = result.evidence as ModelInductionEvidence;

      // Read history to check for consecutive passes
      const history = await ctx.recentFindings('model-induction-probe', 10);

      const toPromote: string[] = [];
      for (const m of ev.per_model) {
        if (!m.ok) continue;

        // Check if the previous finding also had this model passing
        const prevFinding = history[0];
        if (!prevFinding) continue;

        let prevEv: ModelInductionEvidence | null = null;
        try {
          prevEv = JSON.parse(prevFinding.evidence as unknown as string) as ModelInductionEvidence;
        } catch {
          // evidence may already be parsed as an object
          prevEv = prevFinding.evidence as unknown as ModelInductionEvidence;
        }

        const prevModelEntry = prevEv?.per_model?.find((p) => p.model_id === m.model_id);
        if (!prevModelEntry?.ok) continue;

        // Consecutive pass confirmed — candidate for promotion
        const current = getRuntimeConfig('model_induction.promoted_models', [] as string[]);
        if (!current.includes(m.model_id)) {
          toPromote.push(m.model_id);
        }
      }

      if (toPromote.length === 0) return null;

      const current = getRuntimeConfig('model_induction.promoted_models', [] as string[]);
      const updated = [...new Set([...current, ...toPromote])];
      await setRuntimeConfig(ctx.db, 'model_induction.promoted_models', updated, { setBy: this.id });

      return {
        description: `Promoted ${toPromote.length} model${toPromote.length === 1 ? '' : 's'} to active pool`,
        details: { promoted: toPromote, total_pool: updated.length },
      };
    }

    const ev = result.evidence as ModelInductionEvidence;
    if (ev.per_model.length === 0) return null;

    const passedCount = ev.per_model.filter((m) => m.ok).length;
    const failedCount = ev.per_model.length - passedCount;

    return {
      description: `Probed ${ev.per_model.length} model${ev.per_model.length === 1 ? '' : 's'}: ${passedCount} passed, ${failedCount} failed`,
      details: { per_model: ev.per_model },
    };
  }

  readonly burnDownKeys: string[] = [];
}
