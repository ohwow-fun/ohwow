/**
 * Seed the X Intelligence pipeline as a native ohwow automation so it
 * lives in the same surface users see (list_automations, the cloud
 * dashboard, the trigger watchdog) instead of as a hand-coded setInterval
 * in the daemon. LocalScheduler.tickAutomationSchedules then picks up
 * the `trigger_type='schedule'` row, computes next-run from cron +
 * last_fired_at (which persists in the DB), and fires via the
 * shell_script dispatcher.
 *
 * This is idempotent — if an automation named `ohwow:x-intel-pipeline`
 * already exists for the workspace, we leave it alone. That lets the
 * operator edit the cron / toggle steps / pause it from the dashboard
 * without the daemon clobbering their changes on next boot.
 *
 * Scope: replaces the primary XIntelScheduler instantiation + its chain
 * steps (x-authors-to-crm, x-compose, x-reply) from
 * src/daemon/scheduling.ts. XForecast and XHumor still run as hand-coded
 * schedulers for now — their cadences and env shapes differ enough that
 * migrating them is a separate pass (same pattern, different seed).
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { AutomationService, type AutomationStep } from '../triggers/automation-service.js';
import { logger } from '../lib/logger.js';

/** Stable name used to detect + dedupe the seeded automation. */
export const X_INTEL_AUTOMATION_NAME = 'ohwow:x-intel-pipeline';

export interface SeedXIntelOptions {
  /** Cron expression for the pipeline. Default: every 3 hours on the hour. */
  cron?: string;
  /** Whether to include x-authors-to-crm as a chain step. */
  authorsToCrm?: boolean;
  /** Whether to include x-compose as a chain step. */
  compose?: boolean;
  /** Whether to include x-reply as a chain step. */
  reply?: boolean;
  /** Per-step wall-clock timeout in seconds. Default 900 (15 min) — same as the old XIntelScheduler. */
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
  const existing = (await service.list()).find((a) => a.name === X_INTEL_AUTOMATION_NAME);
  if (existing) {
    logger.debug(
      { automationId: existing.id, cron: existing.trigger_config?.cron },
      '[seed-x-intel] automation already present, leaving operator edits intact',
    );
    return existing.id;
  }

  const cron = opts.cron ?? '0 */3 * * *';
  const timeoutSeconds = opts.timeoutSeconds ?? 900;

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

  if (opts.compose !== false) {
    steps.push({
      id: 'x_compose',
      step_type: 'shell_script',
      label: 'x-compose: draft posts from fresh sidecars',
      action_config: {
        script_path: 'scripts/x-experiments/x-compose.mjs',
        timeout_seconds: timeoutSeconds,
        heartbeat_filename: 'x-compose-last-run.json',
        env: { DRY: '0' },
      },
    });
  }

  if (opts.reply !== false) {
    steps.push({
      id: 'x_reply',
      step_type: 'shell_script',
      label: 'x-reply: draft replies to inbound posts',
      action_config: {
        script_path: 'scripts/x-experiments/x-reply.mjs',
        timeout_seconds: timeoutSeconds,
        heartbeat_filename: 'x-reply-last-run.json',
        env: { DRY: '0' },
      },
    });
  }

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
