/**
 * Orchestrator Tools — Data Source Connectors
 * Manage external data source connectors that feed documents into the knowledge base.
 */

import type { LocalToolContext } from '../local-tool-types.js';
import type { ToolResult } from '../local-tool-types.js';
import { randomUUID } from 'node:crypto';
import type { ConnectorType } from '../../integrations/connector-types.js';

// ============================================================================
// LIST CONNECTORS
// ============================================================================

export async function listConnectors(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  const { data, error } = await ctx.db
    .from('data_source_connectors')
    .select('id, type, name, enabled, sync_interval_minutes, last_sync_at, last_sync_status, last_sync_error, created_at')
    .eq('workspace_id', ctx.workspaceId)
    .order('created_at', { ascending: false });

  if (error) return { success: false, error: error.message };

  const connectors = (data || []).map((c: Record<string, unknown>) => ({
    id: c.id,
    type: c.type,
    name: c.name,
    enabled: !!c.enabled,
    syncIntervalMinutes: c.sync_interval_minutes,
    lastSyncAt: c.last_sync_at,
    lastSyncStatus: c.last_sync_status,
    lastSyncError: c.last_sync_error,
    createdAt: c.created_at,
  }));

  if (connectors.length === 0) {
    return { success: true, data: { message: 'No data source connectors configured.', connectors: [] } };
  }

  return { success: true, data: { connectors } };
}

// ============================================================================
// ADD CONNECTOR
// ============================================================================

export async function addConnector(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const type = input.type as ConnectorType | undefined;
  const name = input.name as string | undefined;

  if (!type) return { success: false, error: 'type is required (e.g. "github", "local-files")' };
  if (!name) return { success: false, error: 'name is required' };

  const validTypes: ConnectorType[] = ['github', 'local-files', 'google-drive', 'notion', 'slack', 'confluence', 'imap'];
  if (!validTypes.includes(type)) {
    return { success: false, error: `Invalid type "${type}". Valid: ${validTypes.join(', ')}` };
  }

  const id = randomUUID().replace(/-/g, '');
  const settings = (input.settings as Record<string, unknown>) || {};
  const syncInterval = Number(input.sync_interval_minutes) || 30;

  const { error } = await ctx.db
    .from('data_source_connectors')
    .insert({
      id,
      workspace_id: ctx.workspaceId,
      type,
      name,
      settings: JSON.stringify(settings),
      sync_interval_minutes: syncInterval,
      enabled: 1,
    });

  if (error) return { success: false, error: error.message };

  return {
    success: true,
    data: {
      message: `Created "${name}" connector (type: ${type}, sync every ${syncInterval}min).`,
      connectorId: id,
    },
  };
}

// ============================================================================
// REMOVE CONNECTOR
// ============================================================================

export async function removeConnector(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const connectorId = input.connector_id as string;
  if (!connectorId) return { success: false, error: 'connector_id is required' };

  const { data: connector } = await ctx.db
    .from('data_source_connectors')
    .select('id, name')
    .eq('id', connectorId)
    .eq('workspace_id', ctx.workspaceId)
    .single();

  if (!connector) return { success: false, error: 'Connector not found' };

  await ctx.db
    .from('data_source_connectors')
    .delete()
    .eq('id', connectorId);

  return {
    success: true,
    data: { message: `Removed connector "${(connector as Record<string, unknown>).name}".` },
  };
}

// ============================================================================
// SYNC CONNECTOR (placeholder — actual sync requires connector implementation)
// ============================================================================

export async function syncConnector(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const connectorId = input.connector_id as string;
  if (!connectorId) return { success: false, error: 'connector_id is required' };

  const { data: connector } = await ctx.db
    .from<{ id: string; type: string; name: string; settings: string; last_sync_at: string | null; enabled: number }>('data_source_connectors')
    .select('id, type, name, settings, last_sync_at, enabled')
    .eq('id', connectorId)
    .eq('workspace_id', ctx.workspaceId)
    .single();

  if (!connector) return { success: false, error: 'Connector not found' };
  if (!connector.enabled) {
    return { success: false, error: 'Connector is disabled' };
  }

  // Mark as running
  await ctx.db
    .from('data_source_connectors')
    .update({ last_sync_status: 'running', updated_at: new Date().toISOString() })
    .eq('id', connectorId);

  // NOTE: Actual connector sync requires a registered connector implementation.
  // For now, mark as failed with a helpful message. Phase 2 will add real connectors.
  await ctx.db
    .from('data_source_connectors')
    .update({
      last_sync_status: 'failed',
      last_sync_error: `No connector implementation registered for type "${connector.type}". Connector implementations coming in Phase 2.`,
      updated_at: new Date().toISOString(),
    })
    .eq('id', connectorId);

  return {
    success: false,
    error: `No connector implementation for type "${connector.type}" yet. Configure a GitHub or local-files connector once implementations are available.`,
  };
}

// ============================================================================
// TEST CONNECTOR
// ============================================================================

export async function testConnector(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const connectorId = input.connector_id as string;
  if (!connectorId) return { success: false, error: 'connector_id is required' };

  const { data: connector } = await ctx.db
    .from('data_source_connectors')
    .select('id, type, name')
    .eq('id', connectorId)
    .eq('workspace_id', ctx.workspaceId)
    .single();

  if (!connector) return { success: false, error: 'Connector not found' };

  // NOTE: Actual test requires a registered connector implementation.
  return {
    success: true,
    data: {
      message: `Connector "${(connector as Record<string, unknown>).name}" found. No implementation registered for type "${(connector as Record<string, unknown>).type}" yet — connection test skipped.`,
    },
  };
}
