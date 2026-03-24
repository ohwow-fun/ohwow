/**
 * Orchestrator Routes
 * POST /api/chat — Chat with orchestrator via SSE streaming
 * CRUD for /api/orchestrator/sessions — Manage chat sessions
 */

import { Router } from 'express';
import type { LocalOrchestrator } from '../../orchestrator/local-orchestrator.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function createOrchestratorRouter(orchestrator: LocalOrchestrator): Router {
  const router = Router();

  // Helper to access orchestrator's db and workspaceId
  const getDb = () => (orchestrator as any).db;
  const getWorkspaceId = () => (orchestrator as any).workspaceId as string;

  // ── Session CRUD ──────────────────────────────────────────────────

  // List sessions (optional ?target_type=&target_id= query params)
  router.get('/api/orchestrator/sessions', async (req, res) => {
    try {
      const db = getDb();
      const targetType = req.query.target_type as string | undefined;
      const targetId = req.query.target_id as string | undefined;

      let query = db
        .from('orchestrator_chat_sessions')
        .select('id, title, messages, message_count, device_name, target_type, target_id, created_at, updated_at')
        .order('updated_at', { ascending: false })
        .limit(50);

      if (targetType) query = query.eq('target_type', targetType);
      if (targetId) query = query.eq('target_id', targetId);

      const { data, error } = await query;
      if (error) { res.status(500).json({ error: error.message }); return; }

      const sessions = (data || []).map((row: any) => {
        // Use stored message_count; fall back to parsing messages JSON if 0
        let msgCount = row.message_count || 0;
        if (msgCount === 0) {
          const msgs = typeof row.messages === 'string' ? JSON.parse(row.messages) : (row.messages || []);
          msgCount = Array.isArray(msgs) ? msgs.length : 0;
        }
        return {
          id: row.id,
          title: row.title,
          message_count: msgCount,
          device_name: row.device_name || null,
          target_type: row.target_type || 'orchestrator',
          target_id: row.target_id || null,
          created_at: row.created_at,
          updated_at: row.updated_at,
        };
      });

      res.json({ sessions });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get a single session by ID
  router.get('/api/orchestrator/sessions/:id', async (req, res) => {
    try {
      const db = getDb();
      const { data, error } = await db
        .from('orchestrator_chat_sessions')
        .select('*')
        .eq('id', req.params.id)
        .single();

      if (error || !data) { res.status(404).json({ error: 'Session not found' }); return; }

      const row = data as any;
      const messages = typeof row.messages === 'string' ? JSON.parse(row.messages) : row.messages;
      res.json({ ...row, messages });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Create a new session
  router.post('/api/orchestrator/sessions', async (req, res) => {
    try {
      const db = getDb();
      const { title, messages, target_type, target_id } = req.body as {
        title?: string;
        messages?: { role: string; content: string }[];
        target_type?: string;
        target_id?: string;
      };

      const id = crypto.randomUUID();
      const { error } = await db
        .from('orchestrator_chat_sessions')
        .insert({
          id,
          workspace_id: getWorkspaceId(),
          title: (title || 'New conversation').slice(0, 60),
          messages: JSON.stringify(messages || []),
          target_type: target_type || 'orchestrator',
          target_id: target_id || null,
        });

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.status(201).json({ id, title: title || 'New conversation', target_type: target_type || 'orchestrator', target_id: target_id || null });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Update a session
  router.put('/api/orchestrator/sessions/:id', async (req, res) => {
    try {
      const db = getDb();
      const { title, messages } = req.body as {
        title?: string;
        messages?: { role: string; content: string }[];
      };

      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (messages) updates.messages = JSON.stringify(messages);
      if (title) updates.title = title.slice(0, 60);

      const { error } = await db
        .from('orchestrator_chat_sessions')
        .update(updates)
        .eq('id', req.params.id);

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Rename a session
  router.patch('/api/orchestrator/sessions/:id/rename', async (req, res) => {
    try {
      const db = getDb();
      const { title } = req.body as { title?: string };
      if (!title || !title.trim()) {
        res.status(400).json({ error: 'title is required' });
        return;
      }

      const { error } = await db
        .from('orchestrator_chat_sessions')
        .update({
          title: title.trim().slice(0, 60),
          updated_at: new Date().toISOString(),
        })
        .eq('id', req.params.id);

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Delete a session
  router.delete('/api/orchestrator/sessions/:id', async (req, res) => {
    try {
      const db = getDb();
      const { error } = await db
        .from('orchestrator_chat_sessions')
        .delete()
        .eq('id', req.params.id);

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── Chat ──────────────────────────────────────────────────────────

  // Chat with SSE streaming
  router.post('/api/chat', async (req, res) => {
    try {
      const { message, sessionId, model, modelSource, messages } = req.body as {
        message?: string;
        sessionId?: string;
        model?: string;
        modelSource?: 'local' | 'cloud';
        messages?: { role: 'user' | 'assistant'; content: string }[];
      };

      if (!message) {
        res.status(400).json({ error: 'Message is required' });
        return;
      }

      const session = sessionId || crypto.randomUUID();

      // Set model override if provided
      if (model) {
        orchestrator.setOrchestratorModel(model);
      }

      // Set model source if provided — ensures every chat self-corrects the source
      if (modelSource) {
        orchestrator.setModelSource(modelSource);
      }

      // Convert prior messages to seed history (cloud proxy path)
      const seedMessages = messages && messages.length > 0
        ? messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
        : undefined;

      // Set up SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Session-Id', session);
      res.flushHeaders();

      for await (const event of orchestrator.chat(message, session, seedMessages)) {
        const data = JSON.stringify(event);
        res.write(`data: ${data}\n\n`);
      }

      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      // If headers already sent, just end the stream
      if (res.headersSent) {
        const errorData = JSON.stringify({ type: 'error', error: err instanceof Error ? err.message : 'Internal error' });
        res.write(`data: ${errorData}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
      }
    }
  });

  // Update Anthropic API key at runtime (called after model picker saves key to disk)
  router.post('/api/set-api-key', (req, res) => {
    const { apiKey } = req.body as { apiKey?: string };
    if (!apiKey) {
      res.status(400).json({ error: 'apiKey is required' });
      return;
    }
    orchestrator.setAnthropicApiKey(apiKey);
    res.json({ ok: true });
  });

  // Resolve a pending permission request
  router.post('/api/permission-response', (req, res) => {
    const { requestId, granted } = req.body as { requestId?: string; granted?: boolean };
    if (!requestId) {
      res.status(400).json({ error: 'requestId is required' });
      return;
    }
    orchestrator.resolvePermission(requestId, granted === true);
    res.json({ ok: true });
  });

  // Resolve a pending cost approval request
  router.post('/api/cost-approval', (req, res) => {
    const { requestId, approved } = req.body as { requestId?: string; approved?: boolean };
    if (!requestId) {
      res.status(400).json({ error: 'requestId is required' });
      return;
    }
    orchestrator.resolveCostApproval(requestId, approved === true);
    res.json({ ok: true });
  });

  // Update skip-cost-confirmation setting at runtime
  router.post('/api/set-cost-confirmation', (req, res) => {
    const { skip } = req.body as { skip?: boolean };
    orchestrator.setSkipMediaCostConfirmation(skip === true);
    res.json({ ok: true });
  });

  return router;
}
