/**
 * Local → Cloud Resource Sync Dispatcher
 *
 * Single fire-and-forget entry point that every tool uses to mirror a
 * local create / update / delete to the cloud sync-resource endpoint.
 * Replaces the per-tool helper functions (`syncContactUpstream`,
 * `syncKnowledgeUpstream`, `syncTeamMemberUpstream`) that were copy-
 * pasted across crm.ts, knowledge.ts, and team.ts. New synced resources
 * are added by extending the `SyncResource` union and the cloud
 * endpoint's TABLE_BY_RESOURCE map in lockstep.
 *
 * Sync failures are intentionally swallowed: the local SQLite row is
 * the source of truth and the cloud is a downstream mirror. The
 * `ControlPlaneClient.reportResource` call already handles offline
 * queuing under the "resource_sync" outbound queue, so a failed call
 * here just means the row will be replayed when the cloud is reachable.
 */

import type { LocalToolContext } from '../orchestrator/local-tool-types.js';
import { logger } from '../lib/logger.js';

/**
 * Convert a 32-char hex id (the local SQLite default for primary keys
 * via `lower(hex(randomblob(16)))` or hex-encoded crypto.getRandomValues)
 * into the dashed 8-4-4-4-12 UUID format cloud Supabase requires for
 * uuid columns. Idempotent: passes through values that already have
 * dashes or aren't 32 chars.
 *
 * Lives in this module because every synced resource needs it — the
 * local primary key has to be reshaped before it lands in cloud.
 */
export function hexToUuid(id: string): string {
  if (id.includes('-')) return id;
  if (id.length !== 32) return id;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/**
 * Every resource type the runtime knows how to sync upstream. Adding a
 * new entry here requires:
 *   1. Updating `ControlPlaneClient.reportResource` in client.ts
 *   2. Updating `TABLE_BY_RESOURCE` + `isSupportedResource` in the cloud
 *      route at ohwow.fun/src/app/api/local-runtime/sync-resource/route.ts
 *   3. Ensuring the cloud Supabase table actually exists
 */
export type SyncResource =
  | 'contact'
  | 'knowledge_document'
  | 'team_member'
  | 'agent'
  | 'task'
  | 'goal'
  | 'onboarding_plan'
  | 'deliverable'
  | 'content_calendar'
  | 'code_skill';

export type SyncAction = 'upsert' | 'delete';

export interface SyncPayload extends Record<string, unknown> {
  id: string;
}

/**
 * Dispatch a single resource sync upstream. Never throws. Logs at
 * debug level when the cloud is unreachable so the local tool's
 * happy path stays quiet.
 */
export async function syncResource(
  ctx: LocalToolContext,
  resource: SyncResource,
  action: SyncAction,
  payload: SyncPayload,
): Promise<void> {
  if (!ctx.controlPlane) return;
  try {
    const result = await ctx.controlPlane.reportResource(resource, action, payload);
    if (!result.ok) {
      logger.debug(
        { resource, action, id: payload.id, error: result.error },
        '[sync-resources] sync deferred',
      );
    }
  } catch (err) {
    logger.warn(
      { err, resource, action, id: payload.id },
      '[sync-resources] sync threw',
    );
  }
}

/**
 * Walk every synced row in the workspace and re-fire reportResource
 * for each. Used as a one-time backfill when the runtime joins cloud
 * after running locally for a while, or when a new resource type is
 * added to the registry. Returns per-resource counts.
 *
 * Safe to re-run: the cloud sync-resource endpoint upserts on conflict
 * by id. Sync failures are logged and counted but do not stop the walk.
 */
export async function resyncWorkspaceToCloud(
  ctx: LocalToolContext,
): Promise<Record<SyncResource, { attempted: number; failed: number }>> {
  const counts: Record<SyncResource, { attempted: number; failed: number }> = {
    contact: { attempted: 0, failed: 0 },
    knowledge_document: { attempted: 0, failed: 0 },
    team_member: { attempted: 0, failed: 0 },
    agent: { attempted: 0, failed: 0 },
    task: { attempted: 0, failed: 0 },
    goal: { attempted: 0, failed: 0 },
    onboarding_plan: { attempted: 0, failed: 0 },
    deliverable: { attempted: 0, failed: 0 },
    content_calendar: { attempted: 0, failed: 0 },
    code_skill: { attempted: 0, failed: 0 },
  };

  // Lazy-import payload builders so the tool registry doesn't pull
  // every tool file at startup just to keep this util declared.
  const { taskSyncPayload } = await import('../orchestrator/tools/tasks.js');
  const { goalSyncPayload } = await import('../orchestrator/tools/goals.js');
  const { teamMemberSyncPayload } = await import('../orchestrator/tools/team.js');
  const { onboardingPlanSyncPayload } = await import('../orchestrator/tools/onboarding-plan.js');
  const { agentSyncPayload } = await import('../orchestrator/tools/agents.js');

  // Order matters: agents must land before tasks (agent_id FK), goals
  // before tasks (goal_id FK), team_members before onboarding_plans
  // (team_member_id FK).
  type SyncableTable = {
    resource: SyncResource;
    table: string;
    build: (row: Record<string, unknown>) => SyncPayload | null;
  };
  const tables: SyncableTable[] = [
    { resource: 'agent', table: 'agent_workforce_agents', build: (row) => agentSyncPayload(row) },
    { resource: 'team_member', table: 'agent_workforce_team_members', build: (row) => teamMemberSyncPayload(row) },
    { resource: 'goal', table: 'agent_workforce_goals', build: (row) => goalSyncPayload(row) },
    { resource: 'task', table: 'agent_workforce_tasks', build: (row) => taskSyncPayload(row) },
    { resource: 'onboarding_plan', table: 'agent_workforce_onboarding_plans', build: (row) => onboardingPlanSyncPayload(row as Parameters<typeof onboardingPlanSyncPayload>[0]) },
  ];

  for (const { resource, table, build } of tables) {
    const { data, error } = await ctx.db
      .from(table)
      .select('*')
      .eq('workspace_id', ctx.workspaceId);
    if (error) {
      logger.warn({ err: error, table }, '[resync] failed to read table');
      continue;
    }
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    for (const row of rows) {
      counts[resource].attempted++;
      try {
        const payload = build(row);
        if (!payload) continue;
        await syncResource(ctx, resource, 'upsert', payload);
      } catch (err) {
        counts[resource].failed++;
        logger.warn({ err, resource, id: row.id }, '[resync] payload build or sync failed');
      }
    }
    logger.info({ resource, attempted: counts[resource].attempted, failed: counts[resource].failed }, '[resync] table done');
  }

  return counts;
}
