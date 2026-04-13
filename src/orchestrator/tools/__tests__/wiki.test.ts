import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWikiPage, readWikiPage, parseWikiPage } from '../wiki.js';
import type { LocalToolContext } from '../../local-tool-types.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// writeWikiPage reads its data dir from OHWOW_DB_PATH. Point it at a
// disposable tmpdir so each test gets an isolated wiki.
function makeCtx(workspaceId = 'ws-test'): LocalToolContext {
  return {
    db: {} as unknown as LocalToolContext['db'],
    workspaceId,
    engine: {} as unknown as LocalToolContext['engine'],
    channels: {} as unknown as LocalToolContext['channels'],
    controlPlane: null,
  } as unknown as LocalToolContext;
}

describe('wiki_write_page frontmatter merge semantics', () => {
  let tmp: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ohwow-wiki-test-'));
    prevEnv = process.env.OHWOW_DB_PATH;
    process.env.OHWOW_DB_PATH = join(tmp, 'runtime.db');
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.OHWOW_DB_PATH;
    else process.env.OHWOW_DB_PATH = prevEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  function readLivePage(workspaceId: string, slug: string): string {
    const path = join(tmp, 'wiki', workspaceId, `${slug}.md`);
    return readFileSync(path, 'utf-8');
  }

  it('creates a page with full frontmatter on first write', async () => {
    const ctx = makeCtx();
    const result = await writeWikiPage(ctx, {
      slug: 'relevance-ai',
      title: 'Relevance AI',
      body: 'A competitor that focuses on enterprise GTM automation. It beats us on brand but loses on memory.',
      summary: 'Enterprise GTM automation built on AI agents.',
      related: ['crewai', 'lindy-ai'],
    });
    expect(result.success).toBe(true);

    const raw = readLivePage('ws-test', 'relevance-ai');
    expect(raw).toContain('summary: Enterprise GTM automation built on AI agents.');
    expect(raw).toContain('related: [crewai, lindy-ai]');
    expect(raw).toContain('version: 1');
  });

  it('preserves existing summary when an update omits the summary field', async () => {
    const ctx = makeCtx();
    // v1: full frontmatter
    await writeWikiPage(ctx, {
      slug: 'competitive-cheat-sheet',
      title: 'Competitive Cheat Sheet',
      body: 'Master positioning doc. Refresh quarterly with live scrapes.',
      summary: 'Master positioning doc — whole company vs department, local vs cloud.',
      related: ['relevance-ai', 'lindy-ai'],
    });

    // v2: caller only updates body + related, omits summary entirely
    // (the failure mode from the live bug — a backlink fix wiping summary).
    await writeWikiPage(ctx, {
      slug: 'competitive-cheat-sheet',
      title: 'Competitive Cheat Sheet',
      body: 'Master positioning doc. Refresh quarterly with live scrapes.\n\nSee also [[enterprise-discount-policy]].',
      related: ['relevance-ai', 'lindy-ai', 'enterprise-discount-policy'],
    });

    const raw = readLivePage('ws-test', 'competitive-cheat-sheet');
    expect(raw).toContain('summary: Master positioning doc — whole company vs department, local vs cloud.');
    expect(raw).toContain('enterprise-discount-policy');
    expect(raw).toContain('version: 2');
  });

  it('preserves existing related list when an update omits related', async () => {
    const ctx = makeCtx();
    await writeWikiPage(ctx, {
      slug: 'page-a',
      title: 'Page A',
      body: 'First version body content, plenty of words to pass length check.',
      summary: 'First summary.',
      related: ['page-b', 'page-c'],
    });

    // Caller only updates summary. `related` must survive.
    await writeWikiPage(ctx, {
      slug: 'page-a',
      title: 'Page A',
      body: 'Second version body content, plenty of words to pass length check.',
      summary: 'Updated summary.',
    });

    const read = await readWikiPage(ctx, { slug: 'page-a' });
    expect(read.success).toBe(true);
    const data = read.data as { summary: string | null; related: string[] };
    expect(data.summary).toBe('Updated summary.');
    expect(data.related).toEqual(['page-b', 'page-c']);
  });

  it('treats an explicit empty string as an intentional clear of summary', async () => {
    const ctx = makeCtx();
    await writeWikiPage(ctx, {
      slug: 'page-clear',
      title: 'Page Clear',
      body: 'First version body content, plenty of words to pass length check.',
      summary: 'Has a summary.',
    });

    // Caller explicitly passes empty string — intentional clear.
    await writeWikiPage(ctx, {
      slug: 'page-clear',
      title: 'Page Clear',
      body: 'Second version body content, plenty of words to pass length check.',
      summary: '',
    });

    const read = await readWikiPage(ctx, { slug: 'page-clear' });
    const data = read.data as { summary: string | null };
    expect(data.summary).toBeNull();
  });

  it('treats an explicit empty array as an intentional clear of related', async () => {
    const ctx = makeCtx();
    await writeWikiPage(ctx, {
      slug: 'page-clear-related',
      title: 'Page Clear Related',
      body: 'First version body content, plenty of words to pass length check.',
      related: ['a', 'b'],
    });

    await writeWikiPage(ctx, {
      slug: 'page-clear-related',
      title: 'Page Clear Related',
      body: 'Second version body content, plenty of words to pass length check.',
      related: [],
    });

    const read = await readWikiPage(ctx, { slug: 'page-clear-related' });
    const data = read.data as { related: string[] };
    expect(data.related).toEqual([]);
  });

  it('bumps version and snapshots the prior file to .versions/', async () => {
    const ctx = makeCtx();
    await writeWikiPage(ctx, {
      slug: 'page-versioned',
      title: 'Page Versioned',
      body: 'Plenty of body content to satisfy the 50 char minimum for writes.',
      summary: 'v1 summary',
    });
    await writeWikiPage(ctx, {
      slug: 'page-versioned',
      title: 'Page Versioned',
      body: 'Second body content with slightly different wording to compare.',
    });

    const v1Path = join(tmp, 'wiki', 'ws-test', '.versions', 'page-versioned', 'v1.md');
    expect(existsSync(v1Path)).toBe(true);
    const v1Raw = readFileSync(v1Path, 'utf-8');
    const v1 = parseWikiPage('page-versioned', v1Path, v1Raw);
    expect(v1.frontmatter.summary).toBe('v1 summary');
    expect(v1.frontmatter.version).toBe(1);

    const liveRaw = readLivePage('ws-test', 'page-versioned');
    expect(liveRaw).toContain('version: 2');
    // Summary carried forward.
    expect(liveRaw).toContain('summary: v1 summary');
  });
});
