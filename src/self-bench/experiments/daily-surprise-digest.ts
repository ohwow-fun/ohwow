/**
 * DailySurpriseDigestExperiment — Piece 6 of the surprise-first bundle.
 *
 * One narrative finding per day. The operator opens ohwow_list_findings
 * with category='digest' (or eventually a dashboard card) and reads a
 * <60-second summary of what the system noticed and what's most worth
 * acting on.
 *
 * Inputs:
 *   - listDistilledInsights() — top-K surprises ranked by novelty_score
 *   - strategy.* runtime_config overrides (set by the strategist,
 *     revenue-pipeline-observer, roadmap-observer, etc.)
 *   - Latest revenue-pipeline-observer finding for the money line
 *
 * Output: one self_findings row with subject='digest:YYYY-MM-DD' and
 * a narrative summary. Evidence carries the source finding ids so a
 * click-through from the dashboard (when that surface ships) can jump
 * back to the raw rows.
 *
 * Cadence: once per day, runOnBoot=true. The probe's inner guard
 * (same-day dedupe against the latest prior finding) makes boot-time
 * re-entry safe — repeated boots within one day emit a lightweight
 * "already_ran_today" skip row, not a full digest. Previously
 * runOnBoot was false for flood-safety, but that combined with the
 * 24h cadence meant a never-run digest waited a full day from daemon
 * boot before first firing; on a machine where the daemon rarely
 * survives 24h, that's a permanent zero-digest state. The inner
 * guard is the real flood-safety; the boot flag just determines
 * whether today's digest lands promptly or waits out the cadence.
 */

import { logger } from '../../lib/logger.js';
import type {
  Experiment,
  ExperimentCadence,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { listFindings } from '../findings-store.js';
import { listDistilledInsights } from '../insight-distiller.js';
import { getRuntimeConfigCacheSnapshot } from '../runtime-config.js';

const CADENCE: ExperimentCadence = { everyMs: 24 * 60 * 60 * 1000, runOnBoot: true };
const TOP_K_INSIGHTS = 10;

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function strategyHighlights(): Array<{ key: string; value: unknown; set_by: string | null }> {
  try {
    const snap = getRuntimeConfigCacheSnapshot();
    return snap
      .filter((row) => row.key.startsWith('strategy.'))
      .map((row) => ({ key: row.key, value: row.value, set_by: row.setBy ?? null }));
  } catch (err) {
    logger.debug({ err }, '[daily-surprise-digest] runtime config snapshot failed');
    return [];
  }
}

export interface DailyDigestEvidence extends Record<string, unknown> {
  date: string;
  insight_count: number;
  top_insights: Array<{
    experiment_id: string;
    subject: string;
    novelty_score: number;
    novelty_reason: string;
    summary: string;
    finding_id: string;
  }>;
  revenue_focus: string | null;
  strategy_overrides: Array<{ key: string; value: unknown; set_by: string | null }>;
}

export class DailySurpriseDigestExperiment implements Experiment {
  readonly id = 'daily-surprise-digest';
  readonly name = 'Daily surprise digest';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'The operator gets a single daily narrative finding that combines the top-K distilled insights with current strategy overrides and the revenue focus line. Reading this in under a minute should answer "what should I look at first today?".';
  readonly cadence = CADENCE;

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const today = todayKey();

    // Gate: if a digest already ran today, return a lightweight pass.
    const prior = await listFindings(ctx.db, {
      experimentId: this.id,
      limit: 1,
    });
    const latestRanAt = prior[0]?.ranAt;
    if (latestRanAt && latestRanAt.startsWith(today)) {
      return {
        subject: `digest:${today}`,
        summary: `digest already landed at ${latestRanAt}`,
        evidence: { skipped: true, reason: 'already_ran_today' },
      };
    }

    const insights = await listDistilledInsights(ctx.db, { limit: TOP_K_INSIGHTS });
    const overrides = strategyHighlights();
    const revenueFocus = overrides.find((o) => o.key === 'strategy.revenue_gap_focus');
    const revenueFocusText = typeof revenueFocus?.value === 'string' ? revenueFocus.value : null;

    const topInsights = insights.map((i) => ({
      experiment_id: i.experiment_id,
      subject: i.subject,
      novelty_score: i.novelty_score,
      novelty_reason: i.novelty_reason,
      summary: i.summary,
      finding_id: i.latest_finding_id,
    }));

    const narrativeLines: string[] = [`Today the system noticed (${today}):`];
    if (revenueFocusText) {
      narrativeLines.push(`  Revenue focus: ${revenueFocusText}`);
    }
    if (topInsights.length === 0) {
      narrativeLines.push('  Nothing unusual — baselines are boring.');
    } else {
      narrativeLines.push('  Top surprises:');
      for (const i of topInsights.slice(0, 5)) {
        const score = i.novelty_score.toFixed(2);
        narrativeLines.push(`    [${score}] ${i.experiment_id} / ${i.subject}: ${i.summary} (${i.novelty_reason})`);
      }
    }
    if (overrides.length > 0) {
      narrativeLines.push(`  Active strategy: ${overrides.map((o) => o.key.replace('strategy.', '')).join(', ')}`);
    }

    const summary = narrativeLines.join('\n');

    const evidence: DailyDigestEvidence = {
      date: today,
      insight_count: topInsights.length,
      top_insights: topInsights,
      revenue_focus: revenueFocusText,
      strategy_overrides: overrides,
    };

    return { subject: `digest:${today}`, summary, evidence };
  }

  judge(_result: ProbeResult, _history: Finding[]): Verdict {
    // The digest is informational. Always passes; the narrative IS the
    // value, and we don't want it polluting the warning/fail stream
    // that the reactive reschedule reacts to.
    return 'pass';
  }
}
