import type { DatabaseAdapter } from '../db/adapter-types.js';
import type {
  MetricName,
  SetPoint,
  AllostasisEvent,
  HomeostasisState,
} from './types.js';
import { initializeSetPoints, updateSetPoint, adaptSetPoint } from './set-points.js';
import { computeAllCorrectiveActions } from './feedback-loops.js';
import { logger } from '../lib/logger.js';

/**
 * Pressure ratio: (runtime cost today) / (daily revenue equivalent).
 *  - Returns 0 when MRR is absent or zero: no meaningful comparison.
 *  - Returns 0 when cost is absent.
 *  - Clamped at 5.0 so a runaway cost doesn't break downstream math.
 */
export function computeRevenueVsBurnRatio(
  mrrCents: number | null | undefined,
  dailyCostCents: number | null | undefined,
): number {
  if (!mrrCents || mrrCents <= 0) return 0;
  if (!dailyCostCents || dailyCostCents <= 0) return 0;
  const dailyRevenueCents = mrrCents / 30;
  const ratio = dailyCostCents / dailyRevenueCents;
  return Math.min(5, ratio);
}

export class HomeostasisController {
  private setPoints: SetPoint[];
  private lastAllostasisCheck: number;
  private deviationHistory: Map<MetricName, number[]> = new Map();

  constructor(
    private db: DatabaseAdapter | null,
    private workspaceId: string,
  ) {
    this.setPoints = initializeSetPoints();
    this.lastAllostasisCheck = Date.now();
  }

  /**
   * Update a specific metric's current value and recompute error signal.
   */
  updateMetric(metric: MetricName, currentValue: number): void {
    const idx = this.setPoints.findIndex(sp => sp.metric === metric);
    if (idx === -1) return;

    this.setPoints[idx] = updateSetPoint(this.setPoints[idx], currentValue);

    // Track deviation history for allostasis
    const history = this.deviationHistory.get(metric) ?? [];
    history.push(this.setPoints[idx].deviationMagnitude);
    if (history.length > 30) history.shift(); // keep last 30 readings
    this.deviationHistory.set(metric, history);
  }

  /**
   * Check all set points and return corrective actions.
   */
  check(): HomeostasisState {
    const actions = computeAllCorrectiveActions(this.setPoints);
    const overallDeviation = this.setPoints.length > 0
      ? this.setPoints.reduce((sum, sp) => sum + sp.deviationMagnitude, 0) / this.setPoints.length
      : 0;

    return {
      setPoints: [...this.setPoints],
      overallDeviation: Math.min(1, overallDeviation),
      correctiveActions: actions,
      lastChecked: Date.now(),
    };
  }

  /**
   * Run allostatic adaptation: shift set points when deviations are persistent.
   * Should be called periodically (e.g., weekly or on growth stage change).
   */
  async runAllostasis(): Promise<AllostasisEvent[]> {
    const events: AllostasisEvent[] = [];
    const now = Date.now();

    for (let i = 0; i < this.setPoints.length; i++) {
      const sp = this.setPoints[i];
      const history = this.deviationHistory.get(sp.metric) ?? [];

      // Need at least 10 data points to detect persistent deviation
      if (history.length < 10) continue;

      // Check if deviation has been consistently in one direction
      const avgDeviation = history.reduce((s, v) => s + v, 0) / history.length;
      const persistentDeviation = avgDeviation > sp.tolerance;

      if (persistentDeviation) {
        const oldTarget = sp.target;
        this.setPoints[i] = adaptSetPoint(sp, true);
        const newTarget = this.setPoints[i].target;

        if (Math.abs(newTarget - oldTarget) > 0.01) {
          const event: AllostasisEvent = {
            metric: sp.metric,
            oldTarget,
            newTarget,
            reason: `Persistent deviation (avg magnitude: ${avgDeviation.toFixed(2)}) for ${history.length} readings`,
            timestamp: new Date().toISOString(),
          };
          events.push(event);
          await this.persistAllostasisEvent(event);
          logger.info({ metric: sp.metric, oldTarget, newTarget }, 'homeostasis: allostatic adaptation');
        }
      }
    }

    this.lastAllostasisCheck = now;
    return events;
  }

  /**
   * Read the most recent `business_vitals` row for this workspace and
   * update the `revenue_vs_burn` metric. The ratio is
   *   daily_cost_cents / (mrr / 30)
   * which collapses to 0 when there is no revenue row to compare
   * against (safe default — early-stage workspaces don't want a cost
   * alarm firing purely from the absence of MRR).
   *
   * Called from a scheduler tick; errors are logged, not thrown, so
   * the controller stays up if the table hasn't been created yet.
   */
  async refreshBusinessVitals(): Promise<void> {
    if (!this.db) return;
    try {
      const { data } = await this.db
        .from<{ mrr: number | null; daily_cost_cents: number | null }>('business_vitals')
        .select('mrr, daily_cost_cents')
        .eq('workspace_id', this.workspaceId)
        .order('ts', { ascending: false })
        .limit(1);
      const row = (data ?? [])[0];
      if (!row) return;
      const ratio = computeRevenueVsBurnRatio(row.mrr, row.daily_cost_cents);
      this.updateMetric('revenue_vs_burn', ratio);
    } catch (err) {
      logger.warn({ err }, 'homeostasis: failed to refresh business vitals');
    }
  }

  /** Get current state of a specific metric */
  getSetPoint(metric: MetricName): SetPoint | undefined {
    return this.setPoints.find(sp => sp.metric === metric);
  }

  /** Get overall deviation magnitude */
  getOverallDeviation(): number {
    return this.setPoints.length > 0
      ? this.setPoints.reduce((sum, sp) => sum + sp.deviationMagnitude, 0) / this.setPoints.length
      : 0;
  }

  /**
   * Build prompt injection text for self-regulation awareness.
   * Returns null if all metrics are within tolerance.
   */
  buildPromptContext(): string | null {
    const state = this.check();

    if (state.correctiveActions.length === 0) return null;

    const lines = state.correctiveActions.slice(0, 3).map(a =>
      `${a.metric}: ${a.reason} (urgency: ${(a.urgency * 100).toFixed(0)}%)`
    );

    return `Active corrective actions:\n${lines.join('\n')}`;
  }

  /** Load persisted set points from database */
  async loadSetPoints(): Promise<void> {
    if (!this.db) return;

    try {
      const { data } = await this.db
        .from('homeostasis_set_points')
        .select('*')
        .eq('workspace_id', this.workspaceId);

      if (data && data.length > 0) {
        for (const row of data as Record<string, unknown>[]) {
          const idx = this.setPoints.findIndex(sp => sp.metric === row.metric);
          if (idx !== -1) {
            this.setPoints[idx].target = row.target as number;
            this.setPoints[idx].tolerance = row.tolerance as number;
            this.setPoints[idx].adaptationRate = row.adaptation_rate as number;
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'homeostasis: failed to load set points');
    }
  }

  /** Persist current set points to database */
  async persistSetPoints(): Promise<void> {
    if (!this.db) return;

    try {
      for (const sp of this.setPoints) {
        // Upsert: try insert, on conflict update
        try {
          await this.db.from('homeostasis_set_points').insert({
            workspace_id: this.workspaceId,
            metric: sp.metric,
            target: sp.target,
            tolerance: sp.tolerance,
            adaptation_rate: sp.adaptationRate,
          });
        } catch {
          await this.db.from('homeostasis_set_points')
            .update({
              target: sp.target,
              tolerance: sp.tolerance,
              adaptation_rate: sp.adaptationRate,
              updated_at: new Date().toISOString(),
            })
            .eq('workspace_id', this.workspaceId)
            .eq('metric', sp.metric);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'homeostasis: failed to persist set points');
    }
  }

  /** Persist an allostasis event */
  private async persistAllostasisEvent(event: AllostasisEvent): Promise<void> {
    if (!this.db) return;

    try {
      await this.db.from('allostasis_events').insert({
        workspace_id: this.workspaceId,
        metric: event.metric,
        old_target: event.oldTarget,
        new_target: event.newTarget,
        reason: event.reason,
      });
    } catch (err) {
      logger.warn({ err }, 'homeostasis: failed to persist allostasis event');
    }
  }
}
