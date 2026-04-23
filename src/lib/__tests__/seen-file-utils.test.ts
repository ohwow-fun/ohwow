import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSeen, appendSeen, filterFresh } from '../seen-file-utils.js';

const TMP = join(tmpdir(), `seen-file-test-${Date.now()}`);

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe('loadSeen', () => {
  it('returns empty set when file does not exist', () => {
    const seenPath = join(TMP, 'nonexistent.jsonl');
    const seen = loadSeen(seenPath);
    expect(seen).toBeInstanceOf(Set);
    expect(seen.size).toBe(0);
  });

  it('parses ids from JSONL lines', () => {
    const seenPath = join(TMP, 'seen.jsonl');
    const lines = [
      JSON.stringify({ id: 'item-1', ts: '2024-01-01T00:00:00Z' }),
      JSON.stringify({ id: 'item-2', ts: '2024-01-01T00:00:01Z' }),
      JSON.stringify({ id: 'item-3', ts: '2024-01-01T00:00:02Z' }),
    ];
    writeFileSync(seenPath, lines.join('\n'));

    const seen = loadSeen(seenPath);
    expect(seen.size).toBe(3);
    expect(seen.has('item-1')).toBe(true);
    expect(seen.has('item-2')).toBe(true);
    expect(seen.has('item-3')).toBe(true);
  });

  it('skips malformed lines without throwing', () => {
    const seenPath = join(TMP, 'seen-malformed.jsonl');
    const lines = [
      JSON.stringify({ id: 'item-1', ts: '2024-01-01T00:00:00Z' }),
      'not valid json',
      'another bad line {]',
      JSON.stringify({ id: 'item-2', ts: '2024-01-01T00:00:01Z' }),
      '', // empty line
    ];
    writeFileSync(seenPath, lines.join('\n'));

    const seen = loadSeen(seenPath);
    expect(seen.size).toBe(2);
    expect(seen.has('item-1')).toBe(true);
    expect(seen.has('item-2')).toBe(true);
  });
});

describe('appendSeen', () => {
  it('creates file and appends JSONL entries', () => {
    const seenPath = join(TMP, 'new-seen.jsonl');
    expect(existsSync(seenPath)).toBe(false);

    const items = [{ id: 'new-1' }, { id: 'new-2' }];
    appendSeen(seenPath, items);

    expect(existsSync(seenPath)).toBe(true);
    const content = readFileSync(seenPath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);

    const parsed1 = JSON.parse(lines[0]);
    const parsed2 = JSON.parse(lines[1]);
    expect(parsed1.id).toBe('new-1');
    expect(parsed2.id).toBe('new-2');
    expect(parsed1.ts).toBeDefined();
    expect(parsed2.ts).toBeDefined();
  });

  it('appends to existing file without overwriting', () => {
    const seenPath = join(TMP, 'append-test.jsonl');
    const initialLine = JSON.stringify({ id: 'existing-1', ts: '2024-01-01T00:00:00Z' });
    writeFileSync(seenPath, initialLine + '\n');

    const items = [{ id: 'new-3' }, { id: 'new-4' }];
    appendSeen(seenPath, items);

    const content = readFileSync(seenPath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(3);

    const parsed0 = JSON.parse(lines[0]);
    const parsed1 = JSON.parse(lines[1]);
    const parsed2 = JSON.parse(lines[2]);
    expect(parsed0.id).toBe('existing-1');
    expect(parsed1.id).toBe('new-3');
    expect(parsed2.id).toBe('new-4');
  });

  it('does nothing when items array is empty', () => {
    const seenPath = join(TMP, 'empty-append.jsonl');
    appendSeen(seenPath, []);

    expect(existsSync(seenPath)).toBe(false);
  });
});

describe('filterFresh', () => {
  it('excludes items already in the seen set', () => {
    const seen = new Set(['item-1', 'item-3']);
    const items = [
      { id: 'item-1', name: 'First' },
      { id: 'item-2', name: 'Second' },
      { id: 'item-3', name: 'Third' },
      { id: 'item-4', name: 'Fourth' },
    ];

    const fresh = filterFresh(items, seen);

    expect(fresh.length).toBe(2);
    expect(fresh[0].id).toBe('item-2');
    expect(fresh[1].id).toBe('item-4');
  });

  it('returns all items when seen set is empty', () => {
    const seen = new Set<string>();
    const items = [
      { id: 'item-1', name: 'First' },
      { id: 'item-2', name: 'Second' },
    ];

    const fresh = filterFresh(items, seen);

    expect(fresh.length).toBe(2);
    expect(fresh[0].id).toBe('item-1');
    expect(fresh[1].id).toBe('item-2');
  });
});
