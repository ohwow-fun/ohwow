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
  {
    name: 'list_deliverables',
    description:
      'List deliverables stored in the workspace with summary metadata (no content body). Filter by status, type, agent, task, or recency. Use when the user asks what work products exist, for a workspace census, a recent-activity report, or before pulling a specific deliverable body via get_deliverable-style queries.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: ['pending_review', 'approved', 'rejected', 'delivered', 'archived'],
          description: 'Filter by deliverable status',
        },
        type: {
          type: 'string',
          enum: ['document', 'email', 'report', 'code', 'creative', 'plan', 'data', 'other'],
          description: 'Filter by deliverable type',
        },
        agent_id: { type: 'string', description: 'Filter to deliverables produced by a specific agent' },
        task_id: { type: 'string', description: 'Filter to deliverables produced by a specific task' },
        since: {
          type: 'string',
          description: 'ISO timestamp or relative shorthand ("24h", "7d", "30d"). Returns deliverables created on or after this point. Use for recent-activity reports.',
        },
        limit: { type: 'number', description: 'Max rows to return (default 20, max 200)' },
      },
      required: [],
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

  // Explicit ISO-8601 timestamps so the row is lexicographically
  // comparable against `.toISOString()` filter values in list_deliverables.
  // The schema default (`datetime('now')`) produces a space-separated
  // form that silently loses to ISO filters — bug found in M0.21.
  const nowIso = new Date().toISOString();

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
      created_at: nowIso,
      updated_at: nowIso,
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

interface DeliverableRow {
  id: string;
  deliverable_type: string;
  title: string;
  status: string;
  agent_id: string | null;
  task_id: string | null;
  for_team_member_id: string | null;
  produced_by_type: string | null;
  auto_created: number | null;
  created_at: string;
  updated_at: string | null;
}

/**
 * Resolve a `since` filter into an ISO timestamp. Accepts either:
 *   - an ISO-8601 timestamp (passed through verbatim after parse)
 *   - a relative shorthand like "24h", "7d", "30d", "60m" (computed
 *     from now)
 *
 * Returns null if the input is empty/undefined, or throws if the input
 * is malformed so the tool call surfaces a clear error instead of
 * silently returning the full history.
 */
function resolveSinceTimestamp(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new Error(`since must be a string, got ${typeof raw}`);
  }
  const trimmed = raw.trim();
  const relMatch = trimmed.match(/^(\d+)\s*(m|h|d)$/i);
  if (relMatch) {
    const value = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const unitMs = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return new Date(Date.now() - value * unitMs).toISOString();
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`since must be ISO-8601 or a relative shorthand like "24h" / "7d"; got "${trimmed}"`);
  }
  return parsed.toISOString();
}

export async function listDeliverables(
  ctx: LocalToolContext,
  input?: Record<string, unknown>,
): Promise<ToolResult> {
  const rawLimit = typeof input?.limit === 'number' ? (input.limit as number) : 20;
  const limit = Math.max(1, Math.min(200, Math.floor(rawLimit)));

  let sinceIso: string | null;
  try {
    sinceIso = resolveSinceTimestamp(input?.since);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'invalid since filter' };
  }

  let query = ctx.db
    .from<DeliverableRow>('agent_workforce_deliverables')
    .select('id, deliverable_type, title, status, agent_id, task_id, for_team_member_id, produced_by_type, auto_created, created_at, updated_at')
    .eq('workspace_id', ctx.workspaceId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (input?.status) query = query.eq('status', input.status as string);
  if (input?.type) query = query.eq('deliverable_type', input.type as string);
  if (input?.agent_id) query = query.eq('agent_id', input.agent_id as string);
  if (input?.task_id) query = query.eq('task_id', input.task_id as string);
  if (sinceIso) query = query.gte('created_at', sinceIso);

  const { data, error } = await query;
  if (error) {
    logger.error({ error }, '[list_deliverables] query failed');
    return { success: false, error: error.message };
  }

  // Get the total count separately so callers doing a workspace census can
  // report "N total, showing M" without having to make a second trip.
  let totalCountQuery = ctx.db
    .from('agent_workforce_deliverables')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', ctx.workspaceId);
  if (input?.status) totalCountQuery = totalCountQuery.eq('status', input.status as string);
  if (input?.type) totalCountQuery = totalCountQuery.eq('deliverable_type', input.type as string);
  if (input?.agent_id) totalCountQuery = totalCountQuery.eq('agent_id', input.agent_id as string);
  if (input?.task_id) totalCountQuery = totalCountQuery.eq('task_id', input.task_id as string);
  if (sinceIso) totalCountQuery = totalCountQuery.gte('created_at', sinceIso);
  const { count: totalCount } = await totalCountQuery;

  const rows = (data || []) as unknown as DeliverableRow[];

  return {
    success: true,
    data: {
      total: totalCount ?? rows.length,
      returned: rows.length,
      limit,
      since: sinceIso ?? undefined,
      deliverables: rows.map((r) => ({
        id: r.id,
        title: r.title,
        type: r.deliverable_type,
        status: r.status,
        agentId: r.agent_id ?? undefined,
        taskId: r.task_id ?? undefined,
        forTeamMemberId: r.for_team_member_id ?? undefined,
        producedByType: r.produced_by_type ?? undefined,
        autoCreated: r.auto_created === 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at ?? undefined,
      })),
    },
  };
}
