/**
 * Eternal Systems — contact SLA watcher.
 *
 * Scans active contacts for relationships that haven't had a recorded
 * event within the configured SLA window, and writes a founder_inbox
 * item for each violation. Runs periodically via the daemon scheduler.
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { EternalSpec } from './types.js';
import { writeFounderQuestion } from '../autonomy/director-persistence.js';

const MS_PER_DAY = 86_400_000;

interface ContactRow {
  id: string;
  name: string;
  contact_type: string;
  created_at: string;
}

interface EventRow {
  contact_id: string;
  occurred_at: string | null;
  created_at: string;
}

interface InboxRow {
  id: string;
  context: string;
  blocker: string;
  status: string;
}

/**
 * Determine the SLA threshold in days for a given contact_type.
 * Returns undefined when the type is not monitored.
 */
export function slaThresholdForType(
  contactType: string,
  slaDays: Record<string, number>,
): number | undefined {
  return slaDays[contactType];
}

/**
 * Main entry point. Finds active contacts that have exceeded their SLA
 * threshold and writes a founder_inbox alert for each, skipping contacts
 * that already have an open alert.
 *
 * Returns the number of new alerts written.
 */
export async function checkContactSLAs(
  db: DatabaseAdapter,
  workspaceId: string,
  spec: EternalSpec,
): Promise<number> {
  const slaDays = spec.contactSlaDays ?? {};
  if (Object.keys(slaDays).length === 0) {
    // No types configured for monitoring
    return 0;
  }

  // 1. Load all active contacts
  const { data: rawContacts } = await db
    .from<ContactRow>('agent_workforce_contacts')
    .select('id,name,contact_type,created_at')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active');

  const contacts = (rawContacts ?? []) as ContactRow[];
  if (contacts.length === 0) return 0;

  // 2. Load all contact events for this workspace (occurred_at + created_at fallback)
  const { data: rawEvents } = await db
    .from<EventRow>('agent_workforce_contact_events')
    .select('contact_id,occurred_at,created_at')
    .eq('workspace_id', workspaceId);

  const events = (rawEvents ?? []) as EventRow[];

  // Build a map: contactId → most recent touch timestamp (ms)
  const lastTouchMap = new Map<string, number>();
  for (const ev of events) {
    const ts = Date.parse(ev.occurred_at ?? ev.created_at);
    if (!Number.isNaN(ts)) {
      const prev = lastTouchMap.get(ev.contact_id) ?? 0;
      if (ts > prev) lastTouchMap.set(ev.contact_id, ts);
    }
  }

  // 3. Load existing open relationship-decay alerts to avoid duplication
  const { data: rawInbox } = await db
    .from<InboxRow>('founder_inbox')
    .select('id,context,blocker,status')
    .eq('workspace_id', workspaceId)
    .eq('status', 'open')
    .eq('blocker', 'relationship-decay');

  const inboxItems = (rawInbox ?? []) as InboxRow[];
  const alertedContactIds = new Set<string>();
  for (const item of inboxItems) {
    try {
      const ctx = JSON.parse(item.context) as { contactId?: string };
      if (ctx.contactId) alertedContactIds.add(ctx.contactId);
    } catch {
      // Malformed context — skip
    }
  }

  // 4. Find violations and write inbox alerts
  const now = Date.now();
  let written = 0;

  for (const contact of contacts) {
    const threshold = slaThresholdForType(contact.contact_type, slaDays);
    if (threshold === undefined) continue; // type not monitored
    if (alertedContactIds.has(contact.id)) continue; // already alerted

    // Use last event touch, or created_at as fallback (never touched)
    const lastTouchMs = lastTouchMap.get(contact.id) ?? Date.parse(contact.created_at);
    if (Number.isNaN(lastTouchMs)) continue;

    const daysSince = (now - lastTouchMs) / MS_PER_DAY;
    if (daysSince <= threshold) continue; // within SLA

    try {
      await writeFounderQuestion(db, {
        id: randomUUID(),
        workspace_id: workspaceId,
        arc_id: null,
        phase_id: null,
        mode: 'outreach',
        blocker: 'relationship-decay',
        context: JSON.stringify({
          contactId: contact.id,
          contactName: contact.name,
          contactType: contact.contact_type,
          daysSinceActivity: Math.round(daysSince),
          slaThreshold: threshold,
        }),
        options: [
          { label: `Reach out to ${contact.name}`, text: 'reach-out' },
          { label: 'Snooze for 7 days', text: 'snooze' },
        ],
        recommended: 'reach-out',
        screenshot_path: null,
        asked_at: new Date().toISOString(),
      });
      written++;
      logger.info(
        {
          contactId: contact.id,
          contactName: contact.name,
          daysSince: Math.round(daysSince),
          threshold,
        },
        'eternal.contact_sla.alert_written',
      );
    } catch (err) {
      logger.warn(
        { err, contactId: contact.id },
        'eternal.contact_sla.alert_write.failed',
      );
    }
  }

  if (written > 0) {
    logger.info({ written, workspaceId }, 'eternal.contact_sla.check_complete');
  }

  return written;
}
