import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubConnector } from '../github-connector.js';
import type { ConnectorConfig, ConnectorDocument } from '../../connector-types.js';

function makeConfig(overrides?: Partial<ConnectorConfig['settings']>): ConnectorConfig {
  return {
    id: 'gh-1',
    type: 'github',
    name: 'Test GitHub',
    settings: { repo: 'owner/repo', branch: 'main', ...overrides },
    syncIntervalMinutes: 30,
    pruneIntervalDays: 30,
    enabled: true,
  };
}

// Tree response with a mix of supported and unsupported files
const MOCK_TREE = {
  tree: [
    { path: 'README.md', sha: 'sha1', type: 'blob' },
    { path: 'docs/guide.txt', sha: 'sha2', type: 'blob' },
    { path: 'src/index.ts', sha: 'sha3', type: 'blob' },         // unsupported ext
    { path: 'data.json', sha: 'sha4', type: 'blob' },
    { path: 'docs', sha: 'sha5', type: 'tree' },                  // directory, not blob
  ],
};

function mockFileContent(path: string, sha: string) {
  return {
    sha,
    content: Buffer.from(`Content of ${path}`).toString('base64'),
    encoding: 'base64',
    html_url: `https://github.com/owner/repo/blob/main/${path}`,
  };
}

describe('GitHubConnector', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('load() fetches tree and file contents for supported extensions', async () => {
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/git/trees/')) {
        return Response.json(MOCK_TREE);
      }
      if (url.includes('/contents/README.md')) {
        return Response.json(mockFileContent('README.md', 'sha1'));
      }
      if (url.includes('/contents/docs/guide.txt')) {
        return Response.json(mockFileContent('docs/guide.txt', 'sha2'));
      }
      if (url.includes('/contents/data.json')) {
        return Response.json(mockFileContent('data.json', 'sha4'));
      }
      return new Response('Not found', { status: 404 });
    });

    const connector = new GitHubConnector(makeConfig());
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.load()) {
      docs.push(doc);
    }

    // Should have 3 supported files (README.md, docs/guide.txt, data.json) — not index.ts or tree entry
    expect(docs.length).toBe(3);
    expect(docs.map((d) => d.title)).toEqual(['README.md', 'docs/guide.txt', 'data.json']);
    expect(docs[0].content).toBe('Content of README.md');
    expect(docs[0].id).toBe('sha1');
    expect(docs[0].sourceUrl).toContain('github.com');
  });

  it('load() filters by paths setting', async () => {
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/git/trees/')) {
        return Response.json(MOCK_TREE);
      }
      if (url.includes('/contents/docs/guide.txt')) {
        return Response.json(mockFileContent('docs/guide.txt', 'sha2'));
      }
      return new Response('Not found', { status: 404 });
    });

    const connector = new GitHubConnector(makeConfig({ paths: ['docs/'] }));
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.load()) {
      docs.push(doc);
    }

    expect(docs.length).toBe(1);
    expect(docs[0].title).toBe('docs/guide.txt');
  });

  it('poll() fetches commits and changed files', async () => {
    const since = new Date('2024-01-01T00:00:00Z');

    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('/commits?since=')) {
        return Response.json([{ sha: 'commit-sha-1' }]);
      }
      if (url.includes('/commits/commit-sha-1')) {
        return Response.json({
          files: [
            { filename: 'README.md', sha: 'new-sha', status: 'modified' },
            { filename: 'src/app.ts', sha: 'ts-sha', status: 'modified' },  // unsupported
            { filename: 'deleted.md', sha: 'del-sha', status: 'removed' },  // removed
          ],
        });
      }
      if (url.includes('/contents/README.md')) {
        return Response.json(mockFileContent('README.md', 'new-sha'));
      }
      return new Response('Not found', { status: 404 });
    });

    const connector = new GitHubConnector(makeConfig());
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.poll(since)) {
      docs.push(doc);
    }

    expect(docs.length).toBe(1);
    expect(docs[0].title).toBe('README.md');
  });

  it('testConnection() returns ok on 200', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));

    const connector = new GitHubConnector(makeConfig());
    const result = await connector.testConnection();
    expect(result.ok).toBe(true);
  });

  it('testConnection() returns error on 404', async () => {
    fetchSpy.mockResolvedValue(new Response('Not Found', { status: 404, statusText: 'Not Found' }));

    const connector = new GitHubConnector(makeConfig());
    const result = await connector.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('404');
  });

  it('includes Authorization header when token is set', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));

    const connector = new GitHubConnector(makeConfig({ token: 'ghp_secret123' }));
    await connector.testConnection();

    const call = fetchSpy.mock.calls[0];
    const opts = call[1] as RequestInit;
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer ghp_secret123');
  });

  it('omits Authorization header when no token', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));

    const connector = new GitHubConnector(makeConfig());
    await connector.testConnection();

    const call = fetchSpy.mock.calls[0];
    const opts = call[1] as RequestInit;
    expect((opts.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('load() gracefully handles tree fetch failure', async () => {
    fetchSpy.mockResolvedValue(new Response('Server Error', { status: 500 }));

    const connector = new GitHubConnector(makeConfig());
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.load()) {
      docs.push(doc);
    }

    expect(docs.length).toBe(0);
  });
});
