/**
 * contacts — small lookup helpers over agent_workforce_contacts.
 *
 * The CRM table stores free-form metadata in `custom_fields TEXT` as a
 * JSON blob; conventions for keys are set by the caller. These helpers
 * centralize the SQLite `json_extract` queries so DM-linking, future
 * email-linking, and other "find a contact by external identity"
 * paths don't each re-derive the column expression.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from './logger.js';

/** Shape observed in agent_workforce_contacts. Only the fields the
 * DM linking path cares about; callers can cast to a richer type if
 * they need more columns. */
export interface ContactRow {
  id: string;
  workspace_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  contact_type?: string | null;
  status?: string | null;
  custom_fields: string | null;
}

/**
 * Return the contact whose `custom_fields.x_user_id` matches the given
 * numeric X user ID, or null if none found.
 *
 * Convention: contacts opt in to DM linking by setting
 *   custom_fields = '{"x_user_id": "1877225919862951937", ...}'
 * The poller calls this for each inbound DM thread; no match → an
 * `unknown_correspondent` signal is emitted and no auto-create happens.
 *
 * We query via `json_extract` rather than a dedicated column because
 * X linking is one convention among many (email/phone/github/etc.)
 * and `custom_fields` is the existing free-form surface for these.
 * If the DM load ever makes this the hot path, the right fix is a
 * generated column + index, not a schema change that promotes x_user_id
 * to a top-level field.
 */
export async function findContactByXUserId(
  db: DatabaseAdapter,
  workspaceId: string,
  xUserId: string,
): Promise<ContactRow | null> {
  if (!xUserId) return null;
  try {
    const { data } = await db
      .from<ContactRow>('agent_workforce_contacts')
      .select('id, workspace_id, name, email, phone, company, custom_fields')
      .eq('workspace_id', workspaceId)
      .eq(`json_extract(custom_fields, '$.x_user_id')`, xUserId)
      .maybeSingle();
    return (data as ContactRow | null) ?? null;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err, workspaceId, xUserId },
      '[contacts] findContactByXUserId lookup failed',
    );
    return null;
  }
}

/**
 * Return the contact whose `custom_fields.x_conversation_pair` matches the
 * given conversation pair, or null. Used as a fallback when the operator's
 * self user id isn't configured and we can't split the pair into a
 * counterparty id — the full pair still uniquely identifies the DM thread.
 */
export async function findContactByDmPair(
  db: DatabaseAdapter,
  workspaceId: string,
  pair: string,
): Promise<ContactRow | null> {
  if (!pair) return null;
  try {
    const { data } = await db
      .from<ContactRow>('agent_workforce_contacts')
      .select('id, workspace_id, name, email, phone, company, custom_fields')
      .eq('workspace_id', workspaceId)
      .eq(`json_extract(custom_fields, '$.x_conversation_pair')`, pair)
      .maybeSingle();
    return (data as ContactRow | null) ?? null;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err, workspaceId, pair },
      '[contacts] findContactByDmPair lookup failed',
    );
    return null;
  }
}

/**
 * Clean the primary_name that X shows in the DM list. It often leaks
 * preview text (e.g. "Please check it out and fix it" ends up as the
 * primary_name for James' thread because X renders the latest message
 * alongside the name and our DOM scraper grabbed the whole span). We
 * pick the first reasonable-looking token: first line, stripped of the
 * preview if it contains the well-known "<name>Nh<msg>" concatenation
 * used by X's "N hours ago" badge.
 */
export function cleanDmPrimaryName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let name = raw.trim();
  if (!name) return null;
  // X sometimes concatenates "<Display Name><time><preview>". Split on
  // the time marker (e.g. "6h", "23m", "2d").
  const timeMatch = name.match(/\s*\d+[hmd]\s*/);
  if (timeMatch && timeMatch.index !== undefined && timeMatch.index > 0) {
    name = name.slice(0, timeMatch.index);
  }
  // Strip anything after a newline.
  name = name.split(/[\n\r]/)[0];
  name = name.trim();
  if (!name) return null;
  if (name.length > 120) name = name.slice(0, 120);
  return name;
}

/**
 * Idempotently ensure a contact exists for an inbound DM thread. Called
 * by the DM poller for every observed thread. The CRM is the system's
 * authoritative person table — if we have a conversation with someone,
 * they belong there. Returns the contact id (existing or freshly
 * created) or null on DB error.
 *
 * Lookup precedence:
 *   1. x_user_id match (when counterpartyUserId known)
 *   2. conversation_pair match (fallback when counterparty unknown)
 *   3. insert new row
 *
 * On insert we also append a `first_seen` event so the revenue funnel
 * and attribution rollup see the lead enter the pipeline.
 */
export async function upsertContactFromDm(
  db: DatabaseAdapter,
  workspaceId: string,
  opts: {
    conversationPair: string;
    primaryName: string | null;
    counterpartyUserId: string | null;
  },
): Promise<string | null> {
  const { conversationPair, counterpartyUserId } = opts;
  const cleanName = cleanDmPrimaryName(opts.primaryName);
  const displayName = cleanName ?? `DM ${conversationPair.slice(0, 12)}`;

  // 1. Existing via x_user_id.
  if (counterpartyUserId) {
    const byUser = await findContactByXUserId(db, workspaceId, counterpartyUserId);
    if (byUser) return byUser.id;
  }
  // 2. Existing via conversation_pair.
  const byPair = await findContactByDmPair(db, workspaceId, conversationPair);
  if (byPair) {
    // Back-fill x_user_id if we've since learned it.
    if (counterpartyUserId && !extractCustomField(byPair.custom_fields, 'x_user_id')) {
      try {
        const merged = mergeCustomFields(byPair.custom_fields, { x_user_id: counterpartyUserId });
        await db.from('agent_workforce_contacts').update({ custom_fields: merged }).eq('id', byPair.id);
      } catch { /* non-fatal */ }
    }
    return byPair.id;
  }
  // 3. Create fresh.
  const customFields: Record<string, string> = {
    x_source: 'dm-inbox',
    x_conversation_pair: conversationPair,
  };
  if (counterpartyUserId) customFields.x_user_id = counterpartyUserId;
  if (cleanName) customFields.x_display_name = cleanName;
  try {
    const { data } = await db
      .from<ContactRow>('agent_workforce_contacts')
      .insert({
        workspace_id: workspaceId,
        name: displayName,
        contact_type: 'lead',
        status: 'active',
        custom_fields: JSON.stringify(customFields),
      })
      .select('id')
      .single();
    const row = data as { id: string } | null;
    if (!row?.id) return null;

    // Emit first_seen so the funnel counts it.
    try {
      await db.from('agent_workforce_contact_events').insert({
        workspace_id: workspaceId,
        contact_id: row.id,
        event_type: 'first_seen',
        kind: 'first_seen',
        source: 'dm-inbox',
        title: `First seen via DM`,
        description: conversationPair,
        occurred_at: new Date().toISOString(),
        payload: JSON.stringify({ conversation_pair: conversationPair, counterparty_user_id: counterpartyUserId ?? null }),
      });
    } catch (err) {
      logger.debug({ err: err instanceof Error ? err.message : err }, '[contacts] first_seen event insert failed');
    }

    logger.info(
      { workspaceId, contactId: row.id, name: displayName, counterpartyUserId, conversationPair },
      '[contacts] auto-created DM contact',
    );
    return row.id;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, workspaceId, conversationPair },
      '[contacts] upsertContactFromDm failed',
    );
    return null;
  }
}

function extractCustomField(customFields: string | null, key: string): string | null {
  if (!customFields) return null;
  try {
    const obj = JSON.parse(customFields) as Record<string, unknown>;
    const v = obj[key];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

function mergeCustomFields(existing: string | null, patch: Record<string, string>): string {
  let obj: Record<string, unknown> = {};
  if (existing) {
    try { obj = JSON.parse(existing) as Record<string, unknown>; } catch { obj = {}; }
  }
  for (const [k, v] of Object.entries(patch)) obj[k] = v;
  return JSON.stringify(obj);
}
