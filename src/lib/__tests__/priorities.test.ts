import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parsePriorityDoc,
  readPriorityDocs,
  readActivePriorities,
  appendWorkLogEntry,
  matchActivePriorities,
  renderPrioritiesReadme,
  type PriorityDoc,
} from '../priorities.js';

describe('parsePriorityDoc', () => {
  it('parses a minimal valid priority', () => {
    const raw = [
      '---',
      'title: "Market signal rubric tuning"',
      'status: active',
      'tags: [attribution, market-signal]',
      'created_at: 2026-04-16T14:00:00Z',
      '---',
      '',
      '## Goal',
      'Get to >10%.',
    ].join('\n');
    const doc = parsePriorityDoc('/tmp/market-signal.md', raw);
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe('Market signal rubric tuning');
    expect(doc!.status).toBe('active');
    expect(doc!.tags).toEqual(['attribution', 'market-signal']);
    expect(doc!.slug).toBe('market-signal');
    expect(doc!.summary).toContain('## Goal');
  });

  it('skips missing-frontmatter files', () => {
    expect(parsePriorityDoc('/tmp/a.md', 'body only\n')).toBeNull();
  });

  it('skips files without required title + status', () => {
    const raw = ['---', 'tags: [foo]', '---', 'body'].join('\n');
    expect(parsePriorityDoc('/tmp/a.md', raw)).toBeNull();
  });

  it('coerces status to a known enum value', () => {
    const raw = ['---', 'title: "X"', 'status: WIP', 'tags: []', '---', ''].join('\n');
    expect(parsePriorityDoc('/tmp/a.md', raw)).toBeNull();
  });

  it('tolerates quoted string values', () => {
    const raw = [
      "---",
      "title: 'single quoted'",
      'status: pending',
      '---',
      '',
    ].join('\n');
    const doc = parsePriorityDoc('/tmp/single.md', raw);
    expect(doc?.title).toBe('single quoted');
  });
});

describe('readPriorityDocs', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'priorities-'));
    fs.mkdirSync(path.join(tempRoot, 'priorities'), { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function write(name: string, body: string) {
    fs.writeFileSync(path.join(tempRoot, 'priorities', name), body, 'utf-8');
  }

  it('returns an empty array when the dir does not exist', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'priorities-empty-'));
    expect(readPriorityDocs(other)).toEqual([]);
    fs.rmSync(other, { recursive: true, force: true });
  });

  it('skips README.md and non-markdown files', () => {
    write('README.md', '---\ntitle: "readme"\nstatus: active\n---\n');
    write('notes.txt', 'something');
    write('real.md', '---\ntitle: "real"\nstatus: active\n---\n');
    const docs = readPriorityDocs(tempRoot);
    expect(docs.map((d) => d.slug)).toEqual(['real']);
  });

  it('orders active first, then by slug', () => {
    write('b.md', '---\ntitle: "B"\nstatus: active\n---\n');
    write('a.md', '---\ntitle: "A"\nstatus: pending\n---\n');
    write('c.md', '---\ntitle: "C"\nstatus: active\n---\n');
    const order = readPriorityDocs(tempRoot).map((d) => d.slug);
    expect(order).toEqual(['b', 'c', 'a']);
  });

  it('readActivePriorities filters by status', () => {
    write('active.md', '---\ntitle: "A"\nstatus: active\n---\n');
    write('done.md', '---\ntitle: "D"\nstatus: done\n---\n');
    const active = readActivePriorities(tempRoot);
    expect(active).toHaveLength(1);
    expect(active[0].slug).toBe('active');
  });

  it('skips malformed files without throwing', () => {
    write('broken.md', 'not even frontmatter');
    write('good.md', '---\ntitle: "G"\nstatus: active\n---\n');
    const docs = readPriorityDocs(tempRoot);
    expect(docs.map((d) => d.slug)).toEqual(['good']);
  });
});

describe('matchActivePriorities', () => {
  function doc(slug: string, tags: string[]): PriorityDoc {
    return {
      filePath: `/tmp/${slug}.md`,
      slug,
      title: slug,
      status: 'active',
      tags,
      createdAt: null,
      summary: '',
    };
  }

  it('matches a candidate whose subject contains a priority tag', () => {
    const match = matchActivePriorities(
      [doc('attr', ['attribution'])],
      { subject: 'attribution:rollup' },
    );
    expect(match.map((m) => m.slug)).toEqual(['attr']);
  });

  it('matches a candidate whose experiment id contains a priority tag', () => {
    const match = matchActivePriorities(
      [doc('out', ['outreach'])],
      { experimentId: 'outreach-thermostat' },
    );
    expect(match.map((m) => m.slug)).toEqual(['out']);
  });

  it('matches against paths case-insensitively', () => {
    const match = matchActivePriorities(
      [doc('web', ['dashboard'])],
      { paths: ['src/web/src/pages/Dashboard.tsx'] },
    );
    expect(match.map((m) => m.slug)).toEqual(['web']);
  });

  it('returns empty when no signals are provided', () => {
    expect(matchActivePriorities([doc('x', ['y'])], {})).toEqual([]);
  });

  it('returns empty when no tag matches', () => {
    expect(
      matchActivePriorities(
        [doc('a', ['xyz'])],
        { subject: 'attribution:rollup' },
      ),
    ).toEqual([]);
  });
});

describe('appendWorkLogEntry', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'priorities-log-'));
  });
  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function make(body: string): PriorityDoc {
    const file = path.join(tempDir, 'p.md');
    fs.writeFileSync(file, body, 'utf-8');
    return {
      filePath: file,
      slug: 'p',
      title: 't',
      status: 'active',
      tags: [],
      createdAt: null,
      summary: '',
    };
  }

  it('creates a Work Log section when missing and prepends the entry', () => {
    const p = make('---\ntitle: "t"\nstatus: active\n---\n\n## Goal\nbody\n');
    appendWorkLogEntry({ priority: p, actor: 'ohwow/patch-author', message: 'first entry' });
    const updated = fs.readFileSync(p.filePath, 'utf-8');
    expect(updated).toContain('## Work Log');
    expect(updated).toContain('ohwow/patch-author');
    expect(updated).toContain('first entry');
  });

  it('inserts the newest entry directly after an existing Work Log heading', () => {
    const p = make(
      '---\ntitle: "t"\nstatus: active\n---\n\n## Goal\nbody\n\n## Work Log\n\n### 2026-04-15T00:00Z — human\nold entry\n',
    );
    appendWorkLogEntry({ priority: p, actor: 'ohwow/patch-author', message: 'second entry', at: new Date('2026-04-16T00:00:00Z') });
    const updated = fs.readFileSync(p.filePath, 'utf-8');
    const workLogIdx = updated.indexOf('## Work Log');
    const secondIdx = updated.indexOf('second entry');
    const oldIdx = updated.indexOf('old entry');
    expect(workLogIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(workLogIdx);
    expect(oldIdx).toBeGreaterThan(secondIdx);
  });
});

describe('renderPrioritiesReadme', () => {
  it('groups by status and renders relative links', () => {
    const docs: PriorityDoc[] = [
      { filePath: '/tmp/p/a.md', slug: 'a', title: 'Apple', status: 'active', tags: ['fruit'], createdAt: null, summary: '' },
      { filePath: '/tmp/p/b.md', slug: 'b', title: 'Banana', status: 'pending', tags: [], createdAt: null, summary: '' },
    ];
    const md = renderPrioritiesReadme(docs);
    expect(md).toContain('[Apple](./a.md)');
    expect(md).toContain('tags: fruit');
    expect(md).toContain('[Banana](./b.md)');
    expect(md).toMatch(/## Active[\s\S]*Apple/);
    expect(md).toMatch(/## Pending[\s\S]*Banana/);
    expect(md).toMatch(/## Done[\s\S]*\(none\)/);
  });
});
