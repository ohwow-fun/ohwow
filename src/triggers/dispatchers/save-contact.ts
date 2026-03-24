/**
 * save_contact dispatcher: create or upsert a contact from context data.
 */

import type { ActionDispatcher, DispatcherDeps } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import { resolveMapping } from '../action-utils.js';
import { logger } from '../../lib/logger.js';

export const saveContactDispatcher: ActionDispatcher = {
  actionType: 'save_contact',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
    deps: DispatcherDeps,
  ): Promise<ActionOutput> {
    const fieldMapping = config.field_mapping as Record<string, string>;
    if (!fieldMapping) {
      throw new Error('save_contact action requires field_mapping in action_config');
    }

    const mapped = resolveMapping(fieldMapping, context);
    if (!mapped.name) {
      throw new Error('save_contact: field_mapping must resolve a "name" field');
    }

    const contactType = (config.contact_type as string) || 'lead';
    const upsertKey = config.upsert_key as string | undefined;

    if (upsertKey && mapped[upsertKey]) {
      const { data: existing } = await deps.db.from('agent_workforce_contacts')
        .select('id')
        .eq('workspace_id', deps.workspaceId)
        .eq(upsertKey, mapped[upsertKey] as string)
        .maybeSingle();

      if (existing) {
        const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
        for (const [key, value] of Object.entries(mapped)) {
          if (key !== upsertKey) updatePayload[key] = value;
        }
        await deps.db.from('agent_workforce_contacts')
          .update(updatePayload)
          .eq('id', (existing as { id: string }).id);
        logger.info(`[ActionExecutor] Updated existing contact via upsert (${upsertKey}=${mapped[upsertKey]})`);
        return { contact_id: (existing as { id: string }).id, name: mapped.name as string, created: false };
      }
    }

    const insertPayload: Record<string, unknown> = {
      workspace_id: deps.workspaceId,
      contact_type: contactType,
      status: 'active',
    };
    for (const [key, value] of Object.entries(mapped)) {
      insertPayload[key] = value;
    }

    const { data: newContact } = await deps.db.from('agent_workforce_contacts')
      .insert(insertPayload)
      .select('id')
      .single();

    const contactId = newContact ? (newContact as { id: string }).id : null;
    logger.info(`[ActionExecutor] Created contact: ${mapped.name}`);
    return { contact_id: contactId, name: mapped.name as string, created: true };
  },
};
