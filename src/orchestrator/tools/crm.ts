/**
 * CRM Orchestrator Tools
 * Tools for managing contacts and logging events locally.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';

// ============================================================================
// list_contacts
// ============================================================================

export async function listContacts(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  let query = ctx.db
    .from('agent_workforce_contacts')
    .select('id, name, email, phone, company, contact_type, status, tags, created_at')
    .eq('workspace_id', ctx.workspaceId)
    .order('created_at', { ascending: false });

  if (input.contact_type) query = query.eq('contact_type', input.contact_type as string);
  if (input.status) query = query.eq('status', input.status as string);

  const limit = (input.limit as number) || 20;
  query = query.limit(limit);

  const { data, error } = await query;
  if (error) return { success: false, error: error.message };

  const contacts = (data || []) as Array<Record<string, unknown>>;
  const result = contacts.map((c) => ({
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

  return { success: true, data: result };
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
