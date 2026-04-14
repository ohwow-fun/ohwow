/**
 * Permission Requests Routes
 *
 * GET  /api/permission-requests              — List tasks paused on a denied
 *                                              filesystem/bash call.
 * POST /api/permission-requests/:taskId/approve
 *                                            — Approve once / approve always /
 *                                              deny. Spawns a child task that
 *                                              re-runs from scratch with the
 *                                              expanded guard.
 *
 * Both endpoints are workspace-scoped via req.workspaceId. The list query
 * filters on (status='needs_approval' AND approval_reason='permission_denied')
 * which is backed by idx_tasks_approval_reason from migration 113.
 *
 * "Approve always" persists the granted path through the existing
 * agent_file_access_paths table — the same storage that ohwow_grant_agent_path
 * writes to — so future runs stay unblocked. "Approve once" stores the path
 * on the new child task's permission_grants column instead, so the grant
 * lives only for the resumed run.
 */

import { Router } from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { RuntimeEngine } from '../../execution/engine.js';
import { logger } from '../../lib/logger.js';

const BLOCKED_PATHS = ['/etc', '/proc', '/sys', '/dev', '/root', '/var', '/boot', '/sbin', '/bin', '/usr'];

function isPathAllowed(resolved: string): boolean {
  const homeDir = os.homedir();
  if (!resolved.startsWith(homeDir + path.sep) && resolved !== homeDir) return false;
  const relative = path.relative(homeDir, resolved);
  const parts = relative.split(path.sep);
  if (parts[0] === '.ssh' || parts[0] === '.gnupg') return false;
  return true;
}

function isAbsolutePathBlocked(resolved: string): boolean {
  for (const blocked of BLOCKED_PATHS) {
    if (resolved === blocked || resolved.startsWith(blocked + path.sep)) return true;
  }
  return false;
}

interface PermissionRequestPayload {
  tool_name: string;
  attempted_path: string;
  suggested_exact: string;
  suggested_parent: string;
  guard_reason: string;
  iteration: number | null;
  timestamp: string;
}

function parsePermissionRequest(raw: unknown): PermissionRequestPayload | null {
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return null;
    const o = obj as Record<string, unknown>;
    return {
      tool_name: String(o.tool_name ?? ''),
      attempted_path: String(o.attempted_path ?? ''),
      suggested_exact: String(o.suggested_exact ?? ''),
      suggested_parent: String(o.suggested_parent ?? ''),
      guard_reason: String(o.guard_reason ?? ''),
      iteration: typeof o.iteration === 'number' ? o.iteration : null,
      timestamp: String(o.timestamp ?? ''),
    };
  } catch {
    return null;
  }
}

export function createPermissionRequestsRouter(
  db: DatabaseAdapter,
  engine?: RuntimeEngine | null,
): Router {
  const router = Router();

  router.get('/api/permission-requests', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('agent_workforce_tasks')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('status', 'needs_approval')
        .eq('approval_reason', 'permission_denied')
        .order('created_at', { ascending: false });

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      const rows = (data ?? []) as Array<Record<string, unknown>>;
      // Resolve agent names in one query to avoid N+1.
      const agentIds = Array.from(new Set(rows.map((r) => String(r.agent_id))));
      const agentNames: Record<string, string> = {};
      if (agentIds.length > 0) {
        const { data: agentRows } = await db.from('agent_workforce_agents')
          .select('id, name')
          .in('id', agentIds);
        for (const a of (agentRows ?? []) as Array<{ id: string; name: string }>) {
          agentNames[a.id] = a.name;
        }
      }

      const requests = rows
        .map((row) => {
          const request = parsePermissionRequest(row.permission_request);
          if (!request) return null;
          return {
            task_id: String(row.id),
            agent_id: String(row.agent_id),
            agent_name: agentNames[String(row.agent_id)] ?? null,
            task_title: String(row.title ?? ''),
            request,
            created_at: String(row.created_at ?? ''),
            updated_at: String(row.updated_at ?? ''),
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      res.json({ data: requests });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/permission-requests/:taskId/approve', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { taskId } = req.params;
      const { mode, scope, path: customPath } = req.body as {
        mode?: 'once' | 'always' | 'deny';
        scope?: 'exact' | 'parent' | 'edit';
        path?: string;
      };

      if (!mode || !['once', 'always', 'deny'].includes(mode)) {
        res.status(400).json({ error: 'mode must be "once", "always", or "deny"' });
        return;
      }

      const { data: taskRow } = await db.from('agent_workforce_tasks')
        .select('*')
        .eq('id', taskId)
        .eq('workspace_id', workspaceId)
        .single();

      if (!taskRow) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      const row = taskRow as Record<string, unknown>;
      if (row.status !== 'needs_approval' || row.approval_reason !== 'permission_denied') {
        res.status(409).json({ error: 'Task is not awaiting a permission decision' });
        return;
      }

      const request = parsePermissionRequest(row.permission_request);
      if (!request) {
        res.status(500).json({ error: 'Permission request payload is missing or malformed' });
        return;
      }

      const agentId = String(row.agent_id);
      const now = new Date().toISOString();

      // ── Deny path ─────────────────────────────────────────────────
      if (mode === 'deny') {
        await db.from('agent_workforce_tasks').update({
          status: 'failed',
          error_message: `Permission denied by operator: ${request.tool_name} on ${request.attempted_path}`,
          failure_category: 'permission_denied',
          completed_at: now,
          updated_at: now,
        }).eq('id', taskId);

        try {
          await db.rpc('create_agent_activity', {
            p_workspace_id: workspaceId,
            p_activity_type: 'permission_denied',
            p_title: `Operator denied access to ${request.suggested_exact}`,
            p_description: `${request.tool_name}: original task ${taskId.slice(0, 8)}`,
            p_agent_id: agentId,
            p_task_id: taskId,
            p_metadata: { runtime: true },
          });
        } catch { /* non-fatal */ }

        res.json({ ok: true, mode: 'deny', task_id: taskId });
        return;
      }

      // ── Resolve the path the operator wants to grant ──────────────
      const effectiveScope = scope ?? 'exact';
      let grantedPath: string;
      if (effectiveScope === 'edit') {
        if (!customPath) {
          res.status(400).json({ error: 'scope="edit" requires a `path` body field' });
          return;
        }
        grantedPath = path.resolve(customPath);
      } else if (effectiveScope === 'parent') {
        grantedPath = request.suggested_parent;
      } else {
        grantedPath = request.suggested_exact;
      }

      if (isAbsolutePathBlocked(grantedPath)) {
        res.status(403).json({ error: 'Granted path lands in a blocked system directory' });
        return;
      }
      if (!isPathAllowed(grantedPath)) {
        res.status(403).json({ error: 'Granted path must live inside your home directory' });
        return;
      }

      // ── Persist the grant if "always" ─────────────────────────────
      if (mode === 'always') {
        const { data: existing } = await db.from('agent_file_access_paths')
          .select('id')
          .eq('agent_id', agentId)
          .eq('path', grantedPath)
          .maybeSingle();

        if (!existing) {
          const { error: insertErr } = await db.from('agent_file_access_paths').insert({
            agent_id: agentId,
            workspace_id: workspaceId,
            path: grantedPath,
            label: `granted via permission request ${taskId.slice(0, 8)}`,
          });
          if (insertErr) {
            res.status(500).json({ error: insertErr.message });
            return;
          }
        }
      }

      // ── Spawn the child task that resumes the work ────────────────
      const childTaskId = crypto.randomUUID();
      const childInsert: Record<string, unknown> = {
        id: childTaskId,
        agent_id: agentId,
        workspace_id: workspaceId,
        title: row.title,
        description: row.description ?? null,
        input: row.input,
        status: 'pending',
        priority: row.priority ?? 'normal',
        parent_task_id: taskId,
        resumed_from_task_id: taskId,
        goal_id: row.goal_id ?? null,
        // Inherit the trigger back-link so a successful resume resets
        // the watchdog counter. Without this, every permission-paused
        // cron would keep consecutive_failures incremented even after
        // the operator approved and the child ran cleanly.
        source_trigger_id: row.source_trigger_id ?? null,
        created_at: now,
        updated_at: now,
      };
      // "Approve once": carry the grant on the child row only.
      if (mode === 'once') {
        childInsert.permission_grants = JSON.stringify([grantedPath]);
      }

      const { error: childErr } = await db.from('agent_workforce_tasks').insert(childInsert);
      if (childErr) {
        res.status(500).json({ error: childErr.message });
        return;
      }

      // Mark the original task approved so it leaves the queue.
      await db.from('agent_workforce_tasks').update({
        status: 'approved',
        updated_at: now,
      }).eq('id', taskId);

      try {
        await db.rpc('create_agent_activity', {
          p_workspace_id: workspaceId,
          p_activity_type: 'permission_approved',
          p_title: `Operator granted access to ${grantedPath}`,
          p_description: `${request.tool_name}: resumed as task ${childTaskId.slice(0, 8)}`,
          p_agent_id: agentId,
          p_task_id: taskId,
          p_metadata: { runtime: true, mode, scope: effectiveScope, child_task_id: childTaskId },
        });
      } catch { /* non-fatal */ }

      // Fire-and-forget the child execution so the operator's POST
      // returns immediately while the work resumes in the background.
      if (engine) {
        engine.executeTask(agentId, childTaskId).catch(async (err) => {
          logger.error({ err, taskId: childTaskId, agentId }, '[PermissionRoute] Resumed task failed');
          try {
            await db.from('agent_workforce_tasks').update({
              status: 'failed',
              error_message: err instanceof Error ? err.message : 'Resumed task failed unexpectedly',
              updated_at: new Date().toISOString(),
            }).eq('id', childTaskId);
            await db.from('agent_workforce_agents').update({
              status: 'idle',
              updated_at: new Date().toISOString(),
            }).eq('id', agentId);
          } catch { /* best effort */ }
        });
      }

      res.json({
        ok: true,
        mode,
        scope: effectiveScope,
        granted_path: grantedPath,
        task_id: taskId,
        child_task_id: childTaskId,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
