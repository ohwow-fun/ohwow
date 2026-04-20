import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  listWorkspaces,
  workspaceLayoutFor,
  readWorkspaceConfig,
  portForWorkspace,
  dashboardUrlForWorkspace,
  resolveActiveWorkspace,
  isValidWorkspaceName,
  allocateWorkspacePort,
  writeWorkspaceConfig,
} from '../../config.js';
import type { WorkspaceConfig, WorkspaceMode } from '../../config.js';
import { signDaemonToken } from '../../daemon/token-codec.js';
import type { WorkspaceRegistry } from '../../daemon/workspace-registry.js';

export interface WorkspaceRouterDeps {
  registry?: WorkspaceRegistry;
  jwtSecret: string;
}

export function createWorkspacesRouter(deps: WorkspaceRouterDeps): Router {
  const router = Router();
  const { registry, jwtSecret } = deps;

  router.get('/api/workspaces', async (_req: Request, res: Response) => {
    try {
      const allNames = listWorkspaces();
      const activeLayout = resolveActiveWorkspace();

      const results = await Promise.allSettled(
        allNames.map(async (name) => {
          const wsCfg = readWorkspaceConfig(name);
          const port = portForWorkspace(name);

          let running = false;
          if (port !== null) {
            try {
              const r = await fetch(`http://localhost:${port}/health`, {
                signal: AbortSignal.timeout(1500),
              });
              running = r.ok;
            } catch {
              running = false;
            }
          }

          return {
            name,
            displayName: wsCfg?.displayName ?? name,
            mode: wsCfg?.mode ?? 'local-only',
            port: port ?? null,
            running,
            loaded: registry?.has(name) ?? false,
            isActive: name === activeLayout.name,
          };
        }),
      );

      const workspaces = results
        .filter((r): r is PromiseFulfilledResult<{
          name: string; displayName: string; mode: WorkspaceMode;
          port: number | null; running: boolean; loaded: boolean; isActive: boolean;
        }> => r.status === 'fulfilled')
        .map((r) => r.value);

      res.json({ data: workspaces });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list workspaces' });
    }
  });

  router.post('/api/workspaces/create', async (req: Request, res: Response) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? '';
    const isLocal =
      ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
    if (!isLocal) {
      res.status(403).json({ error: 'Workspace creation is only available locally' });
      return;
    }

    const { workspaceName, mode, licenseKey, displayName, businessName, businessType,
            businessDescription, founderPath, agents, goal } = req.body as {
      workspaceName?: string; mode?: 'local-only' | 'cloud'; licenseKey?: string;
      displayName?: string; businessName?: string; businessType?: string;
      businessDescription?: string; founderPath?: string;
      agents?: Array<{ id: string; name: string; [key: string]: unknown }>;
      goal?: { title: string; metric?: string; target?: number; unit?: string };
    };

    if (!workspaceName) {
      res.status(400).json({ error: 'workspaceName is required' });
      return;
    }
    if (!isValidWorkspaceName(workspaceName)) {
      res.status(400).json({ error: 'workspaceName must start with a letter or digit and contain only letters, digits, hyphens, or underscores' });
      return;
    }

    const resolvedMode: 'local-only' | 'cloud' = mode === 'cloud' ? 'cloud' : 'local-only';
    if (resolvedMode === 'cloud' && !licenseKey) {
      res.status(400).json({ error: 'licenseKey is required when mode is cloud' });
      return;
    }

    const existingNames = listWorkspaces();
    if (existingNames.includes(workspaceName)) {
      res.status(409).json({ error: `Workspace '${workspaceName}' already exists` });
      return;
    }

    let port: number;
    try {
      port = allocateWorkspacePort();
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Could not allocate port' });
      return;
    }

    const wsCfg: WorkspaceConfig = {
      schemaVersion: 1,
      mode: resolvedMode,
      port,
      ...(displayName ? { displayName } : {}),
      ...(resolvedMode === 'cloud' && licenseKey ? { licenseKey } : {}),
    };

    try {
      writeWorkspaceConfig(workspaceName, wsCfg);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Could not write workspace config' });
      return;
    }

    const layout = workspaceLayoutFor(workspaceName);
    if (!existsSync(layout.dataDir)) {
      mkdirSync(layout.dataDir, { recursive: true });
    }

    const tokenPath = join(layout.dataDir, 'daemon.token');
    try {
      const token = jwtSecret
        ? await signDaemonToken(workspaceName, jwtSecret)
        : randomUUID();
      writeFileSync(tokenPath, token, { mode: 0o600 });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Could not write daemon token' });
      return;
    }

    if (businessName || (agents && agents.length > 0) || goal?.title) {
      try {
        const { initDatabase } = await import('../../db/init.js');
        const { createSqliteAdapter } = await import('../../db/sqlite-adapter.js');
        const { createRpcHandlers } = await import('../../db/rpc-handlers.js');
        const { saveWorkspaceData, createAgentsFromPresets } = await import('../../lib/onboarding-logic.js');

        const wsRawDb = initDatabase(layout.dbPath);
        const wsRpcHandlers = createRpcHandlers(wsRawDb);
        const wsDb = createSqliteAdapter(wsRawDb, { rpcHandlers: wsRpcHandlers });

        if (businessName) {
          await saveWorkspaceData(wsDb, workspaceName, {
            businessName,
            businessType: businessType ?? '',
            businessDescription: businessDescription ?? '',
            founderPath: founderPath ?? '',
            founderFocus: '',
          });
        }

        if (agents && agents.length > 0) {
          await createAgentsFromPresets(wsDb, agents as never, workspaceName, 'qwen3:4b');
        }

        if (goal?.title) {
          const now = new Date().toISOString();
          await wsDb.from('agent_workforce_goals').insert({
            id: randomUUID(), workspace_id: workspaceName,
            title: goal.title, description: null,
            target_metric: goal.metric ?? null, target_value: goal.target ?? null,
            current_value: 0, unit: goal.unit ?? null,
            status: 'active', priority: 'high', color: '#6366f1',
            position: 0, created_at: now, updated_at: now,
          });
        }

        wsRawDb.close();
      } catch {
        // non-fatal — workspace config + token already written
      }
    }

    res.json({ data: { workspaceName, port, dashboardUrl: dashboardUrlForWorkspace(workspaceName) } });
  });

  return router;
}
