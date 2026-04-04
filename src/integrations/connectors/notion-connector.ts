/**
 * Notion Data Source Connector
 * Fetches pages and database entries from Notion via the REST API.
 */

import type { DataSourceConnector, ConnectorDocument, ConnectorConfig } from '../connector-types.js';
import { logger } from '../../lib/logger.js';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const TIMEOUT_MS = 30_000;

interface NotionPage {
  id: string;
  url: string;
  properties: Record<string, unknown>;
  last_edited_time: string;
}

interface NotionBlock {
  type: string;
  [key: string]: unknown;
}

export class NotionConnector implements DataSourceConnector {
  readonly type = 'notion' as const;
  readonly name: string;
  private apiKey: string;
  private databaseIds: string[];
  private pageIds: string[];

  constructor(config: ConnectorConfig) {
    this.name = config.name;
    const s = config.settings as {
      apiKey: string;
      databaseIds?: string[];
      pageIds?: string[];
    };
    this.apiKey = s.apiKey;
    this.databaseIds = s.databaseIds || [];
    this.pageIds = s.pageIds || [];
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    };
  }

  async *load(): AsyncGenerator<ConnectorDocument> {
    yield* this.fetchAll();
  }

  async *poll(since: Date): AsyncGenerator<ConnectorDocument> {
    yield* this.fetchAll(since);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const resp = await fetch(`${NOTION_API}/users/me`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (resp.ok) return { ok: true };
      return { ok: false, error: `Notion API returned ${resp.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
    }
  }

  private async *fetchAll(since?: Date): AsyncGenerator<ConnectorDocument> {
    // Fetch pages from databases
    for (const dbId of this.databaseIds) {
      yield* this.queryDatabase(dbId, since);
    }

    // Fetch standalone pages
    for (const pageId of this.pageIds) {
      const doc = await this.fetchPage(pageId, since);
      if (doc) yield doc;
    }
  }

  private async *queryDatabase(databaseId: string, since?: Date): AsyncGenerator<ConnectorDocument> {
    let startCursor: string | undefined;

    do {
      const body: Record<string, unknown> = { page_size: 100 };
      if (startCursor) {
        body.start_cursor = startCursor;
      }
      if (since) {
        body.filter = {
          timestamp: 'last_edited_time',
          last_edited_time: { after: since.toISOString() },
        };
      }

      let data: { results?: NotionPage[]; has_more?: boolean; next_cursor?: string | null };

      try {
        const resp = await fetch(`${NOTION_API}/databases/${databaseId}/query`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!resp.ok) {
          logger.error({ status: resp.status, databaseId }, '[notion-connector] Failed to query database');
          return;
        }
        data = await resp.json() as typeof data;
      } catch (err) {
        logger.error({ err, databaseId }, '[notion-connector] Database query error');
        return;
      }

      for (const page of data.results || []) {
        const title = extractPageTitle(page);
        const blocks = await this.fetchBlocks(page.id);
        const content = blocksToMarkdown(blocks);

        yield {
          id: page.id,
          title,
          content,
          sourceUrl: page.url,
          metadata: { databaseId },
          updatedAt: new Date(page.last_edited_time),
          mimeType: 'text/markdown',
        };
      }

      startCursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
    } while (startCursor);
  }

  private async fetchPage(pageId: string, since?: Date): Promise<ConnectorDocument | null> {
    try {
      // Fetch page metadata
      const pageResp = await fetch(`${NOTION_API}/pages/${pageId}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!pageResp.ok) {
        logger.warn({ status: pageResp.status, pageId }, '[notion-connector] Failed to fetch page');
        return null;
      }

      const page = await pageResp.json() as NotionPage;

      // Skip if page hasn't been edited since the cutoff
      if (since && new Date(page.last_edited_time) <= since) {
        return null;
      }

      const title = extractPageTitle(page);
      const blocks = await this.fetchBlocks(pageId);
      const content = blocksToMarkdown(blocks);

      return {
        id: page.id,
        title,
        content,
        sourceUrl: page.url,
        updatedAt: new Date(page.last_edited_time),
        mimeType: 'text/markdown',
      };
    } catch (err) {
      logger.warn({ err, pageId }, '[notion-connector] Failed to fetch page');
      return null;
    }
  }

  private async fetchBlocks(pageId: string): Promise<NotionBlock[]> {
    const allBlocks: NotionBlock[] = [];
    let startCursor: string | undefined;

    do {
      const params = new URLSearchParams({ page_size: '100' });
      if (startCursor) {
        params.set('start_cursor', startCursor);
      }

      try {
        const resp = await fetch(`${NOTION_API}/blocks/${pageId}/children?${params.toString()}`, {
          headers: this.headers(),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!resp.ok) break;

        const data = await resp.json() as {
          results?: NotionBlock[];
          has_more?: boolean;
          next_cursor?: string | null;
        };

        allBlocks.push(...(data.results || []));
        startCursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
      } catch (err) {
        logger.warn({ err, pageId }, '[notion-connector] Failed to fetch blocks');
        break;
      }
    } while (startCursor);

    return allBlocks;
  }
}

/** Extract the page title from Notion properties */
function extractPageTitle(page: NotionPage): string {
  const props = page.properties || {};
  // Try common title property names
  for (const key of ['Name', 'Title', 'title', 'name']) {
    const prop = props[key] as { title?: Array<{ plain_text: string }> } | undefined;
    if (prop?.title?.[0]?.plain_text) {
      return prop.title[0].plain_text;
    }
  }
  // Fallback: search all properties for a title type
  for (const prop of Object.values(props)) {
    const p = prop as { type?: string; title?: Array<{ plain_text: string }> };
    if (p.type === 'title' && p.title?.[0]?.plain_text) {
      return p.title[0].plain_text;
    }
  }
  return 'Untitled';
}

function richTextToPlain(richText: unknown): string {
  if (!Array.isArray(richText)) return '';
  return richText.map((t: { plain_text?: string }) => t.plain_text || '').join('');
}

/** Convert Notion blocks to markdown */
export function blocksToMarkdown(blocks: NotionBlock[]): string {
  return blocks.map((block) => {
    const data = block[block.type] as Record<string, unknown> | undefined;
    if (!data) return '';

    switch (block.type) {
      case 'paragraph':
        return richTextToPlain(data.rich_text);
      case 'heading_1':
        return `# ${richTextToPlain(data.rich_text)}`;
      case 'heading_2':
        return `## ${richTextToPlain(data.rich_text)}`;
      case 'heading_3':
        return `### ${richTextToPlain(data.rich_text)}`;
      case 'bulleted_list_item':
        return `- ${richTextToPlain(data.rich_text)}`;
      case 'numbered_list_item':
        return `1. ${richTextToPlain(data.rich_text)}`;
      case 'code':
        return `\`\`\`${(data.language as string) || ''}\n${richTextToPlain(data.rich_text)}\n\`\`\``;
      case 'quote':
        return `> ${richTextToPlain(data.rich_text)}`;
      case 'to_do': {
        const checked = data.checked ? 'x' : ' ';
        return `- [${checked}] ${richTextToPlain(data.rich_text)}`;
      }
      case 'divider':
        return '---';
      case 'image': {
        const file = data.file as { url?: string } | undefined;
        const external = data.external as { url?: string } | undefined;
        return `![](${file?.url || external?.url || ''})`;
      }
      default:
        return '';
    }
  }).filter(Boolean).join('\n\n');
}
