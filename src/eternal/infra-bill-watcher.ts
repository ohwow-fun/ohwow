/**
 * Eternal Systems — infrastructure bill watcher.
 *
 * Scans registered infrastructure bills and surfaces any that haven't
 * been confirmed recently. Bills on auto-pay get a longer grace window
 * than manual-pay bills (which need active confirmation).
 *
 * Confirmation thresholds:
 *   monthly  + manual auto-pay=0: alert if not confirmed in 35 days
 *   monthly  + auto_pay=1:        alert if not confirmed in 40 days
 *   annual   + manual:            alert if not confirmed in 400 days
 *   annual   + auto_pay=1:        alert if not confirmed in 400 days
 *   one-time + any:               alert if not confirmed within 7 days of created_at
 *
 * Runs weekly via the daemon scheduler.
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { writeFounderQuestion } from '../autonomy/director-persistence.js';

const MS_PER_DAY = 86_400_000;

interface InfraBillRow {
  id: string;
  service_name: string;
  category: string;
  amount_cents: number;
  billing_cycle: string;
  auto_pay: number;
  last_confirmed_at: string | null;
  created_at: string;
}

interface InboxRow {
  id: string;
  context: string;
  status: string;
}

/**
 * Compute confirmation threshold in days for a bill.
 */
export function confirmationThresholdDays(billing_cycle: string, auto_pay: number): number {
  if (billing_cycle === 'one-time') return 7;
  if (billing_cycle === 'annual') return 400;
  // monthly
  return auto_pay ? 40 : 35;
}

export async function checkInfraBills(
  db: DatabaseAdapter,
  workspaceId: string,
): Promise<number> {
  // Load all bills
  const { data: rawBills } = await db
    .from<InfraBillRow>('infrastructure_bills')
    .select('id,service_name,category,amount_cents,billing_cycle,auto_pay,last_confirmed_at,created_at')
    .eq('workspace_id', workspaceId);

  const bills = (rawBills ?? []) as InfraBillRow[];
  if (bills.length === 0) return 0;

  // Load existing open alerts to dedupe
  const { data: rawInbox } = await db
    .from<InboxRow>('founder_inbox')
    .select('id,context,status')
    .eq('workspace_id', workspaceId)
    .eq('status', 'open')
    .eq('blocker', 'infra-bill-unconfirmed');

  const alertedBillIds = new Set<string>();
  for (const item of (rawInbox ?? []) as InboxRow[]) {
    try {
      const ctx = JSON.parse(item.context) as { billId?: string };
      if (ctx.billId) alertedBillIds.add(ctx.billId);
    } catch { /* skip */ }
  }

  const now = Date.now();
  let written = 0;

  for (const bill of bills) {
    if (alertedBillIds.has(bill.id)) continue;

    const threshold = confirmationThresholdDays(bill.billing_cycle, bill.auto_pay);
    const referenceMs = bill.last_confirmed_at
      ? Date.parse(bill.last_confirmed_at)
      : Date.parse(bill.created_at);

    if (Number.isNaN(referenceMs)) continue;

    const daysSince = (now - referenceMs) / MS_PER_DAY;
    if (daysSince <= threshold) continue;

    try {
      await writeFounderQuestion(db, {
        id: randomUUID(),
        workspace_id: workspaceId,
        arc_id: null,
        phase_id: null,
        mode: 'tooling',
        blocker: 'infra-bill-unconfirmed',
        context: JSON.stringify({
          billId: bill.id,
          serviceName: bill.service_name,
          category: bill.category,
          amountCents: bill.amount_cents,
          billingCycle: bill.billing_cycle,
          autoPay: Boolean(bill.auto_pay),
          daysSinceConfirmed: Math.round(daysSince),
          threshold,
        }),
        options: [
          { label: 'Confirm', text: `${bill.service_name} is paid and running.` },
          { label: 'Investigate', text: `I need to check ${bill.service_name}.` },
        ],
        recommended: 'Confirm',
        screenshot_path: null,
        asked_at: new Date().toISOString(),
      });
      written++;
      logger.info(
        { billId: bill.id, serviceName: bill.service_name, daysSince: Math.round(daysSince) },
        'eternal.infra_bill.alert_written',
      );
    } catch (err) {
      logger.warn({ err, billId: bill.id }, 'eternal.infra_bill.alert_write.failed');
    }
  }

  if (written > 0) {
    logger.info({ written, workspaceId }, 'eternal.infra_bill.check_complete');
  }
  return written;
}
