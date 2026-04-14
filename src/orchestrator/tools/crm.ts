/**
 * CRM Orchestrator Tools
 * Tools for managing contacts and logging events locally.
 *
 * Tool schemas at the top, runtime handlers below.
 *
 * Every create/update/delete path fires a best-effort upstream sync via
 * the shared `syncResource` dispatcher so cloud dashboards see the same
 * contact state. Sync failures are never propagated back to the caller —
 * the local write is the source of truth and the cloud is a mirror.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { syncResource } from '../../control-plane/sync-resources.js';

export const CRM_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'list_contacts',
    description:
      'List contacts in the local CRM. Returns { total, returned, limit, contacts }. `total` is the unfiltered-by-limit count matching the filter stack — use it to tell whether `contacts` is the complete set or only the first page. Default limit 50, max 500.',
    input_schema: {
      type: 'object' as const,
      properties: {
        contact_type: { type: 'string', enum: ['lead', 'customer', 'partner', 'other'] },
        status: { type: 'string', enum: ['active', 'inactive'] },
        limit: { type: 'number', description: 'Max contacts to return (default 50, max 500)' },
      },
      required: [],
    },
  },
  {
    name: 'create_contact',
    description:
      'Create a new contact in the local CRM. Confirm details before creating.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Contact name' },
        email: { type: 'string', description: 'Email address' },
        phone: { type: 'string', description: 'Phone number' },
        company: { type: 'string', description: 'Company name' },
        contact_type: { type: 'string', enum: ['lead', 'customer', 'partner', 'other'] },
        notes: { type: 'string', description: 'Additional notes' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_contact',
    description:
      'Update an existing contact in the local CRM.',
    input_schema: {
      type: 'object' as const,
      properties: {
        contact_id: { type: 'string', description: 'The contact ID' },
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        company: { type: 'string' },
        contact_type: { type: 'string', enum: ['lead', 'customer', 'partner', 'other'] },
        status: { type: 'string', enum: ['active', 'inactive'] },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'log_contact_event',
    description:
      'Log an event for a contact (call, email, meeting, note).',
    input_schema: {
      type: 'object' as const,
      properties: {
        contact_id: { type: 'string', description: 'The contact ID' },
        event_type: { type: 'string', description: 'Type of event (e.g., call, email, meeting, note)' },
        title: { type: 'string', description: 'Event title' },
        description: { type: 'string', description: 'Event details' },
      },
      required: ['contact_id', 'event_type', 'title'],
    },
  },
  {
    name: 'search_contacts',
    description:
      'Search contacts by name, email, or company.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
];

// ============================================================================
// list_contacts
// ============================================================================

export async function listContacts(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const rawLimit = typeof input.limit === 'number' ? (input.limit as number) : 50;
  const limit = Math.max(1, Math.min(500, Math.floor(rawLimit)));

  let query = ctx.db
    .from('agent_workforce_contacts')
    .select('id, name, email, phone, company, contact_type, status, tags, created_at')
    .eq('workspace_id', ctx.workspaceId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (input.contact_type) query = query.eq('contact_type', input.contact_type as string);
  if (input.status) query = query.eq('status', input.status as string);

  const { data, error } = await query;
  if (error) return { success: false, error: error.message };

  // Total-count companion query so the caller can tell whether the
  // returned page is the full set. Mirrors the filter stack above so
  // total and contacts count the same population. E4 fuzz finding.
  let totalCountQuery = ctx.db
    .from('agent_workforce_contacts')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', ctx.workspaceId);
  if (input.contact_type) totalCountQuery = totalCountQuery.eq('contact_type', input.contact_type as string);
  if (input.status) totalCountQuery = totalCountQuery.eq('status', input.status as string);
  const { count: totalCount } = await totalCountQuery;

  const contacts = (data || []) as Array<Record<string, unknown>>;
  const rows = contacts.map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email || undefined,
    phone: c.phone || undefined,
    company: c.company || undefined,
    type: c.contact_type,
    status: c.status,
    tags: typeof c.tags === 'string' ? JSON.parse(c.tags as string) : c.tags,
    createdAt: c.created_at,
  }));

  return {
    success: true,
    data: {
      total: totalCount ?? rows.length,
      returned: rows.length,
      limit,
      contacts: rows,
    },
  };
}

// ============================================================================
// create_contact
// ============================================================================

export async function createContact(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const name = input.name as string;
  if (!name) return { success: false, error: 'name is required' };

  const insertPayload: Record<string, unknown> = {
    workspace_id: ctx.workspaceId,
    name,
    contact_type: (input.contact_type as string) || 'lead',
    status: 'active',
  };

  if (input.email) insertPayload.email = input.email;
  if (input.phone) insertPayload.phone = input.phone;
  if (input.company) insertPayload.company = input.company;
  if (input.notes) insertPayload.notes = input.notes;
  if (input.tags) insertPayload.tags = JSON.stringify(input.tags);

  const { data, error } = await ctx.db
    .from('agent_workforce_contacts')
    .insert(insertPayload)
    .select('id')
    .single();

  if (error) return { success: false, error: error.message };
  if (!data) return { success: false, error: 'Could not create contact' };

  const contactId = (data as { id: string }).id;

  // Fire-and-forget cloud sync so the new contact shows up in the cloud
  // dashboard and cloud-side agents. Never blocks the local response.
  void syncResource(ctx, 'contact', 'upsert', {
    id: contactId,
    name,
    email: insertPayload.email as string | undefined,
    phone: insertPayload.phone as string | undefined,
    company: insertPayload.company as string | undefined,
    contact_type: insertPayload.contact_type as string,
    notes: insertPayload.notes as string | undefined,
    tags: input.tags,
    status: 'active',
  });

  return {
    success: true,
    data: { message: `Contact "${name}" created.`, contactId },
  };
}

// ============================================================================
// update_contact
// ============================================================================

export async function updateContact(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const contactId = input.contact_id as string;
  if (!contactId) return { success: false, error: 'contact_id is required' };

  // Verify ownership
  const { data: existing } = await ctx.db
    .from('agent_workforce_contacts')
    .select('id, workspace_id, name')
    .eq('id', contactId)
    .single();

  if (!existing) return { success: false, error: 'Contact not found' };
  if ((existing as { workspace_id: string }).workspace_id !== ctx.workspaceId) {
    return { success: false, error: 'Contact not in your workspace' };
  }

  const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) updatePayload.name = input.name;
  if (input.email !== undefined) updatePayload.email = input.email;
  if (input.phone !== undefined) updatePayload.phone = input.phone;
  if (input.company !== undefined) updatePayload.company = input.company;
  if (input.contact_type !== undefined) updatePayload.contact_type = input.contact_type;
  if (input.status !== undefined) updatePayload.status = input.status;
  if (input.notes !== undefined) updatePayload.notes = input.notes;
  if (input.tags !== undefined) updatePayload.tags = JSON.stringify(input.tags);

  await ctx.db.from('agent_workforce_contacts').update(updatePayload).eq('id', contactId);

  // Reload and sync upstream. We re-read the full row so the cloud sees the
  // complete shape instead of a diff that might be merged with stale state.
  const { data: refreshed } = await ctx.db
    .from('agent_workforce_contacts')
    .select('id, name, email, phone, company, contact_type, status, notes, tags')
    .eq('id', contactId)
    .maybeSingle();
  if (refreshed) {
    void syncResource(ctx, 'contact', 'upsert', {
      ...(refreshed as Record<string, unknown>),
      id: contactId,
    });
  }

  return {
    success: true,
    data: { message: `Contact "${(existing as { name: string }).name}" updated.` },
  };
}

// ============================================================================
// log_contact_event
// ============================================================================

export async function logContactEvent(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const contactId = input.contact_id as string;
  const eventType = input.event_type as string;
  const title = input.title as string;

  if (!contactId || !eventType || !title) {
    return { success: false, error: 'contact_id, event_type, and title are required' };
  }

  // Verify contact exists and belongs to workspace
  const { data: contact } = await ctx.db
    .from('agent_workforce_contacts')
    .select('id, workspace_id')
    .eq('id', contactId)
    .single();

  if (!contact) return { success: false, error: 'Contact not found' };
  if ((contact as { workspace_id: string }).workspace_id !== ctx.workspaceId) {
    return { success: false, error: 'Contact not in your workspace' };
  }

  await ctx.db.from('agent_workforce_contact_events').insert({
    workspace_id: ctx.workspaceId,
    contact_id: contactId,
    event_type: eventType,
    title,
    description: (input.description as string) || null,
    agent_id: (input.agent_id as string) || null,
    metadata: JSON.stringify(input.metadata || {}),
  });

  return {
    success: true,
    data: { message: `Event "${title}" logged for contact.` },
  };
}

// ============================================================================
// search_contacts
// ============================================================================

export async function searchContacts(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const query = input.query as string;
  if (!query) return { success: false, error: 'query is required' };

  // SQLite LIKE search across name, email, company
  const { data } = await ctx.db
    .from('agent_workforce_contacts')
    .select('id, name, email, phone, company, contact_type, status')
    .eq('workspace_id', ctx.workspaceId)
    .or(`name.ilike.%${query}%,email.ilike.%${query}%,company.ilike.%${query}%`)
    .limit(10);

  const contacts = (data || []) as Array<Record<string, unknown>>;
  return {
    success: true,
    data: contacts.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email || undefined,
      company: c.company || undefined,
      type: c.contact_type,
      status: c.status,
    })),
  };
}
