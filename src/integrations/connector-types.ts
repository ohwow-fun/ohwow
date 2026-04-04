/**
 * Data Source Connector Types
 * Core interfaces for external data source connectors (GitHub, Google Drive, etc.)
 * that feed documents into the knowledge base.
 *
 * Pattern mirrors MessagingChannel / ChannelRegistry from channel-types.ts.
 */

export type ConnectorType = 'github' | 'local-files' | 'google-drive' | 'notion' | 'slack' | 'confluence' | 'imap';

/** A single document yielded by a connector */
export interface ConnectorDocument {
  /** Stable ID unique within this connector (e.g. GitHub file SHA, Drive file ID) */
  id: string;
  title: string;
  content: string;
  /** Original URL/path for linking back */
  sourceUrl?: string;
  /** Arbitrary connector-specific metadata */
  metadata?: Record<string, unknown>;
  /** When this document was last modified at the source */
  updatedAt?: Date;
  /** MIME type hint (e.g. 'text/markdown', 'application/pdf') */
  mimeType?: string;
}

/** Connector configuration stored in DB */
export interface ConnectorConfig {
  id: string;
  type: ConnectorType;
  name: string;
  /** Connector-specific settings (e.g. repo URL, folder path, API key) */
  settings: Record<string, unknown>;
  /** Sync interval in minutes (default 30) */
  syncIntervalMinutes: number;
  /** Prune interval in days (default 30) */
  pruneIntervalDays: number;
  enabled: boolean;
  lastSyncAt?: string;
  lastSyncStatus?: 'success' | 'failed' | 'running';
  lastSyncError?: string;
}

/** Interface that all data source connectors implement */
export interface DataSourceConnector {
  readonly type: ConnectorType;
  readonly name: string;

  /** Bulk load all documents from the source */
  load(): AsyncGenerator<ConnectorDocument>;

  /** Incremental update since a given timestamp (optional) */
  poll?(since: Date): AsyncGenerator<ConnectorDocument>;

  /** Validate that the connector can reach the data source */
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}

/** Factory function type — connectors are created from config */
export type ConnectorFactory = (config: ConnectorConfig) => DataSourceConnector;
