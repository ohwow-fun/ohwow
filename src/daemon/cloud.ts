/**
 * Daemon cloud connect + workspace consolidation phase
 *
 * Clears the stale replaced marker, checks multi-workspace mirror-collision
 * safety, constructs the ControlPlaneClient (if on a connected tier with a
 * license key), connects to the cloud, persists the resolved cloud workspace
 * identity back to the local workspace config, then rewrites every row in
 * every workspace-scoped SQLite table to the canonical workspace id. This
 * pairing is load-bearing: the canonical id is either the cloud Supabase
 * UUID (connected) or the "local" sentinel (offline). Consolidation must
 * run AFTER the control-plane handshake so we know which id to unify on,
 * and BEFORE the orchestrator reads workspaceId.
 *
 * Populates ctx.controlPlane and ctx.workspaceId. Mutates
 * ctx.businessContext if the cloud returns business metadata.
 *
 * The ControlPlaneClient's task-dispatch and workflow-execute callbacks
 * close over ctx and read ctx.engine / ctx.triggerEvaluator at invocation
 * time. Those fields are populated by later phases; until then the
 * callbacks skip work, matching the pre-refactor engineRef/triggerEvaluatorRef
 * null-check behavior.
 */

import { ControlPlaneClient } from '../control-plane/client.js';
import type { AgentConfigPayload } from '../control-plane/types.js';
import {
  readWorkspaceConfig,
  writeWorkspaceConfig,
  findWorkspaceByCloudId,
} from '../config.js';
import { saveWorkspaceData } from '../lib/onboarding-logic.js';
import { clearReplacedMarker } from './lifecycle.js';
import { logger } from '../lib/logger.js';
import type { DaemonContext } from './context.js';
import type { WorkspaceContext } from './workspace-context.js';

/**
 * Perform cloud connect + workspace consolidation for a single workspace.
 * Writes controlPlane, workspaceId, and businessContext back onto wsCtx.
 */
export async function consolidateWorkspace(wsCtx: WorkspaceContext): Promise<void> {
  const { config, db, rawDb, dataDir, workspaceName } = wsCtx;
  const isConnected = config.tier !== 'free';

  // Clear any stale replaced marker unconditionally at daemon startup.
  // If the daemon process starts at all, the marker's job (prevent respawn) is done.
  // This must happen before cloud connect — if connect fails, the marker would persist.
  clearReplacedMarker(dataDir);

  // Multi-workspace safety: if this workspace is cloud-mode and has a pinned
  // cloudWorkspaceId from a prior connect, refuse to boot if any OTHER local
  // workspace also points at that cloud id. Two local workspaces cannot mirror
  // the same cloud workspace — that's exactly the silent-data-collision bug
  // workspace isolation exists to prevent.
  const activeWs = readWorkspaceConfig(workspaceName);
  if (activeWs?.mode === 'cloud' && activeWs.cloudWorkspaceId) {
    const conflict = findWorkspaceByCloudId(activeWs.cloudWorkspaceId);
    if (conflict && conflict !== workspaceName) {
      throw new Error(
        `Cloud workspace ${activeWs.cloudWorkspaceId} is already bound to local workspace ` +
          `"${conflict}". Two local workspaces cannot mirror the same cloud workspace. ` +
          `Run "ohwow workspace unlink ${conflict}" first or use a different license.`,
      );
    }
  }

  let controlPlane: ControlPlaneClient | null = null;

  if (isConnected && config.licenseKey) {
    controlPlane = new ControlPlaneClient(config, db, {
      onTaskDispatch: (agentId, taskId) => {
        if (wsCtx.engine) {
          logger.info(`[daemon] Task dispatched: ${taskId} -> agent ${agentId}`);
          wsCtx.engine.executeTask(agentId, taskId).catch(err => {
            logger.error(`[daemon] Task ${taskId} error: ${err instanceof Error ? err.message : err}`);
          });
        }
      },
      onConfigSync: (_agents: AgentConfigPayload[]) => {
        // Config sync handled by control plane
      },
      onTaskCancel: () => {},
      onWorkflowExecute: (workflowId) => {
        if (wsCtx.triggerEvaluator) {
          logger.info(`[daemon] Workflow execute: ${workflowId}`);
          wsCtx.triggerEvaluator.executeById(workflowId).catch(err => {
            logger.error(`[daemon] Workflow ${workflowId} error: ${err instanceof Error ? err.message : err}`);
          });
        } else {
          logger.warn('[daemon] Workflow execute received but trigger evaluator not ready');
        }
      },
    });

    try {
      const connectResponse = await controlPlane.connect();
      wsCtx.businessContext = connectResponse.businessContext;

      // Store plan name as display-only metadata (cloud knows the real plan)
      if (connectResponse.planTier) {
        (config as { planName: string }).planName = connectResponse.planTier;
        logger.info(`[daemon] Plan: ${connectResponse.planTier}`);
      }

      try {
        await saveWorkspaceData(db, 'local', {
          businessName: wsCtx.businessContext.businessName,
          businessType: wsCtx.businessContext.businessType,
          businessDescription: wsCtx.businessContext.businessDescription || '',
          founderPath: '',
          founderFocus: '',
        });
      } catch (syncErr) {
        logger.warn(`[daemon] Could not sync business data: ${syncErr instanceof Error ? syncErr.message : syncErr}`);
      }

      logger.info(`[daemon] Cloud connected. Workspace: ${connectResponse.workspaceId}`);
    } catch (err) {
      logger.warn(`[daemon] Cloud connect failed (offline mode): ${err instanceof Error ? err.message : err}`);
    }
  }

  // Multi-workspace: persist the cloud identity the control plane resolved for
  // this workspace. Future boots use it for mirror detection (above) and for
  // `ohwow workspace info` display. If we had a pinned cloudWorkspaceId and
  // the cloud returned a different one, that signals a license reassignment —
  // refuse rather than silently re-pointing at a different cloud brain.
  if (controlPlane?.connectedWorkspaceId && activeWs?.mode === 'cloud') {
    const resolvedCloudId = controlPlane.connectedWorkspaceId;
    if (activeWs.cloudWorkspaceId && activeWs.cloudWorkspaceId !== resolvedCloudId) {
      throw new Error(
        `Workspace "${workspaceName}" is pinned to cloud workspace ${activeWs.cloudWorkspaceId} ` +
          `but the cloud returned ${resolvedCloudId}. License key may have been reassigned. ` +
          `Re-link the workspace explicitly if this is intentional.`,
      );
    }
    writeWorkspaceConfig(workspaceName, {
      ...activeWs,
      cloudWorkspaceId: resolvedCloudId,
      cloudDeviceId: controlPlane.connectedDeviceId ?? undefined,
      lastConnectAt: new Date().toISOString(),
    });
  }

  // Canonical workspace identity: when the control plane is connected the
  // daemon adopts the cloud Supabase workspace UUID; otherwise it falls back
  // to the "local" sentinel. ALL internal state (orchestrator context, HTTP
  // API auth middleware, triggers, messaging, etc.) must use this single id
  // so that data created via any path lands in the same workspace scope and
  // is visible to every other path.
  //
  // Earlier code split this into local vs cloud identities and that caused
  // a silent fragmentation: contacts inserted via /api/contacts with the
  // "local" scope were invisible to the orchestrator which was querying
  // with the cloud scope (and vice versa). The fix is unification, not
  // splitting.
  const workspaceId = controlPlane?.connectedWorkspaceId || 'local';

  // Workspace consolidation: unify every local SQLite row to the canonical
  // workspace id. If the control plane is connected, that's the cloud
  // Supabase workspace UUID; otherwise it's the "local" sentinel.
  //
  // This fixes a real fragmentation that can happen over the daemon's
  // lifetime: rows can end up scoped to the "local" sentinel (from
  // disconnected-mode inserts or old hardcoded code paths), to the
  // currently-connected cloud workspace id, OR to a previous cloud
  // workspace id if the user ever connected to a different workspace.
  // Without consolidation, each workspace "shard" is silently invisible
  // to code scoped at the canonical id, and the orchestrator sees a
  // subset of the real local state.
  //
  // Idempotent: if all rows already share the canonical id, this is a
  // no-op. Runs once at startup, after the cloud connect handshake.
  const consolidationTables = [
    'agent_workforce_contacts',
    'agent_workforce_contact_events',
    'agent_workforce_agents',
    'agent_workforce_tasks',
    'agent_workforce_task_state',
    'agent_workforce_task_messages',
    'agent_workforce_activity',
    'agent_workforce_knowledge_documents',
    'agent_workforce_knowledge_chunks',
    'agent_workforce_knowledge_agent_config',
    'agent_workforce_deliverables',
    'agent_workforce_projects',
    'agent_workforce_goals',
    'agent_workforce_revenue_entries',
    'agent_workforce_schedules',
    'agent_workforce_sessions',
    'agent_workforce_agent_memory',
    'agent_workforce_memory_extraction_log',
    'agent_workforce_state_changelog',
    'agent_workforce_action_journal',
    'agent_workforce_sequence_runs',
    'agent_workforce_anomaly_alerts',
    'agent_workforce_skills',
    'agent_workforce_digital_twin_snapshots',
    'agent_workforce_nudges',
    'agent_workforce_briefings',
    'agent_workforce_person_models',
    'agent_workforce_person_observations',
    'agent_workforce_operational_pillars',
    'agent_workforce_pillar_instances',
    'agent_workforce_workflows',
    'agent_workforce_workflow_runs',
    'agent_workforce_workflow_triggers',
    'agent_workforce_departments',
    'agent_workforce_team_members',
    'agent_workforce_plans',
    'agent_workforce_plan_steps',
    'agent_workforce_principles',
    'agent_workforce_proactive_runs',
    'agent_workforce_evolution_attempts',
    'agent_workforce_evolution_runs',
    'agent_workforce_lifecycle_events',
    'agent_workforce_tool_recordings',
    'agent_workforce_practice_sessions',
    'agent_workforce_data_store',
    'agent_workforce_routing_stats',
    'agent_workforce_attachments',
    'agent_workforce_shadow_runs',
    // Phase 5 outcome ledger — baseline rows inserted before
    // consolidation were previously orphaned (the probe reads under
    // the canonical id). Unified here so the lift-measurement loop
    // stays visible across the 'local' → cloud-UUID transition.
    'lift_measurements',
  ];
  let totalMigrated = 0;
  const perTable: Record<string, number> = {};
  for (const table of consolidationTables) {
    try {
      // Normalize every row whose workspace_id is NOT already the canonical
      // id. This handles "local" rows, stale cloud-UUID rows from prior
      // connections, AND any other drift. We do not rewrite rows that are
      // already correct so the operation stays cheap on warm restarts.
      const result = rawDb
        .prepare(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id != ?`)
        .run(workspaceId, workspaceId);
      if (result.changes > 0) {
        perTable[table] = result.changes;
        totalMigrated += result.changes;
      }
    } catch {
      // Table may not have a workspace_id column, may not exist on this
      // schema version, or may have unique constraints that conflict. We
      // iterate a broad list on purpose and skip failures silently so the
      // daemon still starts.
    }
  }
  if (totalMigrated > 0) {
    logger.info(
      { perTable, totalMigrated, canonical: workspaceId },
      `[daemon] Workspace consolidation: unified ${totalMigrated} row(s) across ${Object.keys(perTable).length} table(s) to canonical workspace id`,
    );
  }

  // Rename the parent workspaces row too. The child-table pass above
  // rewrites workspace_id on every dependent row to the canonical id,
  // but the agent_workforce_workspaces primary key itself is untouched.
  // When child tables have FK constraints like
  //   workspace_id REFERENCES agent_workforce_workspaces(id)
  // inserts fail because the canonical id has no parent row. This is
  // exactly what blocked start_person_ingestion — team_members rows
  // were already on canonical, but the workspaces row still said
  // "local", so a fresh person_models insert hit FOREIGN KEY
  // constraint failed. Fix by renaming the parent in place.
  try {
    const parentCount = (rawDb
      .prepare('SELECT COUNT(*) AS c FROM agent_workforce_workspaces WHERE id = ?')
      .get(workspaceId) as { c: number } | undefined)?.c ?? 0;
    if (parentCount === 0) {
      const renameResult = rawDb
        .prepare('UPDATE agent_workforce_workspaces SET id = ? WHERE id != ?')
        .run(workspaceId, workspaceId);
      if (renameResult.changes > 0) {
        logger.info(
          { canonical: workspaceId, renamed: renameResult.changes },
          '[daemon] Workspace consolidation: renamed parent workspaces row to canonical id',
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, '[daemon] Workspace parent-row rename skipped');
  }

  wsCtx.controlPlane = controlPlane;
  wsCtx.workspaceId = workspaceId;
}

/**
 * Thin backward-compat wrapper: runs cloud connect + consolidation using
 * fields from a partial DaemonContext (primary workspace). Delegates to
 * consolidateWorkspace after building a WorkspaceContext view over ctx.
 */
export async function connectCloudAndConsolidate(ctx: Partial<DaemonContext>): Promise<void> {
  const { config, db, rawDb, dataDir, workspaceName, businessContext, engine, triggerEvaluator, controlPlane, bus } = ctx as DaemonContext;

  // Build a WorkspaceContext view over the primary DaemonContext fields.
  // We pass ctx's mutable references so consolidateWorkspace can write
  // controlPlane/workspaceId/businessContext back and they are reflected
  // on both the WorkspaceContext and ctx simultaneously.
  const wsCtx: WorkspaceContext = {
    workspaceName: workspaceName ?? 'default',
    workspaceId: ctx.workspaceId ?? 'local',
    dataDir,
    sessionToken: ctx.sessionToken ?? '',
    rawDb,
    db,
    config,
    businessContext: businessContext ?? { businessName: 'My Business', businessType: 'saas_startup' },
    engine: engine ?? null,
    orchestrator: null,
    triggerEvaluator: triggerEvaluator ?? null,
    channelRegistry: null,
    connectorRegistry: null,
    messageRouter: null,
    scheduler: null,
    proactiveEngine: null,
    connectorSyncScheduler: null,
    controlPlane: controlPlane ?? null,
    bus: bus!,
  };

  await consolidateWorkspace(wsCtx);

  // Reflect consolidated values back onto ctx for backward compat.
  ctx.controlPlane = wsCtx.controlPlane;
  ctx.workspaceId = wsCtx.workspaceId;
  ctx.businessContext = wsCtx.businessContext;
}

export function startCloudPolling(ctx: Partial<DaemonContext>): void {
  if (ctx.controlPlane) {
    ctx.controlPlane.startPolling();
    ctx.controlPlane.startHeartbeats();
  }
}
