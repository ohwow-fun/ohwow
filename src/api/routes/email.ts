/**
 * Email Routes
 * CRUD for email accounts, messages, and drafts.
 */

import { Router } from 'express';
import type { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';

export function createEmailRouter(
  db: DatabaseAdapter,
  _eventBus: TypedEventBus<RuntimeEvents>,
): Router {
  const router = Router();

  // ── Accounts ─────────────────────────────────────────────────────

  router.get('/api/email/accounts', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('email_accounts')
        .select('id, workspace_id, provider, email_address, label, enabled, last_synced_at, created_at, updated_at')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false });
      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/email/accounts', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { provider, email_address, label, credentials } = req.body;
      if (!email_address || !label) {
        res.status(400).json({ error: 'email_address and label are required' });
        return;
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const { error } = await db.from('email_accounts').insert({
        id, workspace_id: workspaceId,
        provider: provider || 'local',
        email_address, label,
        credentials: credentials ? JSON.stringify(credentials) : '{}',
        created_at: now, updated_at: now,
      });
      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('email_accounts')
        .select('id, workspace_id, provider, email_address, label, enabled, created_at, updated_at')
        .eq('id', id).single();
      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── Messages ─────────────────────────────────────────────────────

  router.get('/api/email/messages', async (req, res) => {
    try {
      const { workspaceId } = req;
      const limit = parseInt(req.query.limit as string || '50', 10);

      let query = db.from('email_messages').select('*').eq('workspace_id', workspaceId);
      if (req.query.account_id) query = query.eq('account_id', req.query.account_id as string);
      if (req.query.is_read === '0' || req.query.is_read === 'false') query = query.eq('is_read', 0);
      if (req.query.is_read === '1' || req.query.is_read === 'true') query = query.eq('is_read', 1);
      if (req.query.after) query = query.gte('received_at', req.query.after as string);
      if (req.query.before) query = query.lte('received_at', req.query.before as string);
      if (req.query.from) {
        const fromTerm = `%${req.query.from as string}%`;
        query = query.or(`from_address.like.${fromTerm}`);
      }
      if (req.query.subject) {
        const subjectTerm = `%${req.query.subject as string}%`;
        query = query.or(`subject.like.${subjectTerm}`);
      }
      if (req.query.search) {
        const term = `%${req.query.search as string}%`;
        query = query.or(`subject.like.${term},from_address.like.${term},from_name.like.${term},snippet.like.${term}`);
      }

      const { data, error } = await query
        .order('received_at', { ascending: false })
        .limit(limit);

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.get('/api/email/messages/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('email_messages')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      if (error) { res.status(500).json({ error: error.message }); return; }
      if (!data) { res.status(404).json({ error: 'message not found' }); return; }
      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/email/messages/:id/read', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { error } = await db.from('email_messages')
        .update({ is_read: 1, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);
      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: { ok: true } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── Drafts ────────���──────────────────────────────────────────────

  router.get('/api/email/drafts', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('email_drafts')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('status', 'draft')
        .order('updated_at', { ascending: false });
      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/email/drafts', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { account_id, reply_to_id, to_addresses, cc_addresses, subject, body_text, body_html } = req.body;

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const { error } = await db.from('email_drafts').insert({
        id, workspace_id: workspaceId,
        account_id: account_id || null,
        reply_to_id: reply_to_id || null,
        to_addresses: to_addresses ? JSON.stringify(to_addresses) : '[]',
        cc_addresses: cc_addresses ? JSON.stringify(cc_addresses) : '[]',
        subject: subject || null,
        body_text: body_text || null,
        body_html: body_html || null,
        status: 'draft',
        created_at: now, updated_at: now,
      });
      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('email_drafts').select('*').eq('id', id).single();
      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.patch('/api/email/drafts/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const updates = { ...req.body, updated_at: new Date().toISOString() };
      delete updates.id; delete updates.workspace_id;
      if (updates.to_addresses && typeof updates.to_addresses !== 'string') updates.to_addresses = JSON.stringify(updates.to_addresses);
      if (updates.cc_addresses && typeof updates.cc_addresses !== 'string') updates.cc_addresses = JSON.stringify(updates.cc_addresses);

      const { error } = await db.from('email_drafts')
        .update(updates)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);
      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: updated } = await db.from('email_drafts').select('*').eq('id', req.params.id).single();
      res.json({ data: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Send draft (integration point — marks as sent, actual send depends on provider)
  router.post('/api/email/drafts/:id/send', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data: draft } = await db.from('email_drafts')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      if (!draft) { res.status(404).json({ error: 'draft not found' }); return; }

      const now = new Date().toISOString();
      const { error } = await db.from('email_drafts')
        .update({ status: 'sent', updated_at: now })
        .eq('id', req.params.id);
      if (error) { res.status(500).json({ error: error.message }); return; }

      // TODO: integrate with actual email provider (Resend, SMTP, Gmail API)
      logger.info({ draftId: req.params.id }, '[email] draft marked as sent');

      res.json({ data: { ok: true, draft_id: req.params.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
