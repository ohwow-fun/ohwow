/**
 * A2A Connections Routes
 * CRUD for a2a_connections + connection test.
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { validatePublicUrl } from '../../lib/url-validation.js';

export function createA2ARouter(db: DatabaseAdapter): Router {
  const router = Router();

  // List connections
  router.get('/api/a2a/connections', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('a2a_connections')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false });

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Create connection
  router.post('/api/a2a/connections', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { name, description, agent_card_url, endpoint_url, auth_type, trust_level } = req.body;

      if (!name || !agent_card_url || !endpoint_url) {
        res.status(400).json({ error: 'name, agent_card_url, and endpoint_url are required' });
        return;
      }

      // SSRF protection: validate URLs before storing
      const cardUrlCheck = validatePublicUrl(agent_card_url);
      if (!cardUrlCheck.valid) {
        res.status(400).json({ error: `Invalid agent_card_url: ${cardUrlCheck.error}` });
        return;
      }
      const endpointUrlCheck = validatePublicUrl(endpoint_url);
      if (!endpointUrlCheck.valid) {
        res.status(400).json({ error: `Invalid endpoint_url: ${endpointUrlCheck.error}` });
        return;
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const { error } = await db.from('a2a_connections').insert({
        id,
        workspace_id: workspaceId,
        name,
        description: description || null,
        agent_card_url,
        endpoint_url,
        auth_type: auth_type || 'none',
        trust_level: trust_level || 'read_only',
        status: 'pending',
        created_at: now,
        updated_at: now,
      });

      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('a2a_connections')
        .select('*').eq('id', id).single();

      res.status(201).json({ connection: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Delete connection
  router.delete('/api/a2a/connections/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { error } = await db.from('a2a_connections')
        .delete()
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: { id: req.params.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Test connection
  router.post('/api/a2a/connections/:id/test', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data: conn, error } = await db.from('a2a_connections')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .maybeSingle();

      if (error) { res.status(500).json({ error: error.message }); return; }
      if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

      const connection = conn as { agent_card_url: string; id: string };

      // SSRF protection: validate URL before fetching
      const urlCheck = validatePublicUrl(connection.agent_card_url);
      if (!urlCheck.valid) {
        res.status(400).json({ error: `Unsafe agent_card_url: ${urlCheck.error}` });
        return;
      }

      // Try to fetch the agent card
      try {
        const response = await fetch(connection.agent_card_url, {
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          const card = await response.json();
          await db.from('a2a_connections')
            .update({
              status: 'active',
              last_health_check_at: new Date().toISOString(),
              last_health_status: 'ok',
              agent_card_cache: JSON.stringify(card),
              agent_card_fetched_at: new Date().toISOString(),
              consecutive_failures: 0,
              updated_at: new Date().toISOString(),
            })
            .eq('id', connection.id);

          res.json({ data: { status: 'active', card } });
        } else {
          await db.from('a2a_connections')
            .update({
              status: 'error',
              last_health_check_at: new Date().toISOString(),
              last_health_status: `HTTP ${response.status}`,
              updated_at: new Date().toISOString(),
            })
            .eq('id', connection.id);

          res.json({ data: { status: 'error', message: `HTTP ${response.status}` } });
        }
      } catch (fetchErr) {
        await db.from('a2a_connections')
          .update({
            status: 'error',
            last_health_check_at: new Date().toISOString(),
            last_health_status: fetchErr instanceof Error ? fetchErr.message : 'Connection failed',
            updated_at: new Date().toISOString(),
          })
          .eq('id', connection.id);

        res.json({ data: { status: 'error', message: fetchErr instanceof Error ? fetchErr.message : 'Connection failed' } });
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });


  // /.well-known/agent.json — A2A agent card (no auth required, public)
  router.get('/.well-known/agent.json', async (req, res) => {
    try {
      const baseUrl = process.env.OHWOW_PUBLIC_URL || 'http://localhost:7700';
      const card = {
        name: 'ohwow runtime',
        description: 'Local-first AI business operating system with autonomous agents',
        url: baseUrl,
        version: '1.0.0',
        capabilities: {
          streaming: false,
          pushNotifications: false,
          stateTransitionHistory: false,
        },
        authentication: {
          schemes: ['bearer'],
        },
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        skills: [],
      };
      res.set('Content-Type', 'application/json');
      res.json(card);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
