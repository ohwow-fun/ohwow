import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalFilesConnector } from '../local-files-connector.js';
import type { ConnectorConfig, ConnectorDocument } from '../../connector-types.js';
import { mkdtemp, writeFile, rm, mkdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeConfig(dirPath: string, overrides?: Record<string, unknown>): ConnectorConfig {
  return {
    id: 'lf-1',
    type: 'local-files',
    name: 'Test Local Files',
    settings: { path: dirPath, ...overrides },
    syncIntervalMinutes: 30,
    pruneIntervalDays: 30,
    enabled: true,
  };
}

describe('LocalFilesConnector', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ohwow-local-files-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('load() reads files matching default patterns', async () => {
    await writeFile(join(tmpDir, 'readme.md'), 'Hello markdown');
    await writeFile(join(tmpDir, 'notes.txt'), 'Hello text');
    await writeFile(join(tmpDir, 'code.ts'), 'const x = 1;');  // not matched by default

    const connector = new LocalFilesConnector(makeConfig(tmpDir));
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.load()) {
      docs.push(doc);
    }

    expect(docs.length).toBe(2);
    const titles = docs.map((d) => d.title).sort();
    expect(titles).toEqual(['notes.txt', 'readme.md']);
    expect(docs.find((d) => d.title === 'readme.md')?.content).toBe('Hello markdown');
  });

  it('load() reads files with custom patterns', async () => {
    await writeFile(join(tmpDir, 'data.json'), '{"key":"value"}');
    await writeFile(join(tmpDir, 'readme.md'), 'Hello');

    const connector = new LocalFilesConnector(makeConfig(tmpDir, { patterns: ['*.json'] }));
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.load()) {
      docs.push(doc);
    }

    expect(docs.length).toBe(1);
    expect(docs[0].title).toBe('data.json');
  });

  it('load() recurses into subdirectories by default', async () => {
    await mkdir(join(tmpDir, 'sub'));
    await writeFile(join(tmpDir, 'top.md'), 'Top level');
    await writeFile(join(tmpDir, 'sub', 'nested.md'), 'Nested');

    const connector = new LocalFilesConnector(makeConfig(tmpDir));
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.load()) {
      docs.push(doc);
    }

    expect(docs.length).toBe(2);
    const titles = docs.map((d) => d.title).sort();
    expect(titles).toContain('top.md');
    // Recursive readdir returns relative paths with separators
    expect(titles.some((t) => t.includes('nested.md'))).toBe(true);
  });

  it('load() respects recursive: false', async () => {
    await mkdir(join(tmpDir, 'sub'));
    await writeFile(join(tmpDir, 'top.md'), 'Top level');
    await writeFile(join(tmpDir, 'sub', 'nested.md'), 'Nested');

    const connector = new LocalFilesConnector(makeConfig(tmpDir, { recursive: false }));
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.load()) {
      docs.push(doc);
    }

    expect(docs.length).toBe(1);
    expect(docs[0].title).toBe('top.md');
  });

  it('poll(since) only returns files modified after since date', async () => {
    const oldDate = new Date('2020-01-01T00:00:00Z');
    const _recentDate = new Date(Date.now() + 60_000); // future to ensure it's "new"

    await writeFile(join(tmpDir, 'old.md'), 'Old content');
    // Set mtime to the past
    await utimes(join(tmpDir, 'old.md'), oldDate, oldDate);

    await writeFile(join(tmpDir, 'new.md'), 'New content');
    // new.md gets current mtime which is after our since threshold

    const since = new Date(Date.now() - 5_000); // 5 seconds ago
    const connector = new LocalFilesConnector(makeConfig(tmpDir));
    const docs: ConnectorDocument[] = [];
    for await (const doc of connector.poll(since)) {
      docs.push(doc);
    }

    expect(docs.length).toBe(1);
    expect(docs[0].title).toBe('new.md');
    expect(docs[0].content).toBe('New content');
  });

  it('testConnection() returns ok for valid directory', async () => {
    const connector = new LocalFilesConnector(makeConfig(tmpDir));
    const result = await connector.testConnection();
    expect(result.ok).toBe(true);
  });

  it('testConnection() returns error for missing directory', async () => {
    const connector = new LocalFilesConnector(makeConfig('/nonexistent/path/xyz'));
    const result = await connector.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('testConnection() returns error for file path (not directory)', async () => {
    const filePath = join(tmpDir, 'afile.txt');
    await writeFile(filePath, 'content');

    const connector = new LocalFilesConnector(makeConfig(filePath));
    const result = await connector.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not a directory');
  });

  it('documents have stable IDs based on relative path', async () => {
    await writeFile(join(tmpDir, 'readme.md'), 'Hello');

    const connector = new LocalFilesConnector(makeConfig(tmpDir));
    const docs1: ConnectorDocument[] = [];
    for await (const doc of connector.load()) docs1.push(doc);

    const docs2: ConnectorDocument[] = [];
    for await (const doc of connector.load()) docs2.push(doc);

    expect(docs1[0].id).toBe(docs2[0].id);
  });
});
