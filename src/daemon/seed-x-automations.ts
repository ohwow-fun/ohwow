/**
 * Seed the X schedulers (intel, forecast, humor) as native ohwow
 * automations so they live in the same surface users see
 * (list_automations, the cloud dashboard, the trigger watchdog) instead
 * of as hand-coded setIntervals in the daemon. LocalScheduler.
 * tickAutomationSchedules picks up the `trigger_type='schedule'` rows,
 * computes next-run from cron + last_fired_at (which persists in the
 * DB), and fires via the shell_script dispatcher.
 *
 * Every seed is idempotent — if an automation with the canonical name
 * already exists for the workspace, we leave it alone. That lets the
 * operator edit the cron / toggle steps / pause it from the dashboard
 * without the daemon clobbering their changes on next boot.
 *
 * Collectively these replace the primary XIntelScheduler family in
 * src/daemon/scheduling.ts (intel + chain + forecast + humor).
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { AutomationService, type Automation, type AutomationStep } from '../triggers/automation-service.js';
import { logger } from '../lib/logger.js';

/**
 * Decide whether a seed can refresh the existing automation's cron.
 *
 * Yes: existing.cron matches one of `refreshableFrom` — means we're
 * the cron's author (it's one of a previous generation of our own
 * defaults), so updating to the new default is safe and expected.
 *
 * No: existing.cron is different from every known default — the
 * operator edited it in the dashboard, so we leave it alone.
 *
 * Also no: existing.cron already equals the new default — nothing to
 * do.
 */
function shouldRefreshCron(
  existing: Automation,
  newCron: string,
  refreshableFrom: string[],
): boolean {
  const current = (existing.trigger_config?.cron as string | undefined) ?? '';
  if (current === newCron) return false;
  return refreshableFrom.includes(current);
}

/** Stable names used to detect + dedupe each seeded automation. */
export const X_INTEL_AUTOMATION_NAME = 'ohwow:x-intel-pipeline';
export const X_FORECAST_AUTOMATION_NAME = 'ohwow:x-forecast-scorer';
export const X_HUMOR_AUTOMATION_NAME = 'ohwow:x-humor';

export interface SeedXIntelOptions {
  /** Cron expression for the pipeline. Default: every 3 hours on the hour. */
  cron?: string;
  /** If the existing row's cron matches any of these (previous generations of
   *  our own defaults), refresh it to `cron`. Operator-edited crons survive. */
  refreshableFrom?: string[];
  /** Whether to include x-authors-to-crm as a chain step. */
  authorsToCrm?: boolean;
  /** Whether to include x-compose as a chain step. */
  compose?: boolean;
  /** Whether to include x-reply as a chain step. */
  reply?: boolean;
  /** Per-step wall-clock timeout in seconds. Default 900 (15 min). */
  timeoutSeconds?: number;
}

export interface SeedXForecastOptions {
  /** Cron expression. Default: daily at 00:30 UTC (just after x-intel midnight chain). */
  cron?: string;
  /** Prior cron defaults we'll refresh from. Operator-edited crons survive. */
  refreshableFrom?: string[];
  /** Per-step timeout in seconds. Default 900. */
  timeoutSeconds?: number;
}

export interface SeedXHumorOptions {
  /** Cron expression. Default: hourly at :20 (offset from x-intel). */
  cron?: string;
  /** Prior cron defaults we'll refresh from. Operator-edited crons survive. */
  refreshableFrom?: string[];
  /** Per-step timeout in seconds. Default 900. */
  timeoutSeconds?: number;
}

/**
 * Idempotently seed the X Intelligence pipeline automation. Returns the
 * automation id (existing or newly created) or null if the seed was
 * skipped for any reason.
 */
export async function seedXIntelAutomation(
  db: DatabaseAdapter,
  workspaceId: string,
  opts: SeedXIntelOptions = {},
): Promise<string | null> {
  const service = new AutomationService(db, workspaceId);
  const cron = opts.cron ?? '0 */3 * * *';
  const timeoutSeconds = opts.timeoutSeconds ?? 900;
  const existing = (await service.list()).find((a) => a.name === X_INTEL_AUTOMATION_NAME);
  if (existing) {
    if (shouldRefreshCron(existing, cron, opts.refreshableFrom ?? [])) {
      await service.update(existing.id, { trigger_config: { cron } });
      logger.info(
        { automationId: existing.id, cron },
        '[seed-x-intel] refreshed cron from prior default',
      );
    } else {
      logger.debug(
        { automationId: existing.id, cron: existing.trigger_config?.cron },
        '[seed-x-intel] automation already present, leaving operator edits intact',
      );
    }
    return existing.id;
  }

  const steps: AutomationStep[] = [
    {
      id: 'x_intel',
      step_type: 'shell_script',
      label: 'x-intel: scrape + classify + synthesize',
      action_config: {
        script_path: 'scripts/x-experiments/x-intel.mjs',
        timeout_seconds: timeoutSeconds,
        heartbeat_filename: 'x-intel-last-run.json',
      },
    },
  ];

  if (opts.authorsToCrm !== false) {
    steps.push({
      id: 'x_authors_to_crm',
      step_type: 'shell_script',
      label: 'x-authors-to-crm: sync authors into CRM',
      action_config: {
        script_path: 'scripts/x-experiments/x-authors-to-crm.mjs',
        timeout_seconds: timeoutSeconds,
        heartbeat_filename: 'x-authors-to-crm-last-run.json',
      },
    });
  }

  // X channel permanently banned 2026-04-19 — account suspended for automated behavior.
  // x-compose and x-reply steps are permanently excluded from new seeds regardless of
  // opts.compose / opts.reply. Existing automation rows retain whatever steps they already
  // have (idempotent early-return above). Re-enabling requires removing this guard.

  const created = await service.create({
    name: X_INTEL_AUTOMATION_NAME,
    description:
      'Scheduled X intelligence pipeline. Runs x-intel.mjs and chains x-authors-to-crm, x-compose, x-reply. Edit or pause from the automations dashboard.',
    trigger_type: 'schedule',
    trigger_config: { cron },
    steps,
    cooldown_seconds: 60,
  });

  logger.info(
    { automationId: created.id, cron, stepCount: steps.length },
    '[seed-x-intel] created automation',
  );
  return created.id;
}

/**
 * Idempotently seed the X Forecast scorer automation. Runs
 * x-forecast-scorer.mjs on its own slower cadence — read-only, judges
 * predictions emitted by x-intel and writes x-predictions-scores.jsonl.
 */
export async function seedXForecastAutomation(
  db: DatabaseAdapter,
  workspaceId: string,
  opts: SeedXForecastOptions = {},
): Promise<string | null> {
  const service = new AutomationService(db, workspaceId);
  const cron = opts.cron ?? '30 0 * * *';
  const timeoutSeconds = opts.timeoutSeconds ?? 900;
  const existing = (await service.list()).find((a) => a.name === X_FORECAST_AUTOMATION_NAME);
  if (existing) {
    if (shouldRefreshCron(existing, cron, opts.refreshableFrom ?? [])) {
      await service.update(existing.id, { trigger_config: { cron } });
      logger.info({ automationId: existing.id, cron }, '[seed-x-forecast] refreshed cron from prior default');
    } else {
      logger.debug({ automationId: existing.id }, '[seed-x-forecast] already present');
    }
    return existing.id;
  }

  const created = await service.create({
    name: X_FORECAST_AUTOMATION_NAME,
    description:
      'Scheduled X prediction forecast scorer. Read-only: judges predictions emitted by x-intel and writes x-predictions-scores.jsonl.',
    trigger_type: 'schedule',
    trigger_config: { cron },
    steps: [
      {
        id: 'x_forecast_scorer',
        step_type: 'shell_script',
        label: 'x-forecast-scorer: score predictions',
        action_config: {
          script_path: 'scripts/x-experiments/x-forecast-scorer.mjs',
          timeout_seconds: timeoutSeconds,
          heartbeat_filename: 'x-forecast-last-run.json',
        },
      },
    ],
    cooldown_seconds: 60,
  });

  logger.info({ automationId: created.id, cron }, '[seed-x-forecast] created automation');
  return created.id;
}

/**
 * Idempotently seed the X Humor automation. Runs x-compose.mjs with
 * SHAPES=humor scoping on its own hourly cadence — separate from the
 * x-intel chain because humor draws from x-intel-history rather than
 * the day's fresh sidecars.
 */
export async function seedXHumorAutomation(
  db: DatabaseAdapter,
  workspaceId: string,
  opts: SeedXHumorOptions = {},
): Promise<string | null> {
  const service = new AutomationService(db, workspaceId);
  const cron = opts.cron ?? '20 * * * *';
  const timeoutSeconds = opts.timeoutSeconds ?? 900;
  const existing = (await service.list()).find((a) => a.name === X_HUMOR_AUTOMATION_NAME);
  if (existing) {
    if (shouldRefreshCron(existing, cron, opts.refreshableFrom ?? [])) {
      await service.update(existing.id, { trigger_config: { cron } });
      logger.info({ automationId: existing.id, cron }, '[seed-x-humor] refreshed cron from prior default');
    } else {
      logger.debug({ automationId: existing.id }, '[seed-x-humor] already present');
    }
    return existing.id;
  }

  const created = await service.create({
    name: X_HUMOR_AUTOMATION_NAME,
    description:
      'Scheduled X humor composer. Drafts humor-shaped posts from x-intel history on a separate cadence from the main pipeline.',
    trigger_type: 'schedule',
    trigger_config: { cron },
    steps: [
      {
        id: 'x_humor',
        step_type: 'shell_script',
        label: 'x-compose: humor shape only',
        action_config: {
          script_path: 'scripts/x-experiments/x-compose.mjs',
          timeout_seconds: timeoutSeconds,
          heartbeat_filename: 'x-humor-last-run.json',
          env: { SHAPES: 'humor', MAX_DRAFTS: '1', DRY: '0' },
        },
      },
    ],
    cooldown_seconds: 60,
  });

  logger.info({ automationId: created.id, cron }, '[seed-x-humor] created automation');
  return created.id;
}
