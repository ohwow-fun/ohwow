/**
 * Connector Sync Scheduler
 * Periodically checks data_source_connectors for connectors that are due for
 * a sync (based on sync_interval_minutes and last_sync_at) and runs the sync.
 *
 * Follows the same setInterval + start/stop pattern as HeartbeatCoordinator.
 */

import { createHash } from 'node:crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { ConnectorRegistry } from '../integrations/connector-registry.js';
import type { ConnectorType, ConnectorConfig } from '../integrations/connector-types.js';
import type { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';
import { logger } from '../lib/logger.js';

const CHECK_INTERVAL_MS = 60_000; // Check every 60 seconds

/** Shape of a connector row from the database */
export interface ConnectorRow {
  id: string;
  type: string;
  name: string;
  settings: string;
  sync_interval_minutes: number;
  last_sync_at: string | null;
  enabled: number;
}

export class ConnectorSyncScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;

  constructor(
    private db: DatabaseAdapter,
    private workspaceId: string,
    private connectorRegistry: ConnectorRegistry,
    private bus: TypedEventBus<RuntimeEvents>,
  ) {}

  start(): void {
    if (this.timer) return;

    logger.info('[ConnectorSyncScheduler] Starting');

    // Initial tick
    this.tick().catch((err) => {
      logger.error({ err }, '[ConnectorSyncScheduler] Initial tick failed');
    });

    // Periodic tick
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logger.error({ err }, '[ConnectorSyncScheduler] Tick error');
      });
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('[ConnectorSyncScheduler] Stopped');
  }

  async tick(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;

    try {
      const { data: connectors } = await this.db
        .from<ConnectorRow>('data_source_connectors')
        .select('id, type, name, settings, sync_interval_minutes, last_sync_at, enabled')
        .eq('workspace_id', this.workspaceId)
        .eq('enabled', 1);

      if (!connectors || connectors.length === 0) return;

      const now = Date.now();

      for (const connector of connectors) {
        const intervalMs = (connector.sync_interval_minutes || 30) * 60_000;
        const lastSync = connector.last_sync_at
          ? new Date(connector.last_sync_at).getTime()
          : 0;

        if (lastSync > 0 && now - lastSync < intervalMs) continue;

        // This connector is due for a sync
        await this.syncOne(connector);
      }
    } catch (err) {
      logger.error({ err }, '[ConnectorSyncScheduler] Tick failed');
    } finally {
      this.syncing = false;
    }
  }

  private async syncOne(connector: ConnectorRow): Promise<void> {
    const connectorId = connector.id;

    if (!this.connectorRegistry.hasFactory(connector.type as ConnectorType)) {
      logger.debug({ connectorId, type: connector.type }, '[ConnectorSyncScheduler] No factory registered, skipping');
      return;
    }

    // Mark as running
    await this.db
      .from('data_source_connectors')
      .update({ last_sync_status: 'running', updated_at: new Date().toISOString() })
      .eq('id', connectorId);

    try {
      const settings = typeof connector.settings === 'string'
        ? JSON.parse(connector.settings)
        : connector.settings;

      const connectorConfig: ConnectorConfig = {
        id: connector.id,
        type: connector.type as ConnectorType,
        name: connector.name,
        settings,
        syncIntervalMinutes: connector.sync_interval_minutes || 30,
        pruneIntervalDays: 30,
        enabled: true,
        lastSyncAt: connector.last_sync_at || undefined,
      };

      const instance = this.connectorRegistry.create(connectorConfig);
      if (!instance) {
        throw new Error(`Could not create connector instance for type "${connector.type}"`);
      }

      // Use poll() if we have a previous sync timestamp and the connector supports it
      const usePoll = connector.last_sync_at && instance.poll;
      const docs = usePoll
        ? instance.poll!(new Date(connector.last_sync_at!))
        : instance.load();

      let enqueued = 0;
      for await (const doc of docs) {
        const docId = createHash('sha256').update(`${connectorId}-${doc.id}`).digest('hex').slice(0, 32);

        await this.db
          .from('agent_workforce_knowledge_documents')
          .insert({
            id: docId,
            workspace_id: this.workspaceId,
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

        const jobId = createHash('sha256').update(`${Date.now()}-${docId}`).digest('hex').slice(0, 32);
        await this.db
          .from('document_processing_queue')
          .insert({
            id: jobId,
            workspace_id: this.workspaceId,
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

      // Mark success
      await this.db
        .from('data_source_connectors')
        .update({
          last_sync_at: new Date().toISOString(),
          last_sync_status: 'success',
          last_sync_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', connectorId);

      logger.info({ connectorId, type: connector.type, enqueued }, '[ConnectorSyncScheduler] Sync completed');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Sync failed';
      logger.error({ err, connectorId }, '[ConnectorSyncScheduler] Sync failed');

      await this.db
        .from('data_source_connectors')
        .update({
          last_sync_status: 'failed',
          last_sync_error: errorMsg,
          updated_at: new Date().toISOString(),
        })
        .eq('id', connectorId);
    }
  }
}
