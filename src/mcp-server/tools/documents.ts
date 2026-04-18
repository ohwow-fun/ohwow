/**
 * Document MCP Tools
 * Template management, document generation, and e-signature.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

export function registerDocumentTools(server: McpServer, client: DaemonApiClient): void {
  server.tool(
    'ohwow_list_templates',
    '[Documents] List available document templates. Filter by type (proposal, quote, contract, invoice).',
    {
      doc_type: z.enum(['proposal', 'quote', 'contract', 'invoice', 'other']).optional().describe('Filter by document type'),
    },
    async ({ doc_type }) => {
      try {
        const params = doc_type ? `?doc_type=${doc_type}` : '';
        const data = await client.get(`/api/documents/templates${params}`) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data.data || data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_create_template',
    '[Documents] Create a reusable document template with {{variable}} placeholders. Variables auto-populate from CRM when generating.',
    {
      name: z.string().describe('Template name'),
      doc_type: z.enum(['proposal', 'quote', 'contract', 'invoice', 'other']).describe('Document type'),
      body_template: z.string().describe('Template body in Markdown. Use {{variable_name}} for placeholders. Built-in: {{contact_name}}, {{contact_email}}, {{contact_company}}, {{deal_title}}, {{deal_value}}, {{today}}, {{date_formatted}}'),
      description: z.string().optional().describe('Template description'),
      variables: z.array(z.object({
        name: z.string(),
        label: z.string(),
        type: z.enum(['text', 'number', 'date', 'currency']).optional(),
        default_value: z.string().optional(),
      })).optional().describe('Custom variable definitions'),
    },
    async ({ name, doc_type, body_template, description, variables }) => {
      try {
        const body: Record<string, unknown> = { name, doc_type, body_template };
        if (description) body.description = description;
        if (variables) body.variables = variables;
        const result = await client.post('/api/documents/templates', body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_generate_document',
    '[Documents] Generate a document from a template. Auto-populates contact and deal data. Set format=pptx with pptx_spec for a PowerPoint deck, format=xlsx with xlsx_spec for an Excel workbook, or format=docx with docx_spec for a Word document.',
    {
      template_id: z.string().optional().describe('Template ID to generate from (markdown format only)'),
      variables: z.record(z.string(), z.string()).optional().describe('Variable values to fill in (overrides auto-populated values)'),
      contact_id: z.string().optional().describe('Contact ID to auto-populate {{contact_*}} variables'),
      deal_id: z.string().optional().describe('Deal ID to auto-populate {{deal_*}} variables'),
      title: z.string().optional().describe('Custom document title'),
      format: z.enum(['markdown', 'pptx', 'xlsx', 'docx']).optional().describe("Output format. 'markdown' (default) renders a template. 'pptx' builds a PowerPoint deck from pptx_spec. 'xlsx' builds an Excel workbook from xlsx_spec. 'docx' builds a Word document from docx_spec."),
      pptx_spec: z.object({
        title: z.string().optional(),
        author: z.string().optional(),
        filename: z.string().optional(),
        slides: z.array(z.object({
          title: z.string().optional(),
          bullets: z.array(z.string()).optional(),
          notes: z.string().optional(),
          layout: z.enum(['TITLE', 'TITLE_AND_CONTENT', 'BLANK']).optional(),
        })).min(1),
      }).optional().describe('Required when format=pptx. Slide-by-slide deck spec.'),
      xlsx_spec: z.object({
        title: z.string().optional(),
        author: z.string().optional(),
        filename: z.string().optional(),
        sheets: z.array(z.object({
          name: z.string(),
          headers: z.array(z.string()).optional(),
          rows: z.array(z.array(z.union([
            z.string(),
            z.number(),
            z.boolean(),
            z.null(),
          ]))),
          column_widths: z.array(z.number()).optional(),
        })).min(1),
      }).optional().describe('Required when format=xlsx. Sheet-by-sheet workbook spec.'),
      docx_spec: z.object({
        title: z.string().optional(),
        author: z.string().optional(),
        filename: z.string().optional(),
        blocks: z.array(z.union([
          z.object({
            type: z.literal('heading'),
            level: z.union([
              z.literal(1),
              z.literal(2),
              z.literal(3),
              z.literal(4),
              z.literal(5),
              z.literal(6),
            ]),
            text: z.string(),
          }),
          z.object({
            type: z.literal('paragraph'),
            runs: z.array(z.object({
              text: z.string(),
              bold: z.boolean().optional(),
              italic: z.boolean().optional(),
              underline: z.boolean().optional(),
            })),
          }),
          z.object({
            type: z.literal('bullets'),
            items: z.array(z.string()),
          }),
        ])).min(1),
      }).optional().describe('Required when format=docx. Block-by-block Word document spec.'),
    },
    async ({ template_id, variables, contact_id, deal_id, title, format, pptx_spec, xlsx_spec, docx_spec }) => {
      try {
        const outputFormat = format || 'markdown';
        if (outputFormat === 'pptx') {
          if (!pptx_spec) {
            return { content: [{ type: 'text' as const, text: 'Error: pptx_spec is required when format=pptx' }], isError: true };
          }
          const body: Record<string, unknown> = { ...pptx_spec };
          if (title && !pptx_spec.title) body.title = title;
          const result = await client.post('/api/documents/generate-pptx', body);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        if (outputFormat === 'xlsx') {
          if (!xlsx_spec) {
            return { content: [{ type: 'text' as const, text: 'Error: xlsx_spec is required when format=xlsx' }], isError: true };
          }
          const body: Record<string, unknown> = { ...xlsx_spec };
          if (title && !xlsx_spec.title) body.title = title;
          const result = await client.post('/api/documents/generate-xlsx', body);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        if (outputFormat === 'docx') {
          if (!docx_spec) {
            return { content: [{ type: 'text' as const, text: 'Error: docx_spec is required when format=docx' }], isError: true };
          }
          const body: Record<string, unknown> = { ...docx_spec };
          if (title && !docx_spec.title) body.title = title;
          const result = await client.post('/api/documents/generate-docx', body);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        if (!template_id) {
          return { content: [{ type: 'text' as const, text: 'Error: template_id is required when format=markdown' }], isError: true };
        }
        const body: Record<string, unknown> = { template_id };
        if (variables) body.variables = variables;
        if (contact_id) body.contact_id = contact_id;
        if (deal_id) body.deal_id = deal_id;
        if (title) body.title = title;
        const result = await client.post('/api/documents/generate', body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_send_for_signature',
    '[Documents] Send a generated document for e-signature. Currently supports manual tracking; DocuSign/HelloSign integration coming soon.',
    {
      document_id: z.string().describe('Document ID to send'),
      signer_email: z.string().describe('Email of the person who needs to sign'),
      signer_name: z.string().optional().describe('Name of the signer'),
      provider: z.enum(['docusign', 'hellosign', 'manual']).optional().describe('Signature provider (default: manual)'),
    },
    async ({ document_id, signer_email, signer_name, provider }) => {
      try {
        const body: Record<string, unknown> = { signer_email };
        if (signer_name) body.signer_name = signer_name;
        if (provider) body.provider = provider;
        const result = await client.post(`/api/documents/${document_id}/send-for-signature`, body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );
}
