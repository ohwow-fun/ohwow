/**
 * Seed the in-process content automations (x-draft-distiller,
 * content-cadence) as native ohwow automations. LocalScheduler drives
 * them via tickAutomationSchedules; the run_internal dispatcher resolves
 * the handler by name and calls the in-process tick method registered
 * at daemon boot.
 *
 * Idempotent: if an automation with the canonical name already exists
 * we leave it alone so operator edits survive boots.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { AutomationService, type Automation } from '../triggers/automation-service.js';
import { logger } from '../lib/logger.js';

export const X_DRAFT_DISTILLER_AUTOMATION_NAME = 'ohwow:x-draft-distiller';
export const CONTENT_CADENCE_AUTOMATION_NAME = 'ohwow:content-cadence';

/** Canonical handler names registered on daemon boot. */
export const X_DRAFT_DISTILLER_HANDLER = 'x-draft-distiller:tick';
export const CONTENT_CADENCE_HANDLER = 'content-cadence:tick';

/** Prior cron defaults we'll refresh from. See shouldRefreshCron below. */
const X_DRAFT_DISTILLER_PRIOR_DEFAULTS = ['0 * * * *'];
const CONTENT_CADENCE_PRIOR_DEFAULTS = ['*/15 * * * *'];

export interface SeedSimpleAutomationOptions {
  cron?: string;
  /** If the existing row's cron matches any of these (previous generations of
   *  our own defaults), refresh it. Operator-edited crons survive. */
  refreshableFrom?: string[];
  cooldownSeconds?: number;
}

function shouldRefreshCron(
  existing: Automation,
  newCron: string,
  refreshableFrom: string[],
): boolean {
  const current = (existing.trigger_config?.cron as string | undefined) ?? '';
  if (current === newCron) return false;
  return refreshableFrom.includes(current);
}

/**
 * Idempotently seed the X draft distiller automation. Fires every hour
 * and calls the in-process x-draft-distiller:tick handler.
 */
export async function seedXDraftDistillerAutomation(
  db: DatabaseAdapter,
  workspaceId: string,
  opts: SeedSimpleAutomationOptions = {},
): Promise<string | null> {
  const service = new AutomationService(db, workspaceId);
  const cron = opts.cron ?? '45 * * * *';
  const refreshableFrom = opts.refreshableFrom ?? X_DRAFT_DISTILLER_PRIOR_DEFAULTS;
  const existing = (await service.list()).find(
    (a) => a.name === X_DRAFT_DISTILLER_AUTOMATION_NAME,
  );
  if (existing) {
    if (shouldRefreshCron(existing, cron, refreshableFrom)) {
      await service.update(existing.id, { trigger_config: { cron } });
      logger.info({ automationId: existing.id, cron }, '[seed-x-draft-distiller] refreshed cron from prior default');
    } else {
      logger.debug({ automationId: existing.id }, '[seed-x-draft-distiller] already present');
    }
    return existing.id;
  }
  const created = await service.create({
    name: X_DRAFT_DISTILLER_AUTOMATION_NAME,
    description:
      'Market-radar distiller. Turns novel market:* findings (from scrape-diff probes) into candidate X posts in x_post_drafts, awaiting operator approval.',
    trigger_type: 'schedule',
    trigger_config: { cron },
    steps: [
      {
        id: 'distill',
        step_type: 'run_internal',
        label: 'x-draft-distiller: insights → pending drafts',
        action_config: { handler_name: X_DRAFT_DISTILLER_HANDLER },
      },
    ],
    cooldown_seconds: opts.cooldownSeconds ?? 60,
  });
  logger.info({ automationId: created.id, cron }, '[seed-x-draft-distiller] created automation');
  return created.id;
}

/**
 * Idempotently seed the content cadence automation. Fires every 15 min
 * and calls the in-process content-cadence:tick handler, which checks
 * daily budgets + cooldowns and dispatches a post task if clear.
 */
export async function seedContentCadenceAutomation(
  db: DatabaseAdapter,
  workspaceId: string,
  opts: SeedSimpleAutomationOptions = {},
): Promise<string | null> {
  const service = new AutomationService(db, workspaceId);
  const cron = opts.cron ?? '7,22,37,52 * * * *';
  const refreshableFrom = opts.refreshableFrom ?? CONTENT_CADENCE_PRIOR_DEFAULTS;
  const existing = (await service.list()).find(
    (a) => a.name === CONTENT_CADENCE_AUTOMATION_NAME,
  );
  if (existing) {
    if (shouldRefreshCron(existing, cron, refreshableFrom)) {
      await service.update(existing.id, { trigger_config: { cron } });
      logger.info({ automationId: existing.id, cron }, '[seed-content-cadence] refreshed cron from prior default');
    } else {
      logger.debug({ automationId: existing.id }, '[seed-content-cadence] already present');
    }
    return existing.id;
  }
  const created = await service.create({
    name: CONTENT_CADENCE_AUTOMATION_NAME,
    description:
      'Multi-platform content posting cadence. Every 15 min: reads posts_per_day, checks cooldown + budget, dispatches a post task if clear. Approved-draft bypass reads x-approvals.jsonl.',
    trigger_type: 'schedule',
    trigger_config: { cron },
    steps: [
      {
        id: 'cadence',
        step_type: 'run_internal',
        label: 'content-cadence: budget + cooldown + dispatch',
        action_config: { handler_name: CONTENT_CADENCE_HANDLER },
      },
    ],
    cooldown_seconds: opts.cooldownSeconds ?? 60,
  });
  logger.info({ automationId: created.id, cron }, '[seed-content-cadence] created automation');
  return created.id;
}
