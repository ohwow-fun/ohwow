/**
 * Documents Routes
 * Templates, document generation with variable interpolation, and e-signature integration.
 */

import { Router } from 'express';
import type { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';

/** Replace {{variable}} placeholders in a template body. */
function interpolate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] !== undefined ? variables[key] : match;
  });
}

/** Format cents to currency string. */
function formatCents(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export function createDocumentsRouter(
  db: DatabaseAdapter,
  _eventBus: TypedEventBus<RuntimeEvents>,
): Router {
  const router = Router();

  // ── Templates ────────────────────────────────────────────────────

  router.get('/api/documents/templates', async (req, res) => {
    try {
      const { workspaceId } = req;
      let query = db.from('document_templates').select('*').eq('workspace_id', workspaceId);
      if (req.query.doc_type) query = query.eq('doc_type', req.query.doc_type as string);
      const { data, error } = await query.order('created_at', { ascending: false });
      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/documents/templates', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { name, doc_type, body_template, description, variables, header_html, footer_html } = req.body;
      if (!name || !body_template) {
        res.status(400).json({ error: 'name and body_template are required' });
        return;
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const { error } = await db.from('document_templates').insert({
        id, workspace_id: workspaceId, name,
        doc_type: doc_type || 'other',
        body_template,
        description: description || null,
        variables: variables ? JSON.stringify(variables) : '[]',
        header_html: header_html || null,
        footer_html: footer_html || null,
        created_at: now, updated_at: now,
      });
      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('document_templates').select('*').eq('id', id).single();
      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.patch('/api/documents/templates/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const updates = { ...req.body, updated_at: new Date().toISOString() };
      delete updates.id; delete updates.workspace_id;
      if (updates.variables && typeof updates.variables !== 'string') updates.variables = JSON.stringify(updates.variables);

      const { error } = await db.from('document_templates')
        .update(updates)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);
      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: updated } = await db.from('document_templates').select('*').eq('id', req.params.id).single();
      res.json({ data: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.delete('/api/documents/templates/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { error } = await db.from('document_templates')
        .delete()
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);
      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: { id: req.params.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── Document Generation ──────────────────────────────────────────

  router.post('/api/documents/generate', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { template_id, variables, contact_id, deal_id, title } = req.body;
      if (!template_id) { res.status(400).json({ error: 'template_id is required' }); return; }

      // Fetch template
      const { data: tmpl } = await db.from('document_templates')
        .select('*')
        .eq('id', template_id)
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      if (!tmpl) { res.status(404).json({ error: 'template not found' }); return; }
      const template = tmpl as Record<string, unknown>;

      // Build variable map
      const vars: Record<string, string> = { ...(variables || {}) };

      // Auto-populate from contact
      if (contact_id) {
        const { data: contact } = await db.from('agent_workforce_contacts')
          .select('*').eq('id', contact_id).maybeSingle();
        if (contact) {
          const c = contact as Record<string, unknown>;
          if (!vars.contact_name && c.name) vars.contact_name = c.name as string;
          if (!vars.contact_email && c.email) vars.contact_email = c.email as string;
          if (!vars.contact_company && c.company) vars.contact_company = c.company as string;
          if (!vars.contact_phone && c.phone) vars.contact_phone = c.phone as string;
        }
      }

      // Auto-populate from deal
      if (deal_id) {
        const { data: deal } = await db.from('deals')
          .select('*').eq('id', deal_id).maybeSingle();
        if (deal) {
          const d = deal as Record<string, unknown>;
          if (!vars.deal_title && d.title) vars.deal_title = d.title as string;
          if (!vars.deal_value && d.value_cents) vars.deal_value = formatCents(d.value_cents as number, d.currency as string);
          if (!vars.deal_value_cents && d.value_cents) vars.deal_value_cents = String(d.value_cents);
        }
      }

      // Add date variables
      const now = new Date();
      vars.today = now.toISOString().split('T')[0];
      vars.date_formatted = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

      const bodyRendered = interpolate(template.body_template as string, vars);
      const docTitle = title || `${template.name} - ${vars.contact_name || vars.today}`;

      const id = crypto.randomUUID();
      const nowIso = now.toISOString();
      const { error } = await db.from('documents').insert({
        id, workspace_id: workspaceId,
        template_id, contact_id: contact_id || null, deal_id: deal_id || null,
        title: docTitle,
        doc_type: template.doc_type as string,
        body_rendered: bodyRendered,
        variables_used: JSON.stringify(vars),
        status: 'draft',
        created_at: nowIso, updated_at: nowIso,
      });
      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('documents').select('*').eq('id', id).single();
      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── Documents CRUD ───────────────────────────────────────────────

  router.get('/api/documents', async (req, res) => {
    try {
      const { workspaceId } = req;
      const limit = parseInt(req.query.limit as string || '50', 10);
      let query = db.from('documents').select('*').eq('workspace_id', workspaceId);
      if (req.query.status) query = query.eq('status', req.query.status as string);
      if (req.query.contact_id) query = query.eq('contact_id', req.query.contact_id as string);
      if (req.query.deal_id) query = query.eq('deal_id', req.query.deal_id as string);

      const { data, error } = await query.order('created_at', { ascending: false }).limit(limit);
      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.get('/api/documents/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('documents')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      if (error) { res.status(500).json({ error: error.message }); return; }
      if (!data) { res.status(404).json({ error: 'document not found' }); return; }
      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.patch('/api/documents/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const updates = { ...req.body, updated_at: new Date().toISOString() };
      delete updates.id; delete updates.workspace_id;
      const { error } = await db.from('documents')
        .update(updates)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);
      if (error) { res.status(500).json({ error: error.message }); return; }
      const { data: updated } = await db.from('documents').select('*').eq('id', req.params.id).single();
      res.json({ data: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── E-Signature Integration Point ────────────────────────────────

  router.post('/api/documents/:id/send-for-signature', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { signer_email, signer_name, provider } = req.body;
      if (!signer_email) { res.status(400).json({ error: 'signer_email is required' }); return; }

      const { data: doc } = await db.from('documents')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      if (!doc) { res.status(404).json({ error: 'document not found' }); return; }

      const now = new Date().toISOString();
      const { error } = await db.from('documents')
        .update({
          status: 'sent',
          sent_at: now,
          signature_provider: provider || 'manual',
          metadata: JSON.stringify({
            signer_email,
            signer_name: signer_name || null,
          }),
          updated_at: now,
        })
        .eq('id', req.params.id);
      if (error) { res.status(500).json({ error: error.message }); return; }

      // TODO: integrate with DocuSign/HelloSign API to create signature request
      logger.info({ documentId: req.params.id, signer_email, provider }, '[documents] sent for signature');

      const { data: updated } = await db.from('documents').select('*').eq('id', req.params.id).single();
      res.json({ data: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
