/**
 * log_contact_event dispatcher: log an event against a matched contact.
 */

import type { ActionDispatcher, DispatcherDeps } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import { resolveContextValue } from '../action-utils.js';
import { resolveContextTemplate } from '../field-mapper.js';
import { logger } from '../../lib/logger.js';

export const logContactEventDispatcher: ActionDispatcher = {
  actionType: 'log_contact_event',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
    deps: DispatcherDeps,
  ): Promise<ActionOutput> {
    const matchField = config.match_field as string;
    const matchValuePath = config.match_value_path as string;
    const eventType = config.event_type as string;
    const titleTemplate = config.title_template as string;

    if (!matchField || !matchValuePath || !eventType || !titleTemplate) {
      throw new Error('log_contact_event requires match_field, match_value_path, event_type, and title_template');
    }

    const matchValue = resolveContextValue(matchValuePath, context);
    if (!matchValue) {
      throw new Error(`log_contact_event: could not resolve match value at path "${matchValuePath}"`);
    }

    const { data: existing } = await deps.db.from('agent_workforce_contacts')
      .select('id')
      .eq('workspace_id', deps.workspaceId)
      .eq(matchField, matchValue as string)
      .maybeSingle();

    if (!existing) {
      throw new Error(`log_contact_event: no contact found where ${matchField}="${matchValue}"`);
    }

    const title = resolveContextTemplate(titleTemplate, context);
    const descriptionTemplate = config.description_template as string | undefined;
    const description = descriptionTemplate ? resolveContextTemplate(descriptionTemplate, context) : null;

    const { data: eventData } = await deps.db.from('agent_workforce_contact_events').insert({
      workspace_id: deps.workspaceId,
      contact_id: (existing as { id: string }).id,
      event_type: eventType,
      title,
      description,
      metadata: JSON.stringify({ source: 'trigger', context: context.trigger }),
    }).select('id').single();

    const eventId = eventData ? (eventData as { id: string }).id : null;
    logger.info(`[ActionExecutor] Logged event "${title}" for contact (${matchField}="${matchValue}")`);
    return { event_id: eventId, contact_id: (existing as { id: string }).id };
  },
};
