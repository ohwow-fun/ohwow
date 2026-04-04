import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleDriveConnector } from '../google-drive-connector.js';
import type { ConnectorConfig, ConnectorDocument } from '../../connector-types.js';

function makeConfig(overrides?: Record<string, unknown>): ConnectorConfig {
  return {
    id: 'gd-1',
    type: 'google-drive',
    name: 'Test Google Drive',
    settings: { oauthToken: 'test-token', folderId: 'folder-123', ...overrides },
    syncIntervalMinutes: 30,
    pruneIntervalDays: 30,
    enabled: true,
  };
}

const MOCK_FILES = {
  files: [
    { id: 'doc-1', name: 'Meeting Notes', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2024-06-01T00:00:00Z', webViewLink: 'https://docs.google.com/doc-1' },
    { id: 'file-2', name: 'readme.md', mimeType: 'text/markdown', modifiedTime: '2024-06-02T00:00:00Z', webViewLink: 'https://drive.google.com/file-2' },
    { id: 'sheet-3', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2024-06-03T00:00:00Z', webViewLink: 'https://docs.google.com/sheet-3' },
  ],
};

describe('GoogleDriveConnector', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('load() lists files and fetches content', async () => {
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('/files?')) {
        return Response.json(MOCK_FILES);
      }
      if (url.includes('/files/doc-1/export') && url.includes('text/plain')) {
        return new Response('Meeting notes content');
      }
      if (url.includes('/files/file-2?alt=media')) {
        return new Response('# Readme content');
      }
      if (url.includes('/files/sheet-3/export') && url.includes('text/csv')) {
        return new Response('col1,col2\nval1,val2');
      }
      return new Response('Not found', { status: 404 });
    });

    const connector = new GoogleDriveConnector(makeConfig());
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.load()) {
      docs.push(doc);
    }

    expect(docs.length).toBe(3);
    expect(docs[0].title).toBe('Meeting Notes');
    expect(docs[0].content).toBe('Meeting notes content');
    expect(docs[0].id).toBe('doc-1');
    expect(docs[0].sourceUrl).toBe('https://docs.google.com/doc-1');
    expect(docs[1].title).toBe('readme.md');
    expect(docs[1].content).toBe('# Readme content');
    expect(docs[2].title).toBe('Budget');
    expect(docs[2].content).toBe('col1,col2\nval1,val2');
  });

  it('load() exports Google Docs as plain text', async () => {
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('/files?')) {
        return Response.json({
          files: [{ id: 'doc-1', name: 'Doc', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2024-01-01T00:00:00Z' }],
        });
      }
      if (url.includes('/files/doc-1/export')) {
        expect(url).toContain('mimeType=text/plain');
        return new Response('Exported text');
      }
      return new Response('Not found', { status: 404 });
    });

    const connector = new GoogleDriveConnector(makeConfig());
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.load()) {
      docs.push(doc);
    }

    expect(docs.length).toBe(1);
    expect(docs[0].content).toBe('Exported text');
    expect(docs[0].mimeType).toBe('text/plain');
  });

  it('load() downloads regular files via alt=media', async () => {
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('/files?')) {
        return Response.json({
          files: [{ id: 'f-1', name: 'notes.txt', mimeType: 'text/plain', modifiedTime: '2024-01-01T00:00:00Z' }],
        });
      }
      if (url.includes('/files/f-1?alt=media')) {
        return new Response('Plain text content');
      }
      return new Response('Not found', { status: 404 });
    });

    const connector = new GoogleDriveConnector(makeConfig());
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.load()) {
      docs.push(doc);
    }

    expect(docs.length).toBe(1);
    expect(docs[0].content).toBe('Plain text content');
  });

  it('load() handles pagination via nextPageToken', async () => {
    let callCount = 0;
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('/files?')) {
        callCount++;
        if (!url.includes('pageToken=token2')) {
          return Response.json({
            files: [{ id: 'f-1', name: 'page1.txt', mimeType: 'text/plain', modifiedTime: '2024-01-01T00:00:00Z' }],
            nextPageToken: 'token2',
          });
        }
        return Response.json({
          files: [{ id: 'f-2', name: 'page2.txt', mimeType: 'text/plain', modifiedTime: '2024-01-01T00:00:00Z' }],
        });
      }
      if (url.includes('alt=media')) {
        return new Response('content');
      }
      return new Response('Not found', { status: 404 });
    });

    const connector = new GoogleDriveConnector(makeConfig());
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.load()) {
      docs.push(doc);
    }

    expect(callCount).toBe(2);
    expect(docs.length).toBe(2);
    expect(docs[0].title).toBe('page1.txt');
    expect(docs[1].title).toBe('page2.txt');
  });

  it('poll(since) adds modifiedTime filter to query', async () => {
    let capturedUrl = '';
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('/files?')) {
        capturedUrl = url;
        return Response.json({ files: [] });
      }
      return new Response('Not found', { status: 404 });
    });

    const since = new Date('2024-06-01T00:00:00Z');
    const connector = new GoogleDriveConnector(makeConfig());
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.poll(since)) {
      docs.push(doc);
    }

    expect(capturedUrl).toContain('modifiedTime');
    expect(capturedUrl).toContain('2024-06-01');
  });

  it('testConnection() returns ok on 200', async () => {
    fetchSpy.mockResolvedValue(Response.json({ user: { displayName: 'Test' } }));

    const connector = new GoogleDriveConnector(makeConfig());
    const result = await connector.testConnection();
    expect(result.ok).toBe(true);
  });

  it('testConnection() returns error on failure', async () => {
    fetchSpy.mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    const connector = new GoogleDriveConnector(makeConfig());
    const result = await connector.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
  });

  it('includes Authorization header in all requests', async () => {
    fetchSpy.mockResolvedValue(Response.json({ user: {} }));

    const connector = new GoogleDriveConnector(makeConfig({ oauthToken: 'my-secret-token' }));
    await connector.testConnection();

    const call = fetchSpy.mock.calls[0];
    const opts = call[1] as RequestInit;
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer my-secret-token');
  });

  it('load() gracefully handles list failure', async () => {
    fetchSpy.mockResolvedValue(new Response('Server Error', { status: 500 }));

    const connector = new GoogleDriveConnector(makeConfig());
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.load()) {
      docs.push(doc);
    }

    expect(docs.length).toBe(0);
  });
});
