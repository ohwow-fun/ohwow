/**
 * Google Drive Data Source Connector
 * Fetches documents from a Google Drive folder via the REST API.
 */

import type { DataSourceConnector, ConnectorDocument, ConnectorConfig } from '../connector-types.js';
import { logger } from '../../lib/logger.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const TIMEOUT_MS = 30_000;

const GOOGLE_DOCS_MIME = 'application/vnd.google-apps.document';
const GOOGLE_SHEETS_MIME = 'application/vnd.google-apps.spreadsheet';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink?: string;
}

export class GoogleDriveConnector implements DataSourceConnector {
  readonly type = 'google-drive' as const;
  readonly name: string;
  private folderId: string;
  private authToken: string;
  private mimeTypes: string[];

  constructor(config: ConnectorConfig) {
    this.name = config.name;
    const s = config.settings as {
      folderId?: string;
      oauthToken?: string;
      serviceAccountKey?: string;
      mimeTypes?: string[];
    };
    this.folderId = s.folderId || 'root';
    this.authToken = s.oauthToken || '';
    this.mimeTypes = s.mimeTypes || [
      GOOGLE_DOCS_MIME,
      'text/plain',
      'text/markdown',
      'text/csv',
    ];
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.authToken}`,
    };
  }

  async *load(): AsyncGenerator<ConnectorDocument> {
    yield* this.fetchFiles();
  }

  async *poll(since: Date): AsyncGenerator<ConnectorDocument> {
    yield* this.fetchFiles(since);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const resp = await fetch(`${DRIVE_API}/about?fields=user`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (resp.ok) return { ok: true };
      return { ok: false, error: `Auth failed: ${resp.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
    }
  }

  private async *fetchFiles(since?: Date): AsyncGenerator<ConnectorDocument> {
    let pageToken: string | undefined;

    do {
      let query = `'${this.folderId}' in parents and trashed=false`;
      if (since) {
        query += ` and modifiedTime > '${since.toISOString()}'`;
      }

      const params = new URLSearchParams({
        q: query,
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)',
        pageSize: '100',
      });
      if (pageToken) {
        params.set('pageToken', pageToken);
      }

      let data: { files?: DriveFile[]; nextPageToken?: string };

      try {
        const resp = await fetch(`${DRIVE_API}/files?${params.toString()}`, {
          headers: this.headers(),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!resp.ok) {
          logger.error({ status: resp.status }, '[google-drive-connector] Failed to list files');
          return;
        }
        data = await resp.json() as typeof data;
      } catch (err) {
        logger.error({ err }, '[google-drive-connector] File list fetch error');
        return;
      }

      const files = (data.files || []).filter(
        (f) => this.mimeTypes.includes(f.mimeType) || f.mimeType === GOOGLE_DOCS_MIME || f.mimeType === GOOGLE_SHEETS_MIME,
      );

      for (const file of files) {
        const doc = await this.fetchFileContent(file);
        if (doc) yield doc;
      }

      pageToken = data.nextPageToken;
    } while (pageToken);
  }

  private async fetchFileContent(file: DriveFile): Promise<ConnectorDocument | null> {
    try {
      let content: string;
      let mimeType = file.mimeType;

      if (file.mimeType === GOOGLE_DOCS_MIME) {
        // Export Google Docs as plain text
        const resp = await fetch(
          `${DRIVE_API}/files/${file.id}/export?mimeType=text/plain`,
          { headers: this.headers(), signal: AbortSignal.timeout(TIMEOUT_MS) },
        );
        if (!resp.ok) return null;
        content = await resp.text();
        mimeType = 'text/plain';
      } else if (file.mimeType === GOOGLE_SHEETS_MIME) {
        // Export Google Sheets as CSV
        const resp = await fetch(
          `${DRIVE_API}/files/${file.id}/export?mimeType=text/csv`,
          { headers: this.headers(), signal: AbortSignal.timeout(TIMEOUT_MS) },
        );
        if (!resp.ok) return null;
        content = await resp.text();
        mimeType = 'text/csv';
      } else {
        // Download regular files directly
        const resp = await fetch(
          `${DRIVE_API}/files/${file.id}?alt=media`,
          { headers: this.headers(), signal: AbortSignal.timeout(TIMEOUT_MS) },
        );
        if (!resp.ok) return null;
        content = await resp.text();
      }

      return {
        id: file.id,
        title: file.name,
        content,
        sourceUrl: file.webViewLink,
        metadata: { folderId: this.folderId, mimeType: file.mimeType },
        updatedAt: new Date(file.modifiedTime),
        mimeType,
      };
    } catch (err) {
      logger.warn({ err, fileId: file.id, fileName: file.name }, '[google-drive-connector] Failed to fetch file content');
      return null;
    }
  }
}
