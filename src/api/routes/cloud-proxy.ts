/**
 * Cloud Proxy Routes
 * Proxies requests to ohwow.fun via the control-plane session.
 * Used by MCP tools that need cloud data (sites, integrations).
 */

import { Router } from 'express';
import type { ControlPlaneClient } from '../../control-plane/client.js';

export function createCloudProxyRouter(controlPlane: ControlPlaneClient | null): Router {
  const router = Router();

  router.get('/api/cloud/sites', async (_req, res) => {
    if (!controlPlane?.connectedWorkspaceId) {
      res.json({ cloudConnected: false, data: [] });
      return;
    }

    const result = await controlPlane.proxyCloudGet(
      `/api/sites?workspaceId=${controlPlane.connectedWorkspaceId}`,
    );

    if (!result.ok) {
      res.json({ cloudConnected: true, error: result.error, data: [] });
      return;
    }

    res.json({ cloudConnected: true, data: result.data });
  });

  router.get('/api/cloud/integrations', async (_req, res) => {
    if (!controlPlane?.connectedWorkspaceId) {
      res.json({ cloudConnected: false, data: [] });
      return;
    }

    const result = await controlPlane.proxyCloudGet(
      `/api/integrations/status?workspaceId=${controlPlane.connectedWorkspaceId}`,
    );

    if (!result.ok) {
      res.json({ cloudConnected: true, error: result.error, data: [] });
      return;
    }

    res.json({ cloudConnected: true, data: result.data });
  });

  return router;
}
