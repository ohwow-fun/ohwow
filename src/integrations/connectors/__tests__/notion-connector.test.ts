import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotionConnector, blocksToMarkdown } from '../notion-connector.js';
import type { ConnectorConfig, ConnectorDocument } from '../../connector-types.js';

function makeConfig(overrides?: Record<string, unknown>): ConnectorConfig {
  return {
    id: 'notion-1',
    type: 'notion',
    name: 'Test Notion',
    settings: { apiKey: 'ntn_test123', databaseIds: ['db-1'], pageIds: [], ...overrides },
    syncIntervalMinutes: 30,
    pruneIntervalDays: 30,
    enabled: true,
  };
}

function makePage(id: string, title: string, lastEdited = '2024-06-01T00:00:00Z') {
  return {
    id,
    url: `https://notion.so/${id}`,
    properties: {
      Name: { type: 'title', title: [{ plain_text: title }] },
    },
    last_edited_time: lastEdited,
  };
}

const MOCK_BLOCKS = [
  { type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Title' }] } },
  { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Hello world' }] } },
  { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Item one' }] } },
];

describe('NotionConnector', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('load() queries databases and fetches page blocks', async () => {
    fetchSpy.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method || 'GET';

      if (url.includes('/databases/db-1/query') && method === 'POST') {
        return Response.json({
          results: [makePage('page-1', 'My Page')],
          has_more: false,
        });
      }
      if (url.includes('/blocks/page-1/children')) {
        return Response.json({
          results: MOCK_BLOCKS,
          has_more: false,
        });
      }
      return new Response('Not found', { status: 404 });
    });

    const connector = new NotionConnector(makeConfig());
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.load()) {
      docs.push(doc);
    }

    expect(docs.length).toBe(1);
    expect(docs[0].id).toBe('page-1');
    expect(docs[0].title).toBe('My Page');
    expect(docs[0].content).toContain('# Title');
    expect(docs[0].content).toContain('Hello world');
    expect(docs[0].sourceUrl).toBe('https://notion.so/page-1');
  });

  it('extracts page title from properties', async () => {
    fetchSpy.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method || 'GET';

      if (url.includes('/databases/db-1/query') && method === 'POST') {
        return Response.json({
          results: [{
            id: 'p-1',
            url: 'https://notion.so/p-1',
            properties: {
              Title: { type: 'title', title: [{ plain_text: 'Custom Title Prop' }] },
            },
            last_edited_time: '2024-01-01T00:00:00Z',
          }],
          has_more: false,
        });
      }
      if (url.includes('/blocks/')) {
        return Response.json({ results: [], has_more: false });
      }
      return new Response('Not found', { status: 404 });
    });

    const connector = new NotionConnector(makeConfig());
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.load()) {
      docs.push(doc);
    }

    expect(docs[0].title).toBe('Custom Title Prop');
  });

  it('poll(since) uses last_edited_time filter', async () => {
    let capturedBody = '';
    fetchSpy.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method || 'GET';

      if (url.includes('/databases/db-1/query') && method === 'POST') {
        capturedBody = init?.body as string || '';
        return Response.json({ results: [], has_more: false });
      }
      return new Response('Not found', { status: 404 });
    });

    const since = new Date('2024-06-01T00:00:00Z');
    const connector = new NotionConnector(makeConfig());
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.poll(since)) {
      docs.push(doc);
    }

    const body = JSON.parse(capturedBody);
    expect(body.filter).toEqual({
      timestamp: 'last_edited_time',
      last_edited_time: { after: '2024-06-01T00:00:00.000Z' },
    });
  });

  it('testConnection() returns ok on 200', async () => {
    fetchSpy.mockResolvedValue(Response.json({ id: 'bot-1', type: 'bot' }));

    const connector = new NotionConnector(makeConfig());
    const result = await connector.testConnection();
    expect(result.ok).toBe(true);
  });

  it('testConnection() returns error on failure', async () => {
    fetchSpy.mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    const connector = new NotionConnector(makeConfig());
    const result = await connector.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
  });

  it('handles pagination via next_cursor', async () => {
    let queryCount = 0;
    fetchSpy.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method || 'GET';

      if (url.includes('/databases/db-1/query') && method === 'POST') {
        queryCount++;
        const body = JSON.parse(init?.body as string || '{}');
        if (!body.start_cursor) {
          return Response.json({
            results: [makePage('page-1', 'Page 1')],
            has_more: true,
            next_cursor: 'cursor-2',
          });
        }
        return Response.json({
          results: [makePage('page-2', 'Page 2')],
          has_more: false,
        });
      }
      if (url.includes('/blocks/')) {
        return Response.json({ results: [], has_more: false });
      }
      return new Response('Not found', { status: 404 });
    });

    const connector = new NotionConnector(makeConfig());
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.load()) {
      docs.push(doc);
    }

    expect(queryCount).toBe(2);
    expect(docs.length).toBe(2);
    expect(docs[0].title).toBe('Page 1');
    expect(docs[1].title).toBe('Page 2');
  });

  it('fetches standalone pages by pageId', async () => {
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('/pages/standalone-1')) {
        return Response.json(makePage('standalone-1', 'Standalone Page'));
      }
      if (url.includes('/blocks/standalone-1/children')) {
        return Response.json({
          results: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Standalone content' }] } }],
          has_more: false,
        });
      }
      return new Response('Not found', { status: 404 });
    });

    const connector = new NotionConnector(makeConfig({ databaseIds: [], pageIds: ['standalone-1'] }));
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.load()) {
      docs.push(doc);
    }

    expect(docs.length).toBe(1);
    expect(docs[0].title).toBe('Standalone Page');
    expect(docs[0].content).toContain('Standalone content');
  });
});

describe('blocksToMarkdown', () => {
  it('converts all block types to markdown', () => {
    const blocks = [
      { type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'H1' }] } },
      { type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'H2' }] } },
      { type: 'heading_3', heading_3: { rich_text: [{ plain_text: 'H3' }] } },
      { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Text' }] } },
      { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Bullet' }] } },
      { type: 'numbered_list_item', numbered_list_item: { rich_text: [{ plain_text: 'Number' }] } },
      { type: 'code', code: { rich_text: [{ plain_text: 'const x = 1;' }], language: 'javascript' } },
      { type: 'quote', quote: { rich_text: [{ plain_text: 'A quote' }] } },
      { type: 'to_do', to_do: { rich_text: [{ plain_text: 'Task' }], checked: true } },
      { type: 'to_do', to_do: { rich_text: [{ plain_text: 'Unchecked' }], checked: false } },
      { type: 'divider', divider: {} },
      { type: 'image', image: { external: { url: 'https://example.com/img.png' } } },
    ];

    const md = blocksToMarkdown(blocks);

    expect(md).toContain('# H1');
    expect(md).toContain('## H2');
    expect(md).toContain('### H3');
    expect(md).toContain('Text');
    expect(md).toContain('- Bullet');
    expect(md).toContain('1. Number');
    expect(md).toContain('```javascript\nconst x = 1;\n```');
    expect(md).toContain('> A quote');
    expect(md).toContain('- [x] Task');
    expect(md).toContain('- [ ] Unchecked');
    expect(md).toContain('---');
    expect(md).toContain('![](https://example.com/img.png)');
  });

  it('skips unknown block types', () => {
    const blocks = [
      { type: 'unknown_block', unknown_block: {} },
      { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Hello' }] } },
    ];

    const md = blocksToMarkdown(blocks);
    expect(md).toBe('Hello');
  });

  it('handles empty rich_text arrays', () => {
    const blocks = [
      { type: 'paragraph', paragraph: { rich_text: [] } },
    ];

    const md = blocksToMarkdown(blocks);
    expect(md).toBe('');
  });
});
