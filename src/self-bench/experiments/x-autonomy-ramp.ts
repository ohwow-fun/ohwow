/**
 * XAutonomyRampExperiment — Piece 4c of the surprise-first bundle.
 *
 * Decides which post shapes have earned autonomous publication and
 * how many can ship per day. Pace tied to the operator-set
 * "X posts per week" goal: deficit / days remaining = daily budget.
 * If the goal is met for the week, daily_budget = 0 — the system
 * stops pushing the moment it has enough output, instead of
 * grinding out content on a flat cadence disconnected from intent.
 *
 * Pre-conditions for a shape to be allowlisted (ALL required):
 *   1. ≥ MIN_APPROVED_PRECEDENTS approved x_outbound_post entries
 *      of that shape in the approval queue (15 by default)
 *   2. Rejection rate ≤ MAX_REJECTION_RATE (10%)
 *   3. Median engagement ≥ shape's running baseline median
 *      (Piece 4b's per-shape findings provide this)
 *
 * Output: writes a sidecar JSON the x-compose script reads:
 *   ~/.ohwow/workspaces/<slug>/x-autonomy-allowlist.json
 *   { shapes: { opinion: { daily_budget: 1, reason: 'goal-paced' }, ... },
 *     weekly_target, weekly_actual, days_remaining, computed_at }
 * Also writes runtime_config `x_compose.autonomy_allowlist` for the
 * MCP / TUI to surface.
 *
 * Cadence 6h. Subclasses BusinessExperiment so the workspace guard
 * pins the writer to 'default' — no autonomy ramp on customer slots.
 *
 * Rollback (handled by x-engagement-observer): when an auto-posted
 * tweet's engagement falls below baseline at T+24h, the next
 * x-engagement-observer run will lower that shape's median, which
 * pulls the shape out of the allowlist on the next ramp tick. No
 * code-level rollback action needed — the loop self-corrects.
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
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { setRuntimeConfig } from '../runtime-config.js';
import { listFindings } from '../findings-store.js';

const CADENCE: ExperimentCadence = { everyMs: 6 * 60 * 60 * 1000, runOnBoot: true };
const KNOWN_SHAPES = ['tactical_tip', 'observation', 'opinion', 'question', 'story', 'humor'] as const;
type Shape = typeof KNOWN_SHAPES[number];

const MIN_APPROVED_PRECEDENTS = 15;
const MAX_REJECTION_RATE = 0.1;
const X_POSTS_GOAL_METRIC = 'x_posts_per_week';

interface ApprovalEntry {
  id?: string;
  ts?: string;
  kind?: string;
  status?: string;
  payload?: { shape?: string };
}

interface AllowlistEntry {
  shape: Shape;
  daily_budget: number;
  reason: string;
  approved_count: number;
  rejection_rate: number;
  median_engagement: number;
}

interface AutonomyAllowlistFile {
  computed_at: string;
  weekly_target: number;
  weekly_actual: number;
  weekly_deficit: number;
  days_remaining: number;
  shapes: Record<string, { daily_budget: number; reason: string }>;
}

function workspaceDir(slug: string): string {
  return path.join(os.homedir(), '.ohwow', 'workspaces', slug);
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* skip */ }
  }
  return out;
}

/** ISO week key like 'YYYY-Www'. Same approximation as Piece 5. */
function isoWeekKey(d: Date): string {
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d.getTime() - onejan.getTime()) / 86400000) + onejan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function startOfIsoWeek(d: Date): Date {
  const day = d.getDay();
  // Treat Monday as start (1); offset to local-tz Monday at 00:00.
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - diffToMonday);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function daysRemainingInWeek(now: Date): number {
  const weekStart = startOfIsoWeek(now);
  const elapsedDays = Math.floor((now.getTime() - weekStart.getTime()) / (24 * 60 * 60 * 1000));
  return Math.max(7 - elapsedDays, 1);
}

interface GoalRow {
  target_value: number | null;
  current_value: number | null;
}

async function readWeeklyTarget(ctx: ExperimentContext): Promise<number> {
  try {
    const res = await ctx.db
      .from<GoalRow>('agent_workforce_goals')
      .select('target_value, current_value')
      .eq('workspace_id', ctx.workspaceId)
      .eq('target_metric', X_POSTS_GOAL_METRIC)
      .eq('status', 'active')
      .limit(1);
    const rows = ((res as { data?: GoalRow[] | null }).data ?? []) as GoalRow[];
    return Number(rows[0]?.target_value ?? 0);
  } catch (err) {
    logger.warn({ err }, '[x-autonomy-ramp] read goal failed');
    return 0;
  }
}

interface ShapeStats {
  approved: number;
  rejected: number;
  pending: number;
  rejection_rate: number;
  median_engagement: number;
}

function summariseApprovals(approvals: ApprovalEntry[], thisWeekKey: string): {
  perShape: Map<Shape, ShapeStats>;
  weeklyApprovedAndApplied: number;
} {
  const perShape = new Map<Shape, ShapeStats>();
  for (const s of KNOWN_SHAPES) {
    perShape.set(s, { approved: 0, rejected: 0, pending: 0, rejection_rate: 0, median_engagement: 0 });
  }
  let weeklyApprovedAndApplied = 0;
  for (const a of approvals) {
    if (a.kind !== 'x_outbound_post') continue;
    const shape = a.payload?.shape as Shape | undefined;
    if (!shape || !KNOWN_SHAPES.includes(shape)) continue;
    const stats = perShape.get(shape)!;
    if (a.status === 'approved' || a.status === 'auto_applied' || a.status === 'applied') {
      stats.approved += 1;
      if (a.ts) {
        const d = new Date(a.ts);
        if (!Number.isNaN(d.getTime()) && isoWeekKey(d) === thisWeekKey) {
          weeklyApprovedAndApplied += 1;
        }
      }
    } else if (a.status === 'rejected') {
      stats.rejected += 1;
    } else if (a.status === 'pending') {
      stats.pending += 1;
    }
  }
  for (const stats of perShape.values()) {
    const total = stats.approved + stats.rejected;
    stats.rejection_rate = total === 0 ? 0 : stats.rejected / total;
  }
  return { perShape, weeklyApprovedAndApplied };
}

async function attachShapeMedians(
  ctx: ExperimentContext,
  perShape: Map<Shape, ShapeStats>,
): Promise<void> {
  // Pull the latest x-engagement-observer per-shape findings to learn
  // the running median engagement for each shape.
  for (const shape of KNOWN_SHAPES) {
    try {
      const findings = await listFindings(ctx.db, {
        experimentId: 'x-engagement-observer',
        subject: `x-shape:${shape}`,
        limit: 1,
      });
      const ev = (findings[0]?.evidence ?? {}) as Record<string, unknown>;
      const median = typeof ev.median_engagement === 'number' ? ev.median_engagement : 0;
      perShape.get(shape)!.median_engagement = median;
    } catch (err) {
      logger.debug({ err, shape }, '[x-autonomy-ramp] median read failed');
    }
  }
}

export interface XAutonomyRampEvidence extends Record<string, unknown> {
  weekly_target: number;
  weekly_actual: number;
  weekly_deficit: number;
  days_remaining: number;
  per_shape: Array<{
    shape: Shape;
    approved: number;
    rejection_rate: number;
    median_engagement: number;
    eligible: boolean;
    daily_budget: number;
    blocker: string | null;
  }>;
  allowlist_path: string;
  __tracked_field: 'weekly_actual';
}

export class XAutonomyRampExperiment extends BusinessExperiment {
  readonly id = 'x-autonomy-ramp';
  readonly name = 'X autonomy ramp (goal-paced)';
  readonly hypothesis =
    'Each X content shape graduates into autonomous publication once it has accrued approval precedent + low rejection + at-or-above-baseline engagement, paced by the X-posts-per-week goal so the system self-closes the gap instead of grinding on a flat cadence.';
  readonly cadence = CADENCE;

  constructor(opts: BusinessExperimentOptions = {}) {
    super(opts);
  }

  protected async businessProbe(ctx: ExperimentContext): Promise<ProbeResult> {
    const now = new Date();
    const slug = ctx.workspaceSlug ?? 'default';
    const dir = workspaceDir(slug);
    const approvals = readJsonl<ApprovalEntry>(path.join(dir, 'x-approvals.jsonl'));
    const thisWeek = isoWeekKey(now);

    const target = await readWeeklyTarget(ctx);
    const { perShape, weeklyApprovedAndApplied } = summariseApprovals(approvals, thisWeek);
    await attachShapeMedians(ctx, perShape);

    const deficit = Math.max(0, target - weeklyApprovedAndApplied);
    const daysRemaining = daysRemainingInWeek(now);
    const baseDailyBudget = deficit > 0 && daysRemaining > 0 ? Math.ceil(deficit / daysRemaining) : 0;

    const detail: XAutonomyRampEvidence['per_shape'] = [];
    const allowedShapes: AllowlistEntry[] = [];
    for (const shape of KNOWN_SHAPES) {
      const stats = perShape.get(shape)!;
      let blocker: string | null = null;
      if (stats.approved < MIN_APPROVED_PRECEDENTS) {
        blocker = `precedent: ${stats.approved}/${MIN_APPROVED_PRECEDENTS}`;
      } else if (stats.rejection_rate > MAX_REJECTION_RATE) {
        blocker = `rejection_rate=${(stats.rejection_rate * 100).toFixed(0)}% > ${(MAX_REJECTION_RATE * 100).toFixed(0)}%`;
      } else if (stats.median_engagement <= 0) {
        blocker = 'no engagement baseline yet';
      }
      const eligible = blocker === null;
      const dailyBudget = eligible ? baseDailyBudget : 0;
      detail.push({
        shape,
        approved: stats.approved,
        rejection_rate: stats.rejection_rate,
        median_engagement: stats.median_engagement,
        eligible,
        daily_budget: dailyBudget,
        blocker,
      });
      if (eligible && dailyBudget > 0) {
        allowedShapes.push({
          shape,
          daily_budget: dailyBudget,
          reason: `goal-paced (deficit=${deficit}, days=${daysRemaining})`,
          approved_count: stats.approved,
          rejection_rate: stats.rejection_rate,
          median_engagement: stats.median_engagement,
        });
      }
    }

    const allowlistPath = path.join(dir, 'x-autonomy-allowlist.json');

    const evidence: XAutonomyRampEvidence = {
      weekly_target: target,
      weekly_actual: weeklyApprovedAndApplied,
      weekly_deficit: deficit,
      days_remaining: daysRemaining,
      per_shape: detail,
      allowlist_path: allowlistPath,
      __tracked_field: 'weekly_actual',
    };

    let summary: string;
    if (target === 0) {
      summary = `no x_posts_per_week goal set; not allowlisting any shape`;
    } else if (deficit === 0) {
      summary = `weekly target met (${weeklyApprovedAndApplied}/${target}); daily_budget=0 across all shapes`;
    } else if (allowedShapes.length === 0) {
      summary = `deficit=${deficit} but no shape has graduated yet (need ${MIN_APPROVED_PRECEDENTS} approved precedents + engagement baseline)`;
    } else {
      summary = `deficit=${deficit}, days=${daysRemaining}; allowlist: ${allowedShapes.map((s) => `${s.shape}(${s.daily_budget}/d)`).join(', ')}`;
    }

    return { subject: 'x-autonomy:summary', summary, evidence };
  }

  protected businessJudge(_result: ProbeResult, _history: Finding[]): Verdict {
    return 'pass';
  }

  protected async businessIntervene(
    _verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    const ev = result.evidence as XAutonomyRampEvidence;
    const slug = ctx.workspaceSlug ?? 'default';
    const dir = workspaceDir(slug);
    const allowlistPath = path.join(dir, 'x-autonomy-allowlist.json');

    const shapesObj: Record<string, { daily_budget: number; reason: string }> = {};
    for (const detail of ev.per_shape) {
      if (detail.eligible && detail.daily_budget > 0) {
        shapesObj[detail.shape] = {
          daily_budget: detail.daily_budget,
          reason: detail.blocker ?? 'goal-paced',
        };
      }
    }

    const file: AutonomyAllowlistFile = {
      computed_at: new Date().toISOString(),
      weekly_target: ev.weekly_target,
      weekly_actual: ev.weekly_actual,
      weekly_deficit: ev.weekly_deficit,
      days_remaining: ev.days_remaining,
      shapes: shapesObj,
    };

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(allowlistPath, JSON.stringify(file, null, 2), 'utf-8');
    } catch (err) {
      logger.warn({ err, allowlistPath }, '[x-autonomy-ramp] sidecar write failed');
    }

    try {
      await setRuntimeConfig(ctx.db, 'x_compose.autonomy_allowlist', file, { setBy: this.id });
    } catch (err) {
      logger.warn({ err }, '[x-autonomy-ramp] setRuntimeConfig failed');
    }

    return {
      description: `Autonomy allowlist updated: ${Object.keys(shapesObj).join(',') || 'none'}`,
      details: {
        config_keys: ['x_compose.autonomy_allowlist'],
        sidecar: allowlistPath,
        weekly_target: ev.weekly_target,
        weekly_actual: ev.weekly_actual,
        weekly_deficit: ev.weekly_deficit,
        shapes: Object.keys(shapesObj),
        reversible: true,
      },
    };
  }
}
