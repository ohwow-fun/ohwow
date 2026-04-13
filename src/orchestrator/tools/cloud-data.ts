/**
 * Cloud Data Tools — query cloud workspace data via the control plane proxy.
 * These tools hit the ohwow.fun /api/local-runtime/cloud-data endpoint
 * which returns data from the cloud Supabase database.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext } from '../local-tool-types.js';

interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export const CLOUD_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'cloud_list_contacts',
    description: 'List contacts from the CLOUD CRM database (not local). Use this when you need the full customer/lead list from the web dashboard.',
    input_schema: { type: 'object' as const, properties: { contact_type: { type: 'string', description: 'Filter: lead, customer, partner' }, search: { type: 'string', description: 'Search by name or email' }, limit: { type: 'number', description: 'Max results (default 50)' } }, required: [] },
  },
  {
    name: 'cloud_list_schedules',
    description: 'List agent schedules from the CLOUD database with cron expressions and last/next run times.',
    input_schema: { type: 'object' as const, properties: { agent_id: { type: 'string', description: 'Filter by agent ID' }, enabled: { type: 'boolean', description: 'Filter by enabled status' } }, required: [] },
  },
  {
    name: 'cloud_list_agents',
    description: 'List all agents from the CLOUD database with full config, stats, and departments.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'cloud_list_tasks',
    description: 'List tasks from the CLOUD database with output, truth scores, and metadata.',
    input_schema: { type: 'object' as const, properties: { agent_id: { type: 'string', description: 'Filter by agent ID' }, status: { type: 'string', description: 'Filter: pending, completed, failed, needs_approval' }, limit: { type: 'number', description: 'Max results (default 50)' } }, required: [] },
  },
  {
    name: 'cloud_get_analytics',
    description: 'Get workspace analytics from the CLOUD: total tasks, agents, contacts, credits, weekly stats.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'cloud_list_members',
    description: 'List workspace members from the CLOUD with roles and profile info.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
];

async function queryCloud(
  ctx: LocalToolContext,
  resource: string,
  filters?: Record<string, unknown>,
  limit?: number,
): Promise<ToolResult> {
  if (!ctx.controlPlane) {
    return { success: false, error: 'Not connected to cloud. Start with a cloud connection first.' };
  }

  const result = await ctx.controlPlane.proxyCloudPost('/api/local-runtime/cloud-data', {
    resource,
    filters: filters || {},
    limit: limit || 50,
  });

  if (!result.ok) {
    return { success: false, error: result.error || 'Cloud query failed' };
  }

  return { success: true, data: result.data };
}

/** List contacts from the cloud CRM */
export async function cloudListContacts(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  return queryCloud(ctx, 'contacts', {
    contact_type: input.contact_type,
    search: input.search,
  }, input.limit as number);
}

/** List schedules from cloud (with agent names) */
export async function cloudListSchedules(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  return queryCloud(ctx, 'schedules', {
    agent_id: input.agent_id,
    enabled: input.enabled,
  });
}

/** List agents from cloud (includes config, stats) */
export async function cloudListAgents(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  return queryCloud(ctx, 'agents');
}

/** List tasks from cloud (includes output, truth scores) */
export async function cloudListTasks(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  return queryCloud(ctx, 'tasks', {
    agent_id: input.agent_id,
    status: input.status,
  }, input.limit as number);
}

/** Get cloud workspace analytics summary */
export async function cloudGetAnalytics(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  return queryCloud(ctx, 'analytics');
}

/** List workspace members from cloud */
export async function cloudListMembers(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  return queryCloud(ctx, 'workspace_members');
}
