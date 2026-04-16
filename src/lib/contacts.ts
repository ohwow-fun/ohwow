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
