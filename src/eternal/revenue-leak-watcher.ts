/**
 * Eternal Systems — revenue leak watcher.
 *
 * Detects two classes of revenue leak:
 * 1. Unattributed payment events — contact_events with kind 'plan:paid'
 *    that have no corresponding revenue_entries row (missing source_event_id link).
 * 2. Monthly silence — current month has no revenue_entries at all, but prior
 *    months did (suggests pipeline broke, not just a slow month).
 *
 * Runs daily via the daemon scheduler.
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { writeFounderQuestion } from '../autonomy/director-persistence.js';

interface ContactEventRow {
  id: string;
  contact_id: string | null;
  kind: string | null;
  occurred_at: string | null;
  created_at: string;
}

interface RevenueEntryRow {
  id: string;
  source_event_id: string | null;
  month: number;
  year: number;
  amount_cents: number;
}

interface InboxRow {
  id: string;
  context: string;
  status: string;
}

/**
 * Main entry point. Detects unattributed payment events and monthly silence,
 * writing founder_inbox alerts for each new issue found.
 *
 * Returns the number of new alerts written.
 */
export async function checkRevenueLeak(
  db: DatabaseAdapter,
  workspaceId: string,
): Promise<number> {
  // Step 1 — Load payment events
  const { data: rawEvents } = await db
    .from<ContactEventRow>('agent_workforce_contact_events')
    .select('id,contact_id,kind,occurred_at,created_at')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'plan:paid');

  const paymentEvents = (rawEvents ?? []) as ContactEventRow[];

  // Step 2 — Load revenue entries
  const { data: rawRevenue } = await db
    .from<RevenueEntryRow>('agent_workforce_revenue_entries')
    .select('id,source_event_id,month,year,amount_cents')
    .eq('workspace_id', workspaceId);

  const revenue = (rawRevenue ?? []) as RevenueEntryRow[];

  // Step 3 — Find unattributed payment events
  const attributedEventIds = new Set(
    revenue.filter(r => r.source_event_id).map(r => r.source_event_id!),
  );
  const unattributed = paymentEvents.filter(ev => !attributedEventIds.has(ev.id));

  // Step 4 — Detect monthly silence
  const now = new Date();
  const currentMonth = now.getMonth() + 1; // 1-based
  const currentYear = now.getFullYear();
  const dayOfMonth = now.getDate();

  const hasCurrentMonthRevenue = revenue.some(
    r => r.month === currentMonth && r.year === currentYear,
  );
  const hasPriorMonthRevenue = revenue.some(
    r => r.year < currentYear || (r.year === currentYear && r.month < currentMonth),
  );

  const isMonthlySilence =
    dayOfMonth > 5 && !hasCurrentMonthRevenue && hasPriorMonthRevenue;

  // Step 5 — Load existing open revenue-leak alerts to dedupe
  const { data: rawInbox } = await db
    .from<InboxRow>('founder_inbox')
    .select('id,context,status')
    .eq('workspace_id', workspaceId)
    .eq('status', 'open')
    .eq('blocker', 'revenue-leak');

  const inboxItems = (rawInbox ?? []) as InboxRow[];

  const alertedEventIds = new Set<string>();
  let silenceAlreadyAlerted = false;

  for (const item of inboxItems) {
    try {
      const ctx = JSON.parse(item.context) as {
        type?: string;
        eventId?: string;
        month?: number;
        year?: number;
      };
      if (ctx.type === 'unattributed_payment_event' && ctx.eventId) {
        alertedEventIds.add(ctx.eventId);
      }
      if (
        ctx.type === 'monthly_silence' &&
        ctx.month === currentMonth &&
        ctx.year === currentYear
      ) {
        silenceAlreadyAlerted = true;
      }
    } catch {
      // Malformed context — skip
    }
  }

  let written = 0;

  // Step 6 — Write inbox alerts for unattributed events
  for (const ev of unattributed) {
    if (alertedEventIds.has(ev.id)) continue; // already alerted

    try {
      await writeFounderQuestion(db, {
        id: randomUUID(),
        workspace_id: workspaceId,
        arc_id: null,
        phase_id: null,
        mode: 'revenue',
        blocker: 'revenue-leak',
        context: JSON.stringify({
          type: 'unattributed_payment_event',
          eventId: ev.id,
          contactId: ev.contact_id,
          occurredAt: ev.occurred_at ?? ev.created_at,
        }),
        options: [
          { label: 'Investigate', text: 'I will check the payment and add revenue manually.' },
          { label: 'Dismiss', text: 'This event was already handled or is not real revenue.' },
        ],
        recommended: 'Investigate',
        screenshot_path: null,
        asked_at: new Date().toISOString(),
      });
      written++;
      logger.info(
        { eventId: ev.id, contactId: ev.contact_id },
        'eternal.revenue_leak.unattributed_event.alert_written',
      );
    } catch (err) {
      logger.warn(
        { err, eventId: ev.id },
        'eternal.revenue_leak.unattributed_event.alert_write.failed',
      );
    }
  }

  // Step 7 — Write one alert for monthly silence
  if (isMonthlySilence && !silenceAlreadyAlerted) {
    try {
      await writeFounderQuestion(db, {
        id: randomUUID(),
        workspace_id: workspaceId,
        arc_id: null,
        phase_id: null,
        mode: 'revenue',
        blocker: 'revenue-leak',
        context: JSON.stringify({
          type: 'monthly_silence',
          month: currentMonth,
          year: currentYear,
        }),
        options: [
          { label: 'Investigate', text: 'I will check why no revenue has been recorded this month.' },
          { label: 'Dismiss', text: 'This month is legitimately empty so far.' },
        ],
        recommended: 'Investigate',
        screenshot_path: null,
        asked_at: new Date().toISOString(),
      });
      written++;
      logger.info(
        { month: currentMonth, year: currentYear },
        'eternal.revenue_leak.monthly_silence.alert_written',
      );
    } catch (err) {
      logger.warn(
        { err, month: currentMonth, year: currentYear },
        'eternal.revenue_leak.monthly_silence.alert_write.failed',
      );
    }
  }

  if (written > 0) {
    logger.info({ written, workspaceId }, 'eternal.revenue_leak.check_complete');
  }

  return written;
}
