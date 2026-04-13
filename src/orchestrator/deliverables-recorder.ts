/**
 * Deliverables Recorder
 *
 * Single entry point every artifact-producing tool calls when it
 * successfully creates a "thing" (file, doc, image, video, audio,
 * structured artifact). Replaces the pattern where each tool either
 * (a) silently produced output without recording it or (b) called the
 * standalone saveDeliverable tool with a hand-rolled payload and no
 * actor attribution.
 *
 * The runtime auto-creates a deliverable row + fires the cloud sync
 * the same way other synced resources do, so the dashboard activity
 * timeline / Deliverables view / per-actor work tracking can answer
 * "what did the COS produce for Mario this week?" with a single
 * column query.
 *
 * Actor attribution is inferred from the LocalToolContext when not
 * passed explicitly:
 *   - currentTeamMemberId set → for_team_member_id
 *   - currentAgentId set → produced_by_type='agent', produced_by_id=agentId
 *   - else if a team member is the chat actor and they have a guide
 *     agent → produced_by_type='guide', produced_by_id=guideAgentId
 *   - else → produced_by_type='system'
 */

import type { LocalToolContext } from './local-tool-types.js';
import { logger } from '../lib/logger.js';
import { syncResource, hexToUuid } from '../control-plane/sync-resources.js';

export type DeliverableType =
  | 'document'
  | 'email'
  | 'report'
  | 'code'
  | 'creative'
  | 'plan'
  | 'data'
  | 'media'
  | 'other';

export interface RecordDeliverableInput {
  /** Required: short, human-readable title for the artifact. */
  title: string;
  /**
   * Required: artifact category. The dashboard renders different
   * affordances per type (file download for document/code, inline
   * preview for media, etc.).
   */
  type: DeliverableType;
  /**
   * Required: the artifact body. For files, the file contents (or a
   * pointer like `{ file_path, byte_size }`); for KB docs, a summary
   * + reference; for media, the URL. Stored in cloud as jsonb so we
   * stringify a structured object rather than dumping raw bytes.
   */
  content: unknown;
  /** Optional: provider name (e.g. 'openai', 'anthropic', 'local-fs'). */
  provider?: string;
  /** Optional: explicit task id; falls back to ctx.currentTaskId. */
  taskId?: string | null;
  /** Optional: explicit producer override (overrides ctx inference). */
  producedBy?: {
    type: 'agent' | 'member' | 'guide' | 'system';
    id: string | null;
  };
  /** Optional: explicit team_member id override. */
  forTeamMemberId?: string | null;
}

export interface RecordedDeliverable {
  id: string;
}

function newHexId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Insert a deliverable row locally + fire the cloud sync. Never throws —
 * a failure to record a deliverable should not break the artifact-
 * producing tool that's calling us.
 *
 * Returns the inserted id on success, null on failure.
 */
export async function recordDeliverable(
  ctx: LocalToolContext,
  input: RecordDeliverableInput,
): Promise<RecordedDeliverable | null> {
  if (!input.title || !input.type) {
    logger.debug({ input }, '[deliverables] missing required title/type, skipping');
    return null;
  }

  // Resolve actor + recipient with explicit overrides taking precedence
  const teamMemberId = input.forTeamMemberId ?? ctx.currentTeamMemberId ?? null;
  let producedByType: 'agent' | 'member' | 'guide' | 'system';
  let producedById: string | null;
  if (input.producedBy) {
    producedByType = input.producedBy.type;
    producedById = input.producedBy.id;
  } else if (ctx.currentAgentId) {
    // Running inside an agent task — the agent itself is the producer
    producedByType = 'agent';
    producedById = ctx.currentAgentId;
  } else if (ctx.currentGuideAgentId) {
    // Chatting on behalf of a team member whose guide agent is set —
    // the COS is producing this artifact for the member
    producedByType = 'guide';
    producedById = ctx.currentGuideAgentId;
  } else {
    producedByType = 'system';
    producedById = null;
  }

  const id = newHexId();
  const now = new Date().toISOString();
  const contentString = typeof input.content === 'string'
    ? input.content
    : JSON.stringify(input.content);

  try {
    const { error } = await ctx.db.from('agent_workforce_deliverables').insert({
      id,
      workspace_id: ctx.workspaceId,
      task_id: input.taskId ?? ctx.currentTaskId ?? null,
      agent_id: ctx.currentAgentId ?? null,
      session_id: ctx.sessionId ?? null,
      deliverable_type: input.type,
      provider: input.provider ?? null,
      title: input.title.slice(0, 500),
      content: contentString,
      status: 'pending_review',
      auto_created: 1,
      produced_by_type: producedByType,
      produced_by_id: producedById,
      for_team_member_id: teamMemberId,
      created_at: now,
      updated_at: now,
    });

    if (error) {
      logger.warn({ err: error, title: input.title }, '[deliverables] insert failed');
      return null;
    }
  } catch (err) {
    logger.warn({ err, title: input.title }, '[deliverables] insert threw');
    return null;
  }

  // Fire-and-forget sync to cloud. Same shape the other synced
  // resources use: payload contains the raw column values, hex ids
  // get translated to dashed UUIDs by hexToUuid.
  void syncResource(ctx, 'deliverable', 'upsert', {
    id: hexToUuid(id),
    task_id: (() => {
      const tid = input.taskId ?? ctx.currentTaskId ?? null;
      return tid ? hexToUuid(tid) : null;
    })(),
    agent_id: ctx.currentAgentId ? hexToUuid(ctx.currentAgentId) : null,
    session_id: ctx.sessionId ?? null,
    deliverable_type: input.type,
    provider: input.provider ?? null,
    title: input.title.slice(0, 500),
    content: { text: contentString.slice(0, 100_000) },
    status: 'pending_review',
    auto_created: true,
    produced_by_type: producedByType,
    produced_by_id: producedById ? hexToUuid(producedById) : null,
    for_team_member_id: teamMemberId ? hexToUuid(teamMemberId) : null,
    created_at: now,
    updated_at: now,
  });

  return { id };
}
