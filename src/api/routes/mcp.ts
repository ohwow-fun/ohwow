/**
 * MCP Routes
 * POST /api/mcp/test — Test connection to an MCP server and discover tools
 */

import { Router } from 'express';
import { testMcpConnection } from '../../mcp/test-connection.js';
import type { McpServerConfig } from '../../mcp/types.js';
import { logger } from '../../lib/logger.js';
import { validatePublicUrl } from '../../lib/url-validation.js';

export function createMcpRouter(): Router {
  const router = Router();

  router.post('/api/mcp/test', async (req, res) => {
    const server = req.body as McpServerConfig;

    if (!server?.name || !server?.transport) {
      res.status(400).json({ error: 'Invalid server config: name and transport required' });
      return;
    }

    // Block SSRF: validate URL for HTTP transport configs
    if (server.transport === 'http') {
      const urlCheck = validatePublicUrl(server.url);
      if (!urlCheck.valid) {
        res.status(400).json({ error: urlCheck.error });
        return;
      }
    }

    try {
      const result = await testMcpConnection(server);
      res.json(result);
    } catch (err) {
      logger.error({ err }, '[api] MCP test error');
      res.status(500).json({
        success: false,
        tools: [],
        error: err instanceof Error ? err.message : 'Test failed',
        latencyMs: 0,
      });
    }
  });

  return router;
}
