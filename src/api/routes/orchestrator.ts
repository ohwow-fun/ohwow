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
      const {
        message,
        sessionId,
        model,
        modelSource,
        messages,
        personaAgentId,
        chatUserEmail,
        chatUserName,
      } = req.body as {
        message?: string;
        sessionId?: string;
        model?: string;
        modelSource?: 'local' | 'cloud';
        messages?: { role: 'user' | 'assistant'; content: string }[];
        personaAgentId?: string | null;
        chatUserEmail?: string | null;
        chatUserName?: string | null;
      };

      if (!message) {
        res.status(400).json({ error: 'Message is required' });
        return;
      }

      const session = sessionId || crypto.randomUUID();

      // Persona hint from the cloud chat proxy. When a team member is the
      // authenticated user on the cloud side, the cloud route resolves
      // their assigned guide agent and forwards the id here. We install
      // the persona on the conversation metadata BEFORE runChat so the
      // Layer B persona loader sees it on the very first turn — no
      // round-trip through tool calls required, no orchestrator drift
      // risk on turn zero.
      if (personaAgentId && typeof personaAgentId === 'string') {
        try {
          const { activateConversationPersona } = await import('../../orchestrator/conversation-persona.js');
          await activateConversationPersona(getDb(), session, personaAgentId);
        } catch (err) {
          // Persona activation failure is non-fatal — the chat still runs
          // under the generic orchestrator if for any reason we can't
          // install the persona (agent deleted, db error, etc.).
          // eslint-disable-next-line no-console
          console.warn('[api/chat] persona pre-activation failed', err);
        }
      }
      // Resolve the chat actor (team_member id + guide agent id) and
      // stash it on the orchestrator for the duration of this turn.
      // The deliverables recorder reads ctx.currentTeamMemberId /
      // currentGuideAgentId to attribute every artifact produced
      // during the turn to "this team member" and "this guide agent",
      // so the dashboard activity timeline can answer "what did the
      // COS produce for Mario?" with a single column query.
      let chatActor: { teamMemberId: string | null; guideAgentId: string | null } | null = null;
      if (chatUserEmail || personaAgentId) {
        try {
          const db = getDb();
          let tmRow: { id: string; assigned_guide_agent_id: string | null } | null = null;
          if (chatUserEmail) {
            const { data } = await db
              .from('agent_workforce_team_members')
              .select('id, assigned_guide_agent_id')
              .eq('email', chatUserEmail)
              .maybeSingle();
            tmRow = (data as { id: string; assigned_guide_agent_id: string | null } | null) ?? null;
          }
          chatActor = {
            teamMemberId: tmRow?.id ?? null,
            guideAgentId: tmRow?.assigned_guide_agent_id ?? (personaAgentId || null),
          };
          orchestrator.setChatActor(chatActor);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[api/chat] chat actor resolution failed', err);
        }
      }
      void chatUserName;

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

      // Compute the base URL callers should use to fetch media files
      // this stream mints. Browsers that hit /api/chat directly at
      // http://localhost:7700 want absolute loopback URLs; cloud proxies
      // that read this stream server-side don't care (they rewrite URLs
      // again on their end). Honor X-Forwarded-Proto/Host when present
      // so a tunnel can project the right external origin.
      const xfProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
      const xfHost = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim();
      const reqProto = xfProto || (req.socket && (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
      const reqHost = xfHost || (req.headers.host as string) || `127.0.0.1:${process.env.OHWOW_PORT || 7700}`;
      const runtimeBase = `${reqProto}://${reqHost}`;
      const toAbsolute = (u: string): string => (u.startsWith('/') ? `${runtimeBase}${u}` : u);

      for await (const event of orchestrator.chat(message, session, seedMessages)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);

        // Synthesize a companion `generated_media` event whenever a
        // successful tool_done carries a media URL in its data payload.
        // Lets the chat UI render an inline <audio>/<video>/<img>
        // player without each tool handler having to emit the event
        // itself.
        if (
          event &&
          typeof event === 'object' &&
          (event as { type?: string }).type === 'tool_done'
        ) {
          const te = event as { result?: { success?: boolean; data?: unknown } };
          if (te.result?.success && te.result.data && typeof te.result.data === 'object') {
            const rd = te.result.data as Record<string, unknown>;
            const mediaMap: Array<{ key: string; mediaType: 'audio' | 'image' | 'video' }> = [
              { key: 'audio_url', mediaType: 'audio' },
              { key: 'image_url', mediaType: 'image' },
              { key: 'video_url', mediaType: 'video' },
            ];
            for (const { key, mediaType } of mediaMap) {
              const raw = rd[key];
              if (typeof raw === 'string' && raw.length > 0) {
                res.write(
                  `data: ${JSON.stringify({ type: 'generated_media', url: toAbsolute(raw), mediaType })}\n\n`
                );
                break;
              }
            }
          }
        }
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
    } finally {
      // Clear the chat actor stash so the next turn (which may be the
      // workspace owner, not a member) doesn't inherit Mario's identity.
      try { orchestrator.setChatActor(null); } catch { /* noop */ }
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
