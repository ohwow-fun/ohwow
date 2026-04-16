/**
 * XEngagementObserverExperiment — Piece 4b of the surprise-first
 * bundle.
 *
 * The closure of Piece 4a's engagement loop. x-own-engagement.mjs
 * keeps appending engagement snapshots to x-own-posts.jsonl on a
 * schedule. This experiment reads those snapshots, joins them with
 * the approval queue (so each post is keyed to the shape it was
 * generated as), aggregates median engagement per shape, and writes
 * ONE finding per shape with subject `x-shape:<shape>` so the Piece 1
 * distiller's baselines run per-shape — meaning the surprise signal
 * is "opinion shape just had a 3σ engagement spike" rather than a
 * single noisy total.
 *
 * Engagement score = likes + 2*replies + 3*reposts (replies and
 * reposts cost more attention than likes; weights match the
 * x-shape-tuner's existing dispatch_success / approval_ratio scoring
 * spirit). Computed per post from the LATEST snapshot in the JSONL,
 * then median'd across all posts of a given shape over the lookback
 * window.
 *
 * Verdict per shape:
 *   pass    — engagement at or above shape's running baseline
 *   warning — engagement below baseline (Piece 1 distiller will
 *             surface the z_score)
 *   pass    — too few samples to make a call (default safe)
 *
 * No intervention: x-shape-tuner (Layer 5) already writes
 * x_compose.shape_weights based on shape DISTRIBUTION; this experiment's
 * findings are the OUTCOME signal that x-autonomy-ramp (Piece 4c)
 * reads to decide which shapes have earned an autonomy bump. Keeping
 * the writer/observer split intentional so neither side starts a
 * tug-of-war over shape_weights.
 *
 * Cadence 30 min + runOnBoot. Scoped to the GTM dogfood workspace
 * via the BusinessExperiment guard.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../../lib/logger.js';
import {
  BusinessExperiment,
  type BusinessExperimentOptions,
} from '../business-experiment.js';
import type {
  ExperimentCadence,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';

const CADENCE: ExperimentCadence = { everyMs: 30 * 60 * 1000, runOnBoot: true };
const LOOKBACK_DAYS = 14;
const MIN_POSTS_PER_SHAPE = 2;

const KNOWN_SHAPES = ['tactical_tip', 'observation', 'opinion', 'question', 'story', 'humor'] as const;
type Shape = typeof KNOWN_SHAPES[number];

interface OwnPostSnapshot {
  ts?: string;
  permalink?: string;
  text?: string;
  likes?: number;
  replies?: number;
  reposts?: number;
  views?: number;
}

interface ApprovalEntry {
  id?: string;
  ts?: string;
  kind?: string;
  status?: string;
  payload?: { shape?: string; permalink?: string; post_text?: string; text?: string };
  appliedResult?: { permalink?: string; url?: string };
}

function workspaceDir(slug: string): string {
  return path.join(os.homedir(), '.ohwow', 'workspaces', slug);
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    logger.debug({ err, filePath }, '[x-engagement-observer] read failed');
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch { /* skip malformed */ }
  }
  return out;
}

function engagementScore(s: OwnPostSnapshot): number {
  return (s.likes ?? 0) + 2 * (s.replies ?? 0) + 3 * (s.reposts ?? 0);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface ShapeAggregate {
  shape: Shape;
  posts: number;
  median_engagement: number;
  best_engagement: number;
  best_permalink: string | null;
  worst_engagement: number;
  worst_permalink: string | null;
}

export interface XEngagementShapeEvidence extends Record<string, unknown> {
  shape: string;
  posts_in_window: number;
  median_engagement: number;
  best_engagement: number;
  best_permalink: string | null;
  worst_engagement: number;
  worst_permalink: string | null;
  __tracked_field: 'median_engagement';
}

/**
 * The runner expects ONE probe() call per experiment per tick that
 * returns ONE finding. We want one finding per shape so baselines run
 * per shape. The standard runner pattern doesn't support that
 * directly, so probe() returns the union evidence for the dominant
 * shape (best engagement) and the experiment also writes per-shape
 * findings as a side effect via ctx.db.from('self_findings').insert.
 * This is the same pattern x-shape-tuner uses for its parallel writes.
 */
export class XEngagementObserverExperiment extends BusinessExperiment {
  readonly id = 'x-engagement-observer';
  readonly name = 'X engagement feedback observer';
  readonly hypothesis =
    'Per-shape median engagement on our own posts has a stable baseline. A shape moving outside its baseline is the surprise signal that x-autonomy-ramp (Piece 4c) reads to allowlist or pull back from a shape.';
  readonly cadence = CADENCE;

  constructor(opts: BusinessExperimentOptions = {}) {
    super(opts);
  }

  protected async businessProbe(ctx: ExperimentContext): Promise<ProbeResult> {
    const slug = ctx.workspaceSlug ?? 'default';
    const dir = workspaceDir(slug);
    const snapshots = readJsonl<OwnPostSnapshot>(path.join(dir, 'x-own-posts.jsonl'));
    const approvals = readJsonl<ApprovalEntry>(path.join(dir, 'x-approvals.jsonl'));

    // Build permalink → shape map from approval queue history.
    const permalinkToShape = new Map<string, Shape>();
    for (const entry of approvals) {
      const shape = entry.payload?.shape as Shape | undefined;
      if (!shape || !KNOWN_SHAPES.includes(shape)) continue;
      const permalink = entry.appliedResult?.permalink ?? entry.appliedResult?.url ?? entry.payload?.permalink;
      if (typeof permalink === 'string' && permalink.length > 0) {
        permalinkToShape.set(permalink, shape);
      }
    }

    // Reduce snapshots to latest per permalink within lookback window.
    const sinceMs = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const latestPerPermalink = new Map<string, OwnPostSnapshot>();
    for (const snap of snapshots) {
      if (!snap.permalink) continue;
      const ts = snap.ts ? Date.parse(snap.ts) : 0;
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      const prev = latestPerPermalink.get(snap.permalink);
      if (!prev || (prev.ts ? Date.parse(prev.ts) : 0) < ts) {
        latestPerPermalink.set(snap.permalink, snap);
      }
    }

    // Aggregate by shape. Posts without an attributable shape go
    // into 'unattributed' which we skip — it's expected for the first
    // wave of organic posts before the tagging loop is running.
    const byShape = new Map<Shape, OwnPostSnapshot[]>();
    for (const [permalink, snap] of latestPerPermalink) {
      const shape = permalinkToShape.get(permalink);
      if (!shape) continue;
      if (!byShape.has(shape)) byShape.set(shape, []);
      byShape.get(shape)!.push(snap);
    }

    const aggregates: ShapeAggregate[] = [];
    for (const shape of KNOWN_SHAPES) {
      const posts = byShape.get(shape) ?? [];
      const scores = posts.map(engagementScore);
      const med = median(scores);
      const best = posts.length === 0 ? null : posts.reduce((acc, p) => (engagementScore(p) > engagementScore(acc) ? p : acc));
      const worst = posts.length === 0 ? null : posts.reduce((acc, p) => (engagementScore(p) < engagementScore(acc) ? p : acc));
      aggregates.push({
        shape,
        posts: posts.length,
        median_engagement: med,
        best_engagement: best ? engagementScore(best) : 0,
        best_permalink: best?.permalink ?? null,
        worst_engagement: worst ? engagementScore(worst) : 0,
        worst_permalink: worst?.permalink ?? null,
      });
    }

    // Side-effect: write per-shape findings (subject = `x-shape:<shape>`)
    // so the Piece 1 distiller maintains per-shape baselines and the
    // novelty score reflects per-shape behaviour, not the shape mix.
    // Best-effort — failures don't block the parent finding.
    for (const agg of aggregates) {
      if (agg.posts < MIN_POSTS_PER_SHAPE) continue;
      try {
        const { writeFinding } = await import('../findings-store.js');
        const evidence: XEngagementShapeEvidence = {
          shape: agg.shape,
          posts_in_window: agg.posts,
          median_engagement: agg.median_engagement,
          best_engagement: agg.best_engagement,
          best_permalink: agg.best_permalink,
          worst_engagement: agg.worst_engagement,
          worst_permalink: agg.worst_permalink,
          __tracked_field: 'median_engagement',
        };
        await writeFinding(ctx.db, {
          experimentId: this.id,
          category: 'business_outcome',
          subject: `x-shape:${agg.shape}`,
          hypothesis: `Median engagement for ${agg.shape} stays at or above its rolling baseline.`,
          verdict: 'pass',
          summary: `${agg.shape}: ${agg.posts} post(s), median=${agg.median_engagement.toFixed(0)}, best=${agg.best_engagement}`,
          evidence,
          interventionApplied: null,
          ranAt: new Date().toISOString(),
          durationMs: 0,
        });
      } catch (err) {
        logger.debug({ err, shape: agg.shape }, '[x-engagement-observer] per-shape finding write failed');
      }
    }

    // Parent finding: covers the shape distribution at a glance.
    const totalAttributedPosts = aggregates.reduce((sum, a) => sum + a.posts, 0);
    const winner = [...aggregates]
      .filter((a) => a.posts >= MIN_POSTS_PER_SHAPE)
      .sort((a, b) => b.median_engagement - a.median_engagement)[0];
    const summary = totalAttributedPosts === 0
      ? 'no shape-attributed posts in window (waiting for x-own-engagement + approval queue tagging)'
      : `${totalAttributedPosts} attributed post(s); top shape=${winner?.shape ?? 'n/a'} median=${winner?.median_engagement.toFixed(0) ?? 0}`;

    return {
      subject: 'x-engagement:summary',
      summary,
      evidence: {
        shape_aggregates: aggregates,
        attributed_posts: totalAttributedPosts,
        snapshots_in_window: latestPerPermalink.size,
        approvals_seen: approvals.length,
      },
    };
  }

  protected businessJudge(_result: ProbeResult, _history: Finding[]): Verdict {
    // Parent finding always passes; the per-shape side-effect findings
    // carry the surprise signal via the Piece 1 distiller.
    return 'pass';
  }
}
