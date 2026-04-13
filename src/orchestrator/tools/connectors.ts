/**
 * Orchestrator Tools — Data Source Connectors
 * Manage external data source connectors that feed documents into the knowledge base.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext } from '../local-tool-types.js';
import type { ToolResult } from '../local-tool-types.js';
import { randomUUID, createHash } from 'node:crypto';
import type { ConnectorType, ConnectorConfig } from '../../integrations/connector-types.js';
import { logger } from '../../lib/logger.js';

export const CONNECTORS_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'list_connectors',
    description: 'List all configured data source connectors and their sync status. Data source connectors automatically import documents from external systems (GitHub, Google Drive, etc.) into the knowledge base.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'add_connector',
    description: 'Add a new data source connector to import documents into the knowledge base. Supported types: github, local-files, google-drive, notion, slack, confluence, imap.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Connector type (e.g. "github", "local-files")' },
        name: { type: 'string', description: 'Human-readable name for this connector' },
        settings: { type: 'object', description: 'Connector-specific settings (e.g. { "repo": "owner/repo", "token": "..." })' },
        sync_interval_minutes: { type: 'number', description: 'How often to sync (default: 30 minutes)' },
      },
      required: ['type', 'name'],
    },
  },
  {
    name: 'remove_connector',
    description: 'Remove a data source connector by ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        connector_id: { type: 'string', description: 'ID of the connector to remove' },
      },
      required: ['connector_id'],
    },
  },
  {
    name: 'sync_connector',
    description: 'Trigger an immediate sync for a data source connector, importing new or updated documents into the knowledge base.',
    input_schema: {
      type: 'object' as const,
      properties: {
        connector_id: { type: 'string', description: 'ID of the connector to sync' },
      },
      required: ['connector_id'],
    },
  },
  {
    name: 'test_connector',
    description: 'Test connectivity for a data source connector to verify it can reach the external system.',
    input_schema: {
      type: 'object' as const,
      properties: {
        connector_id: { type: 'string', description: 'ID of the connector to test' },
      },
      required: ['connector_id'],
    },
  },
];

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
// SYNC CONNECTOR
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

  const registry = ctx.connectorRegistry;
  if (!registry || !registry.hasFactory(connector.type as ConnectorType)) {
    return {
      success: false,
      error: `No connector implementation registered for type "${connector.type}".`,
    };
  }

  // Mark as running
  await ctx.db
    .from('data_source_connectors')
    .update({ last_sync_status: 'running', updated_at: new Date().toISOString() })
    .eq('id', connectorId);

  try {
    // Build ConnectorConfig from DB row
    const connectorConfig: ConnectorConfig = {
      id: connector.id,
      type: connector.type as ConnectorType,
      name: connector.name,
      settings: typeof connector.settings === 'string' ? JSON.parse(connector.settings) : connector.settings,
      syncIntervalMinutes: 30,
      pruneIntervalDays: 30,
      enabled: !!connector.enabled,
      lastSyncAt: connector.last_sync_at || undefined,
    };

    const instance = registry.create(connectorConfig);
    if (!instance) {
      throw new Error(`Failed to create connector instance for type "${connector.type}"`);
    }

    // Use poll() if we have a previous sync timestamp and the connector supports it, otherwise full load()
    const usePoll = connector.last_sync_at && instance.poll;
    const docs = usePoll
      ? instance.poll!(new Date(connector.last_sync_at!))
      : instance.load();

    let enqueued = 0;
    for await (const doc of docs) {
      // Create document record
      const docId = createHash('sha256').update(`${connectorId}-${doc.id}`).digest('hex').slice(0, 32);

      await ctx.db
        .from('agent_workforce_knowledge_documents')
        .insert({
          id: docId,
          workspace_id: ctx.workspaceId,
          title: doc.title,
          filename: doc.title,
          file_type: doc.mimeType || 'text/plain',
          file_size: Buffer.byteLength(doc.content, 'utf-8'),
          storage_path: doc.sourceUrl || `connector://${connectorId}/${doc.id}`,
          source_type: 'connector',
          source_url: doc.sourceUrl,
          processing_status: 'pending',
          compiled_text: doc.content,
          compiled_token_count: Math.ceil(doc.content.length / 4),
          content_hash: createHash('sha256').update(doc.content).digest('hex'),
        });

      // Enqueue for background processing
      const jobId = createHash('sha256').update(`${Date.now()}-${docId}`).digest('hex').slice(0, 32);
      await ctx.db
        .from('document_processing_queue')
        .insert({
          id: jobId,
          workspace_id: ctx.workspaceId,
          document_id: docId,
          status: 'pending',
          payload: JSON.stringify({
            source_type: 'connector',
            content: doc.content,
            title: doc.title,
          }),
        });

      enqueued++;
    }

    // Update connector sync status
    await ctx.db
      .from('data_source_connectors')
      .update({
        last_sync_at: new Date().toISOString(),
        last_sync_status: 'success',
        last_sync_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', connectorId);

    logger.info({ connectorId, type: connector.type, enqueued }, '[connectors] Sync completed');

    return {
      success: true,
      data: {
        message: `Synced "${connector.name}": ${enqueued} document${enqueued === 1 ? '' : 's'} enqueued for processing.`,
        enqueued,
      },
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Sync failed';
    logger.error({ err, connectorId }, '[connectors] Sync failed');

    await ctx.db
      .from('data_source_connectors')
      .update({
        last_sync_status: 'failed',
        last_sync_error: errorMsg,
        updated_at: new Date().toISOString(),
      })
      .eq('id', connectorId);

    return { success: false, error: errorMsg };
  }
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
    .from<{ id: string; type: string; name: string; settings: string }>('data_source_connectors')
    .select('id, type, name, settings')
    .eq('id', connectorId)
    .eq('workspace_id', ctx.workspaceId)
    .single();

  if (!connector) return { success: false, error: 'Connector not found' };

  const registry = ctx.connectorRegistry;
  if (!registry || !registry.hasFactory(connector.type as ConnectorType)) {
    return {
      success: true,
      data: {
        message: `Connector "${connector.name}" found. No implementation registered for type "${connector.type}" — connection test skipped.`,
      },
    };
  }

  try {
    const connectorConfig: ConnectorConfig = {
      id: connector.id,
      type: connector.type as ConnectorType,
      name: connector.name,
      settings: typeof connector.settings === 'string' ? JSON.parse(connector.settings) : connector.settings,
      syncIntervalMinutes: 30,
      pruneIntervalDays: 30,
      enabled: true,
    };

    const instance = registry.create(connectorConfig);
    if (!instance) {
      return { success: false, error: `Could not create connector instance for type "${connector.type}".` };
    }

    const result = await instance.testConnection();
    if (result.ok) {
      return { success: true, data: { message: `Connection test passed for "${connector.name}".` } };
    }
    return { success: false, error: `Connection test failed: ${result.error}` };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Connection test failed';
    return { success: false, error: errorMsg };
  }
}
