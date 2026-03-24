/**
 * update_contact dispatcher: find and update a contact.
 */

import type { ActionDispatcher, DispatcherDeps } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import { resolveContextValue, resolveMapping } from '../action-utils.js';
import { logger } from '../../lib/logger.js';

export const updateContactDispatcher: ActionDispatcher = {
  actionType: 'update_contact',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
    deps: DispatcherDeps,
  ): Promise<ActionOutput> {
    const matchField = config.match_field as string;
    const matchValuePath = config.match_value_path as string;
    const fieldMapping = config.field_mapping as Record<string, string>;

    if (!matchField || !matchValuePath || !fieldMapping) {
      throw new Error('update_contact requires match_field, match_value_path, and field_mapping');
    }

    const matchValue = resolveContextValue(matchValuePath, context);
    if (!matchValue) {
      throw new Error(`update_contact: could not resolve match value at path "${matchValuePath}"`);
    }

    const { data: existing } = await deps.db.from('agent_workforce_contacts')
      .select('id')
      .eq('workspace_id', deps.workspaceId)
      .eq(matchField, matchValue as string)
      .maybeSingle();

    if (!existing) {
      throw new Error(`update_contact: no contact found where ${matchField}="${matchValue}"`);
    }

    const mapped = resolveMapping(fieldMapping, context);
    const updatePayload: Record<string, unknown> = {
      ...mapped,
      updated_at: new Date().toISOString(),
    };

    await deps.db.from('agent_workforce_contacts')
      .update(updatePayload)
      .eq('id', (existing as { id: string }).id);

    logger.info(`[ActionExecutor] Updated contact where ${matchField}="${matchValue}"`);
    return { contact_id: (existing as { id: string }).id, updated_fields: Object.keys(mapped) };
  },
};
