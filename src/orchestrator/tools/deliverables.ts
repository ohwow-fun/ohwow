/**
 * Orchestrator Tools — Deliverables
 * Save work products from conversation as deliverables.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext } from '../local-tool-types.js';
import type { ToolResult } from '../local-tool-types.js';
import { logger } from '../../lib/logger.js';

export const DELIVERABLE_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'save_deliverable',
    description:
      'Save a work product from this conversation as a deliverable. Use when you have produced substantial content the user may want to reference later (a draft, report, plan, analysis, creative writing, code, etc.). Always ask the user before saving.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Descriptive title for the deliverable' },
        content: { type: 'string', description: 'The full deliverable content to save' },
        type: {
          type: 'string',
          enum: ['document', 'email', 'report', 'code', 'creative', 'plan', 'data', 'other'],
          description: 'Type of deliverable',
        },
      },
      required: ['title', 'content', 'type'],
    },
  },
];

const VALID_TYPES = ['document', 'email', 'report', 'code', 'creative', 'plan', 'data', 'other'];

export async function saveDeliverable(
  ctx: LocalToolContext,
  input?: Record<string, unknown>,
): Promise<ToolResult> {
  const title = input?.title as string | undefined;
  const content = input?.content as string | undefined;
  const type = input?.type as string | undefined;

  if (!title || !content || !type) {
    return { success: false, error: 'title, content, and type are required' };
  }

  if (!VALID_TYPES.includes(type)) {
    return { success: false, error: `type must be one of: ${VALID_TYPES.join(', ')}` };
  }

  if (content.length > 500_000) {
    return { success: false, error: 'Content exceeds 500KB limit' };
  }

  try {
    const { data, error } = await ctx.db.from('agent_workforce_deliverables').insert({
      workspace_id: ctx.workspaceId,
      task_id: null,
      agent_id: null,
      session_id: null,
      deliverable_type: type,
      title,
      content: JSON.stringify({ text: content }),
      status: 'approved',
      auto_created: 0,
    }).select('id').single();

    if (error) {
      logger.error({ error }, '[save_deliverable] Insert failed');
      return { success: false, error: 'Couldn\'t save deliverable' };
    }

    const id = (data as Record<string, unknown>)?.id || 'unknown';

    return {
      success: true,
      data: {
        id,
        message: `Saved "${title}" as a ${type} deliverable.`,
      },
    };
  } catch (err) {
    logger.error({ err }, '[save_deliverable] Unexpected error');
    return { success: false, error: 'Couldn\'t save deliverable' };
  }
}
