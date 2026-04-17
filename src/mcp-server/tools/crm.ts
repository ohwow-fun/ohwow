/**
 * CRM MCP Tools
 * Contact management: list, create, and search contacts.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

export function registerCrmTools(server: McpServer, client: DaemonApiClient): void {
  // ohwow_list_contacts — List contacts via direct REST
  server.tool(
    'ohwow_list_contacts',
    '[CRM] List contacts in the workspace. Returns id, name, email, phone, company, contact_type (lead/customer/partner), status, tags, and notes. Use the `search` param for quick filtering by name/email/company. For deeper full-text search across all fields including notes, use ohwow_search_contacts instead.',
    {
      search: z.string().optional().describe('Filter by name, email, or company'),
      limit: z.number().optional().describe('Max results (default: 50)'),
    },
    async ({ search, limit }) => {
      try {
        const params = new URLSearchParams();
        if (search) params.set('search', search);
        if (limit) params.set('limit', String(limit));
        const query = params.toString();
        const data = await client.get(`/api/contacts${query ? `?${query}` : ''}`) as Record<string, unknown>;
        const contacts = data.data || data;
        return { content: [{ type: 'text' as const, text: JSON.stringify(contacts, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // ohwow_create_contact — Create contact via direct REST
  server.tool(
    'ohwow_create_contact',
    '[CRM] Add a new contact to the CRM. Returns the created contact with id, timestamps, and all fields. Contacts default to type "lead" and status "active".',
    {
      name: z.string().describe('Contact full name'),
      email: z.string().optional().describe('Email address'),
      phone: z.string().optional().describe('Phone number'),
      company: z.string().optional().describe('Company or organization'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      notes: z.string().optional().describe('Additional notes about the contact'),
    },
    async ({ name, email, phone, company, tags, notes }) => {
      try {
        const body: Record<string, unknown> = { name };
        if (email) body.email = email;
        if (phone) body.phone = phone;
        if (company) body.company = company;
        if (tags) body.tags = tags;
        if (notes) body.notes = notes;
        const result = await client.post('/api/contacts', body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // ohwow_search_contacts — Semantic search via orchestrator
  server.tool(
    'ohwow_search_contacts',
    '[CRM] Deep full-text search across all contact fields including notes and custom fields. Routes through the orchestrator (slower, ~15s). For simple filtering by name/email/company, use ohwow_list_contacts with the `search` param instead.',
    {
      query: z.string().describe('Search query'),
    },
    async ({ query }) => {
      try {
        const text = await client.postSSE('/api/chat', {
          message: `Use the search_contacts tool with query: "${query}". Return the results as-is.`,
        }, 15_000);
        return { content: [{ type: 'text' as const, text: text || 'No contacts found' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );
}
