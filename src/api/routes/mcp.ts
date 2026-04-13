/**
 * MCP Routes
 *
 * POST   /api/mcp/test                 — Test an ad-hoc server config (used by TUI wizard)
 * GET    /api/mcp/servers              — List registered workspace MCP servers (redacted)
 * POST   /api/mcp/servers              — Register a new workspace MCP server
 * DELETE /api/mcp/servers/:name        — Remove a workspace MCP server
 * POST   /api/mcp/servers/:name/test   — Connect to a registered server and return tool names
 *
 * Credential handling
 * -------------------
 * Server configs (including any bearer tokens, API keys, `headers`, or stdio
 * `env`) are persisted in the per-workspace SQLite under
 * `runtime_settings.global_mcp_servers` — the same row the TUI wizard writes.
 * Rows are scoped to the workspace DB (`~/.ohwow/workspaces/<name>/data.db`)
 * and inherit that file's permissions.
 *
 * The GET/list route NEVER returns raw credentials — it reports
 * `Authorization: <set>` / `env.KEY: <set>` instead. The write route logs at
 * info level with the same redaction applied.
 *
 * These routes are registered under the daemon's bearer-auth middleware, so
 * only callers with the workspace daemon token can reach them.
 */

import { Router } from 'express';
import { testMcpConnection } from '../../mcp/test-connection.js';
import type { McpServerConfig } from '../../mcp/types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { LocalOrchestrator } from '../../orchestrator/local-orchestrator.js';
import { logger } from '../../lib/logger.js';
import { validatePublicUrl } from '../../lib/url-validation.js';

const RUNTIME_SETTINGS_KEY = 'global_mcp_servers';

/** Shape of a list/summary entry. Credentials are replaced with `<set>` flags. */
interface McpServerSummary {
  name: string;
  transport: McpServerConfig['transport'];
  description?: string;
  enabled: boolean;
  url?: string;
  command?: string;
  args?: string[];
  /** Header names present, with values replaced by `<set>`. */
  headers?: Record<string, '<set>'>;
  /** Env var names present, with values replaced by `<set>`. */
  env?: Record<string, '<set>'>;
  /** Set when the config carries a structured auth block (e.g. bearer/oauth2). */
  authType?: 'bearer' | 'api_key' | 'oauth2';
  toolCount?: number;
}

/**
 * Read the persisted server list. Returns [] when the row doesn't exist or
 * cannot be coerced to an array.
 *
 * The SQLite adapter (src/db/sqlite-adapter.ts:175) auto-parses any column
 * value that looks like JSON before returning it, so by the time we see
 * `data.value` it is ALREADY a parsed array — calling JSON.parse() on it
 * would coerce the array to "[object Object]" and throw. We accept either
 * shape defensively in case the adapter behavior changes.
 */
async function loadServers(db: DatabaseAdapter): Promise<McpServerConfig[]> {
  const { data } = await db
    .from('runtime_settings')
    .select('value')
    .eq('key', RUNTIME_SETTINGS_KEY)
    .maybeSingle();
  if (!data) return [];
  const raw = (data as { value: unknown }).value;
  if (Array.isArray(raw)) {
    return raw as McpServerConfig[];
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as McpServerConfig[]) : [];
    } catch (err) {
      logger.warn(
        { err, key: RUNTIME_SETTINGS_KEY },
        '[api] runtime_settings.global_mcp_servers could not be parsed; treating as empty',
      );
      return [];
    }
  }
  return [];
}

async function saveServers(db: DatabaseAdapter, servers: McpServerConfig[]): Promise<void> {
  const value = JSON.stringify(servers);
  const now = new Date().toISOString();
  const { data: existing } = await db
    .from('runtime_settings')
    .select('key')
    .eq('key', RUNTIME_SETTINGS_KEY)
    .maybeSingle();
  if (existing) {
    await db.from('runtime_settings').update({ value, updated_at: now }).eq('key', RUNTIME_SETTINGS_KEY);
  } else {
    await db.from('runtime_settings').insert({ key: RUNTIME_SETTINGS_KEY, value, updated_at: now });
  }
}

/** Redact a server config into a summary safe for list responses and logs. */
function redact(server: McpServerConfig & { description?: string; enabled?: boolean }): McpServerSummary {
  const base: McpServerSummary = {
    name: server.name,
    transport: server.transport,
    enabled: server.enabled !== false,
    ...(server.description ? { description: server.description } : {}),
  };
  if (server.transport === 'http') {
    base.url = server.url;
    if (server.headers && Object.keys(server.headers).length > 0) {
      base.headers = Object.fromEntries(
        Object.keys(server.headers).map((k) => [k, '<set>' as const]),
      );
    }
    if (server.auth) {
      base.authType = server.auth.type;
    }
  } else if (server.transport === 'stdio') {
    base.command = server.command;
    if (server.args && server.args.length > 0) base.args = server.args;
    if (server.env && Object.keys(server.env).length > 0) {
      base.env = Object.fromEntries(
        Object.keys(server.env).map((k) => [k, '<set>' as const]),
      );
    }
  }
  return base;
}

export function createMcpRouter(
  db: DatabaseAdapter | null,
  orchestrator: LocalOrchestrator | null,
): Router {
  const router = Router();

  // ───────────────────────────────────────────────────────────────────
  // Legacy: test an ad-hoc config (TUI wizard)
  // ───────────────────────────────────────────────────────────────────
  router.post('/api/mcp/test', async (req, res) => {
    const server = req.body as McpServerConfig;

    if (!server?.name || !server?.transport) {
      res.status(400).json({ error: 'Invalid server config: name and transport required' });
      return;
    }

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

  // ───────────────────────────────────────────────────────────────────
  // GET /api/mcp/servers — list (redacted)
  // ───────────────────────────────────────────────────────────────────
  router.get('/api/mcp/servers', async (_req, res) => {
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }
    try {
      const servers = await loadServers(db);
      const summaries = servers.map((s) => redact(s));
      res.json({ servers: summaries });
    } catch (err) {
      logger.error({ err }, '[api] MCP list error');
      res.status(500).json({ error: err instanceof Error ? err.message : 'List failed' });
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // POST /api/mcp/servers — register a new server
  // ───────────────────────────────────────────────────────────────────
  router.post('/api/mcp/servers', async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }
    // The body is untyped JSON from an HTTP client; narrow manually below
    // because `Partial<McpServerConfig>` over a discriminated union collapses
    // to only the first variant's fields.
    const body = (req.body ?? {}) as {
      name?: string;
      transport?: string;
      url?: string;
      command?: string;
      args?: string[];
      headers?: Record<string, string>;
      env?: Record<string, string>;
      auth?: unknown;
      description?: string;
      enabled?: boolean;
    };

    if (!body?.name || typeof body.name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!/^[a-z0-9][a-z0-9-_]{0,62}$/i.test(body.name)) {
      res.status(400).json({
        error: 'name must be alphanumeric with optional dashes/underscores (max 63 chars)',
      });
      return;
    }
    if (!body.transport || (body.transport !== 'http' && body.transport !== 'stdio')) {
      res.status(400).json({ error: 'transport must be "http" or "stdio"' });
      return;
    }

    // Build the concrete McpServerConfig. We preserve the discriminated-union
    // shape from src/mcp/types.ts so connection code can use it unchanged.
    let serverConfig: McpServerConfig & { description?: string; enabled?: boolean };
    if (body.transport === 'http') {
      if (!body.url || typeof body.url !== 'string') {
        res.status(400).json({ error: 'url is required for http transport' });
        return;
      }
      const urlCheck = validatePublicUrl(body.url);
      if (!urlCheck.valid) {
        res.status(400).json({ error: urlCheck.error });
        return;
      }
      serverConfig = {
        name: body.name,
        transport: 'http',
        url: body.url,
        ...(body.headers && typeof body.headers === 'object'
          ? { headers: body.headers as Record<string, string> }
          : {}),
        ...(body.auth ? { auth: body.auth as import('../../mcp/types.js').McpAuthConfig } : {}),
      };
    } else {
      if (!body.command || typeof body.command !== 'string') {
        res.status(400).json({ error: 'command is required for stdio transport' });
        return;
      }
      serverConfig = {
        name: body.name,
        transport: 'stdio',
        command: body.command,
        ...(Array.isArray(body.args) ? { args: body.args as string[] } : {}),
        ...(body.env && typeof body.env === 'object'
          ? { env: body.env as Record<string, string> }
          : {}),
      };
    }
    // Attach sidecar fields — not part of the runtime transport union but
    // persisted for list/UI display. Stored on the same row.
    if (body.description) (serverConfig as McpServerConfig & { description: string }).description = body.description;
    if (body.enabled === false) (serverConfig as McpServerConfig & { enabled: boolean }).enabled = false;

    try {
      const existing = await loadServers(db);
      if (existing.some((s) => s.name === body.name)) {
        res.status(409).json({ error: `MCP server "${body.name}" already exists` });
        return;
      }
      const next = [...existing, serverConfig];
      await saveServers(db, next);

      // Force the orchestrator to reload so the new server is live
      // immediately without restarting the daemon.
      if (orchestrator) {
        try {
          await orchestrator.reloadMcpServers();
        } catch (err) {
          logger.warn({ err }, '[api] MCP orchestrator reload failed (will retry on next chat)');
        }
      }

      logger.info(
        { server: redact(serverConfig) },
        '[api] Registered MCP server',
      );

      res.json({ ok: true, server: redact(serverConfig) });
    } catch (err) {
      logger.error({ err }, '[api] MCP register error');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Register failed' });
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // DELETE /api/mcp/servers/:name — remove by name
  // ───────────────────────────────────────────────────────────────────
  router.delete('/api/mcp/servers/:name', async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }
    const { name } = req.params;
    try {
      const existing = await loadServers(db);
      if (!existing.some((s) => s.name === name)) {
        res.status(404).json({ error: `MCP server "${name}" not found` });
        return;
      }
      const next = existing.filter((s) => s.name !== name);
      await saveServers(db, next);
      if (orchestrator) {
        try {
          await orchestrator.reloadMcpServers();
        } catch (err) {
          logger.warn({ err }, '[api] MCP orchestrator reload failed after remove');
        }
      }
      logger.info({ name }, '[api] Removed MCP server');
      res.json({ ok: true, removed: name });
    } catch (err) {
      logger.error({ err }, '[api] MCP remove error');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Remove failed' });
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // POST /api/mcp/servers/:name/test — verify a registered server
  // ───────────────────────────────────────────────────────────────────
  router.post('/api/mcp/servers/:name/test', async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }
    const { name } = req.params;
    try {
      const existing = await loadServers(db);
      const found = existing.find((s) => s.name === name);
      if (!found) {
        res.status(404).json({ error: `MCP server "${name}" not found` });
        return;
      }
      const result = await testMcpConnection(found);
      // Return only tool names; never schemas or descriptions that could
      // accidentally include connection strings.
      res.json({
        success: result.success,
        latencyMs: result.latencyMs,
        toolCount: result.tools.length,
        toolNames: result.tools.map((t) => t.name),
        ...(result.error ? { error: result.error } : {}),
      });
    } catch (err) {
      logger.error({ err }, '[api] MCP test-by-name error');
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Test failed',
      });
    }
  });

  return router;
}
