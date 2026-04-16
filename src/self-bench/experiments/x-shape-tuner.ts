/**
 * XShapeTunerExperiment — Layer 5 of the bench level-up plan.
 *
 * Consumes XOpsObserverExperiment findings and, when a shape is
 * structurally underperforming (high volume but low dispatch success)
 * or structurally under-represented (low volume but decent engagement
 * proxy), proposes a reweighting of the shape mix the x-compose script
 * draws from.
 *
 * The knob is `x_compose.shape_weights` in runtime_config. The tuner
 * also writes a sidecar JSON file under the workspace data dir so
 * x-compose.mjs (which runs as a spawned tsx child and does not share
 * the daemon's sqlite connection) can pick up the weights each run
 * with a single fs.readFileSync, no new dependency.
 *
 * Reversibility: 48 h after an intervention, validate() reads the
 * latest observer finding and compares dispatch success + engagement
 * proxy vs the pre-intervention baseline. If either regressed by more
 * than a floor, rollback() deletes the config key and the sidecar.
 *
 * Daily intervention cap 1 (same pattern as content-cadence-tuner).
 * Hard bounds: per-shape weight stays within [0, 2]; cumulative delta
 * across the weight vector capped at 0.5 per intervention so one
 * cycle can't swing the distribution wildly.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  ValidationResult,
  Verdict,
} from '../experiment-types.js';
import { BusinessExperiment } from '../business-experiment.js';
import {
  setRuntimeConfig,
  deleteRuntimeConfig,
  getRuntimeConfig,
} from '../runtime-config.js';

export const SHAPE_WEIGHTS_CONFIG_KEY = 'x_compose.shape_weights';
export const SHAPE_WEIGHTS_SIDECAR_NAME = 'shape-weights.json';

/** Canonical shape list for x-compose. Mirrors the default in the script. */
export const CANONICAL_SHAPES = [
  'tactical_tip', 'observation', 'opinion', 'question', 'story', 'humor',
];

const DEFAULT_WEIGHT = 1;
const MIN_WEIGHT = 0;
const MAX_WEIGHT = 2;
const MAX_CUMULATIVE_DELTA = 0.5;
const PROBE_EVERY_MS = 6 * 60 * 60 * 1000;
const VALIDATION_DELAY_MS = 48 * 60 * 60 * 1000;
const DAILY_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAILY_INTERVENTION_CAP = 1;
/** Minimum posts+approvals volume before we trust the observer signal. */
const MIN_VOLUME_FOR_TUNE = 10;
/** Over-represented threshold: a shape with >= this fraction of outbound posts is eligible for shrinking. */
const OVERREP_FRACTION = 0.5;
/** Under-represented threshold: a shape below this fraction is eligible for widening. */
const UNDERREP_FRACTION = 0.1;
/** Engagement drop that justifies rollback on validate. */
const VALIDATION_ENGAGEMENT_DROP = 0.25;

type WeightMap = Record<string, number>;

interface ShapeTunerEvidence extends Record<string, unknown> {
  source_finding_id: string | null;
  observer_stale: boolean;
  current_weights: WeightMap;
  proposed_weights: WeightMap | null;
  shape_distribution: Record<string, number>;
  dispatch_success_rate: number | null;
  engagement_median_likes: number | null;
  volume: number;
  should_tune: boolean;
  reason: string;
}

function currentWeights(): WeightMap {
  const stored = getRuntimeConfig<WeightMap | null>(SHAPE_WEIGHTS_CONFIG_KEY, null);
  const out: WeightMap = {};
  for (const s of CANONICAL_SHAPES) out[s] = DEFAULT_WEIGHT;
  if (stored && typeof stored === 'object') {
    for (const [k, v] of Object.entries(stored)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        out[k] = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, v));
      }
    }
  }
  return out;
}

/**
 * Shape-picking policy. Takes the observer's shape_distribution +
 * dispatch stats and proposes a new weight map. Never changes a shape
 * by more than 0.3 and the total absolute change stays under
 * MAX_CUMULATIVE_DELTA so no single intervention swings the
 * distribution dramatically.
 */
export function proposeWeights(
  current: WeightMap,
  shapeDistribution: Record<string, number>,
  dispatchSuccessRate: number | null,
): { weights: WeightMap; reason: string } | null {
  const totalVolume = Object.values(shapeDistribution).reduce((a, b) => a + b, 0);
  if (totalVolume < MIN_VOLUME_FOR_TUNE) return null;

  // Only consider shapes the tuner knows about (ignores kind-based
  // buckets like 'reply' or 'upload' that XOpsObserver also records).
  const composeShapes = CANONICAL_SHAPES.filter((s) => s in shapeDistribution);
  if (composeShapes.length === 0) return null;

  const fractions = new Map<string, number>();
  let composeTotal = 0;
  for (const s of composeShapes) {
    composeTotal += shapeDistribution[s];
  }
  if (composeTotal < MIN_VOLUME_FOR_TUNE) return null;
  for (const s of composeShapes) {
    fractions.set(s, shapeDistribution[s] / composeTotal);
  }

  let overrep: string | null = null;
  let underrep: string | null = null;
  for (const [s, frac] of fractions.entries()) {
    if (frac >= OVERREP_FRACTION && (!overrep || frac > (fractions.get(overrep) ?? 0))) {
      overrep = s;
    }
    if (frac <= UNDERREP_FRACTION && (!underrep || frac < (fractions.get(underrep) ?? 1))) {
      underrep = s;
    }
  }
  // Dispatch-rate-conditioned logic: if the overrep shape is ALSO under-
  // performing on dispatch, prefer to cool it down. If dispatch is fine,
  // the overrep shape may be simply winning — leave it.
  const dispatchLow = dispatchSuccessRate !== null && dispatchSuccessRate < 0.9;
  if (!overrep && !underrep) return null;

  const next: WeightMap = { ...current };
  let cumulative = 0;
  let reason = '';
  if (overrep && dispatchLow) {
    const delta = -0.2;
    const newWeight = Math.max(MIN_WEIGHT, (next[overrep] ?? DEFAULT_WEIGHT) + delta);
    cumulative += Math.abs(newWeight - (next[overrep] ?? DEFAULT_WEIGHT));
    next[overrep] = newWeight;
    reason += `shrink-${overrep}(${(fractions.get(overrep) ?? 0).toFixed(2)}share,dispatch=${dispatchSuccessRate?.toFixed(2)}) `;
  }
  if (underrep) {
    const delta = 0.2;
    const newWeight = Math.min(MAX_WEIGHT, (next[underrep] ?? DEFAULT_WEIGHT) + delta);
    const step = Math.abs(newWeight - (next[underrep] ?? DEFAULT_WEIGHT));
    if (cumulative + step <= MAX_CUMULATIVE_DELTA) {
      cumulative += step;
      next[underrep] = newWeight;
      reason += `widen-${underrep}(${(fractions.get(underrep) ?? 0).toFixed(2)}share) `;
    }
  }
  if (cumulative === 0) return null;

  return { weights: next, reason: reason.trim() };
}

function sidecarPath(workspaceSlug: string, overrideDir?: string): string {
  const dir = overrideDir ?? path.join(os.homedir(), '.ohwow', 'workspaces', workspaceSlug);
  return path.join(dir, SHAPE_WEIGHTS_SIDECAR_NAME);
}

export class XShapeTunerExperiment extends BusinessExperiment {
  id = 'x-shape-tuner';
  name = 'X shape tuner (Layer 5)';
  hypothesis =
    `When x-ops-observer reports a shape is over-represented with sub-90% dispatch success, reducing that shape's weight in ${SHAPE_WEIGHTS_CONFIG_KEY} and widening an under-represented shape should move the distribution toward better approval balance. Validated 48h later against dispatch rate + engagement; rolled back on regression.`;
  cadence = {
    everyMs: PROBE_EVERY_MS,
    runOnBoot: false,
    validationDelayMs: VALIDATION_DELAY_MS,
  };

  /** Override sidecar dir for tests. Second arg passes through to BusinessExperiment. */
  constructor(
    private readonly dataDirOverride?: string,
    opts: ConstructorParameters<typeof BusinessExperiment>[0] = {},
  ) {
    super(opts);
  }

  protected async businessProbe(ctx: ExperimentContext): Promise<ProbeResult> {
    const observerFindings = await ctx.recentFindings('x-ops-observer', 3);
    const latest = observerFindings[0] ?? null;

    const current = currentWeights();

    if (!latest) {
      const evidence: ShapeTunerEvidence = {
        source_finding_id: null,
        observer_stale: true,
        current_weights: current,
        proposed_weights: null,
        shape_distribution: {},
        dispatch_success_rate: null,
        engagement_median_likes: null,
        volume: 0,
        should_tune: false,
        reason: 'no observer findings yet',
      };
      return {
        subject: null,
        summary: 'no x-ops-observer findings — tuner standing down',
        evidence,
      };
    }

    const observerEv = latest.evidence as {
      shape_distribution?: Record<string, number>;
      dispatch_success_rate?: number | null;
      engagement_median_likes?: number | null;
      approvals_counted?: number;
    };

    const shapeDistribution = observerEv.shape_distribution ?? {};
    const dispatch = typeof observerEv.dispatch_success_rate === 'number'
      ? observerEv.dispatch_success_rate
      : null;
    const likes = typeof observerEv.engagement_median_likes === 'number'
      ? observerEv.engagement_median_likes
      : null;
    const volume = observerEv.approvals_counted ?? 0;
    const proposal = proposeWeights(current, shapeDistribution, dispatch);

    const evidence: ShapeTunerEvidence = {
      source_finding_id: latest.id,
      observer_stale: false,
      current_weights: current,
      proposed_weights: proposal?.weights ?? null,
      shape_distribution: shapeDistribution,
      dispatch_success_rate: dispatch,
      engagement_median_likes: likes,
      volume,
      should_tune: proposal !== null,
      reason: proposal?.reason ?? 'no over/under-represented shapes within dispatch threshold',
    };
    return {
      subject: 'x-ops:shape-weights',
      summary: proposal
        ? `propose reweight: ${proposal.reason}`
        : 'shape mix within bounds — no tune',
      evidence,
    };
  }

  protected businessJudge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ShapeTunerEvidence;
    return ev.should_tune ? 'warning' : 'pass';
  }

  protected async businessIntervene(
    _verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    const ev = result.evidence as ShapeTunerEvidence;
    if (!ev.should_tune || !ev.proposed_weights) return null;

    if (await this.interventionCapReached(ctx, DAILY_INTERVENTION_CAP, DAILY_CAP_WINDOW_MS)) {
      return null;
    }

    const slug = ctx.workspaceSlug ?? 'default';
    const baselineWeights = { ...ev.current_weights };
    const newWeights = { ...ev.proposed_weights };

    await setRuntimeConfig(ctx.db, SHAPE_WEIGHTS_CONFIG_KEY, newWeights, {
      setBy: this.id,
    });

    // Write the sidecar so x-compose.mjs (a spawned child with no db
    // connection) can read the weights without a round-trip through
    // the HTTP api. The sidecar's content mirrors the runtime_config
    // value; if they drift, the sidecar wins for the next x-compose
    // tick — rollback rewrites both so drift heals.
    try {
      const sidecar = sidecarPath(slug, this.dataDirOverride);
      fs.mkdirSync(path.dirname(sidecar), { recursive: true });
      fs.writeFileSync(
        sidecar,
        JSON.stringify(
          {
            weights: newWeights,
            updated_at: new Date().toISOString(),
            updated_by: this.id,
            baseline_weights: baselineWeights,
            reason: ev.reason,
          },
          null,
          2,
        ),
        'utf-8',
      );
    } catch {
      // Non-fatal: the runtime_config entry is the source of truth;
      // the sidecar is a consumption convenience.
    }

    return {
      description: `reweighted ${SHAPE_WEIGHTS_CONFIG_KEY}: ${ev.reason}`,
      details: {
        config_key: SHAPE_WEIGHTS_CONFIG_KEY,
        baseline_weights: baselineWeights,
        new_weights: newWeights,
        reason: ev.reason,
        dispatch_success_rate_at_intervention: ev.dispatch_success_rate,
        engagement_median_likes_at_intervention: ev.engagement_median_likes,
        reversible: true,
      },
    };
  }

  async validate(
    baseline: Record<string, unknown>,
    ctx: ExperimentContext,
  ): Promise<ValidationResult> {
    const baselineDispatch = baseline.dispatch_success_rate_at_intervention as number | undefined;
    const baselineLikes = baseline.engagement_median_likes_at_intervention as number | undefined;

    const observerFindings = await ctx.recentFindings('x-ops-observer', 1);
    const latest = observerFindings[0] ?? null;
    if (!latest) {
      return {
        outcome: 'inconclusive',
        summary: 'no observer findings at validation time — cannot compare',
        evidence: { ...baseline },
      };
    }
    const ev = latest.evidence as {
      dispatch_success_rate?: number | null;
      engagement_median_likes?: number | null;
    };
    const postDispatch = typeof ev.dispatch_success_rate === 'number' ? ev.dispatch_success_rate : null;
    const postLikes = typeof ev.engagement_median_likes === 'number' ? ev.engagement_median_likes : null;

    // Regression tests: either dispatch dropped noticeably OR engagement
    // dropped by more than VALIDATION_ENGAGEMENT_DROP of baseline.
    const dispatchRegressed = baselineDispatch !== undefined
      && postDispatch !== null
      && postDispatch < Math.max(0, baselineDispatch - 0.1);
    const likesRegressed = baselineLikes !== undefined && baselineLikes > 0
      && postLikes !== null
      && postLikes < baselineLikes * (1 - VALIDATION_ENGAGEMENT_DROP);

    const evidence = {
      baseline_dispatch: baselineDispatch ?? null,
      post_dispatch: postDispatch,
      baseline_likes: baselineLikes ?? null,
      post_likes: postLikes,
    };

    if (dispatchRegressed || likesRegressed) {
      return {
        outcome: 'failed',
        summary: `x-shape-tune regressed: dispatch ${baselineDispatch}→${postDispatch}, likes ${baselineLikes}→${postLikes}`,
        evidence,
      };
    }
    return {
      outcome: 'held',
      summary: `x-shape-tune held: dispatch ${baselineDispatch}→${postDispatch}, likes ${baselineLikes}→${postLikes}`,
      evidence,
    };
  }

  async rollback(
    baseline: Record<string, unknown>,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    const slug = ctx.workspaceSlug ?? 'default';
    const baselineWeights = baseline.baseline_weights as WeightMap | undefined;

    await deleteRuntimeConfig(ctx.db, SHAPE_WEIGHTS_CONFIG_KEY);
    try {
      const sidecar = sidecarPath(slug, this.dataDirOverride);
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    } catch {
      // non-fatal
    }

    return {
      description: `cleared ${SHAPE_WEIGHTS_CONFIG_KEY} — weights return to baseline defaults`,
      details: {
        config_key: SHAPE_WEIGHTS_CONFIG_KEY,
        baseline_weights: baselineWeights ?? null,
      },
    };
  }
}
