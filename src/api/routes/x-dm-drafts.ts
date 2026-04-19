/**
 * X DM Drafts Route
 *
 * POST /api/x-dm-drafts — Stage an outbound X DM for founder approval.
 *
 * Unlike x_post_drafts, which has its own table + approve/reject flow for
 * public-facing posts distilled by the market-radar scheduler, DM drafts
 * ride the existing tasks/deliverables pipeline: one row in
 * agent_workforce_tasks (status='needs_approval') and one in
 * agent_workforce_deliverables (status='pending_review') carrying
 * action_spec={type:'send_dm'}. That way the founder's single approval
 * queue (and the ohwow_list_approvals / ohwow_approve_task MCP verbs)
 * handles DMs identically to any other deliverable, and the
 * DeliverableExecutor's 'send_dm' handler fires the real DM via the
 * same Playwright/X path used by the orchestrator's send_dm tool.
 */

import { Router } from 'express';
import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

interface DraftXDmBody {
  contact_id?: unknown;
  body?: unknown;
  agent_id?: unknown;
}

interface ContactRow {
  id: string;
  workspace_id: string;
  name: string | null;
  custom_fields: string | Record<string, unknown> | null;
}

interface AgentRow {
  id: string;
}

/**
 * DM drafts always need SOMEONE in agent_id (tasks.agent_id is NOT NULL).
 * The operator-drafted DM doesn't originate from an agent run, so we
 * default to "The Voice" (Public Communications role), which is the same
 * agent that already owns X nudge tasks. Falls back to any non-archived
 * agent so fresh workspaces without the preset don't 500.
 */
async function resolveDefaultDmAgent(
  db: DatabaseAdapter,
  workspaceId: string,
): Promise<string | null> {
  const { data: voice } = await db.from('agent_workforce_agents')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('role', 'Public Communications')
    .is('archived_at', null)
    .limit(1)
    .maybeSingle();
  const voiceId = (voice as unknown as AgentRow | null)?.id;
  if (typeof voiceId === 'string' && voiceId) return voiceId;

  const { data: fallback } = await db.from('agent_workforce_agents')
    .select('id')
    .eq('workspace_id', workspaceId)
    .is('archived_at', null)
    .limit(1)
    .maybeSingle();
  const fallbackId = (fallback as unknown as AgentRow | null)?.id;
  return typeof fallbackId === 'string' && fallbackId ? fallbackId : null;
}

function parseCustomFields(raw: ContactRow['custom_fields']): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function createXDmDraftsRouter(db: DatabaseAdapter): Router {
  const router = Router();

  router.post('/api/x-dm-drafts', async (req, res) => {
    try {
      const { workspaceId } = req;
      if (!workspaceId) {
        res.status(400).json({ error: 'workspace not resolved' });
        return;
      }

      const { contact_id, body, agent_id } = (req.body ?? {}) as DraftXDmBody;
      if (typeof contact_id !== 'string' || !contact_id) {
        res.status(400).json({ error: 'contact_id required' });
        return;
      }
      if (typeof body !== 'string' || !body.trim()) {
        res.status(400).json({ error: 'body required' });
        return;
      }
      const trimmedBody = body.trim();

      const { data: contactRaw } = await db.from('agent_workforce_contacts')
        .select('id, workspace_id, name, custom_fields')
        .eq('id', contact_id)
        .maybeSingle();
      const contact = contactRaw as ContactRow | null;
      if (!contact || contact.workspace_id !== workspaceId) {
        res.status(404).json({ error: 'contact not found' });
        return;
      }

      const fields = parseCustomFields(contact.custom_fields);
      const handle = typeof fields.x_handle === 'string' ? fields.x_handle.replace(/^@/, '') : '';
      const conversationPair = typeof fields.x_conversation_pair === 'string' ? fields.x_conversation_pair : '';
      if (!handle && !conversationPair) {
        res.status(422).json({ error: 'contact has no x_handle or x_conversation_pair in custom_fields; cannot draft an X DM' });
        return;
      }

      let resolvedAgentId: string | null = typeof agent_id === 'string' && agent_id ? agent_id : null;
      if (!resolvedAgentId) {
        resolvedAgentId = await resolveDefaultDmAgent(db, workspaceId);
      }
      if (!resolvedAgentId) {
        res.status(500).json({ error: 'no agent available to own the draft' });
        return;
      }

      const taskId = crypto.randomUUID();
      const now = new Date().toISOString();
      const displayName = contact.name || (handle ? `@${handle}` : conversationPair);

      // Build action_spec params: prefer handle when available, fall back to conversation_pair
      const dmParams: Record<string, string> = { text: trimmedBody, contact_id };
      if (handle) dmParams.handle = handle;
      if (conversationPair) dmParams.conversation_pair = conversationPair;

      const taskTitle = handle ? `DM draft for @${handle}` : `DM draft for ${displayName}`;
      const delivTitle = handle ? `DM to @${handle}` : `DM to ${displayName}`;

      const { error: taskErr } = await db.from('agent_workforce_tasks').insert({
        id: taskId,
        workspace_id: workspaceId,
        agent_id: resolvedAgentId,
        title: taskTitle,
        description: `Outbound X DM to ${displayName}, staged for founder approval.`,
        input: JSON.stringify({ contact_id, handle: handle || null, conversation_pair: conversationPair || null, body: trimmedBody }),
        output: trimmedBody,
        status: 'needs_approval',
        priority: 'normal',
        contact_ids: JSON.stringify([contact_id]),
        deferred_action: JSON.stringify({
          type: 'send_dm',
          provider: 'x',
          params: dmParams,
        }),
        source_type: 'operator',
        created_at: now,
        updated_at: now,
      });
      if (taskErr) {
        res.status(500).json({ error: taskErr.message });
        return;
      }

      const { error: delivErr } = await db.from('agent_workforce_deliverables').insert({
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        task_id: taskId,
        agent_id: resolvedAgentId,
        deliverable_type: 'dm',
        provider: 'x',
        title: delivTitle,
        content: JSON.stringify({
          text: trimmedBody,
          handle: handle || null,
          conversation_pair: conversationPair || null,
          contact_id,
          action_spec: { type: 'send_dm' },
        }),
        status: 'pending_review',
        auto_created: 0,
        created_at: now,
        updated_at: now,
      });
      if (delivErr) {
        res.status(500).json({ error: delivErr.message });
        return;
      }

      res.status(201).json({
        data: {
          task_id: taskId,
          contact_id,
          handle: handle || null,
          conversation_pair: conversationPair || null,
          status: 'needs_approval',
          note: 'Listed by ohwow_list_approvals. Approve via ohwow_approve_task to send; reject via ohwow_reject_task.',
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
