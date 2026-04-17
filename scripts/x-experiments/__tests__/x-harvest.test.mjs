/**
 * Unit tests for filterPosts in _x-harvest.mjs. Covers the engager-source
 * exemption that keeps replier rows alive through the filter chain (the
 * whole point of the engager surface is that the rows ARE replies with
 * often-zero likes).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { filterPosts, buildEngagerRecord, writeEngagersSidecar, engagersSidecarPath } from '../_x-harvest.mjs';

const baseFilters = {
  drop_retweets: false,
  drop_replies_to_others: true,
  language: 'en',
  min_engagement: { likes: 5, replies: 0 },
};

describe('filterPosts', () => {
  it('drops replies from general sources when drop_replies_to_others is set', () => {
    const posts = [
      { permalink: '/a/1', replyingTo: true, likes: 10, replies: 0, lang: 'en' },
      { permalink: '/b/2', replyingTo: false, likes: 10, replies: 0, lang: 'en' },
    ];
    const filtered = filterPosts(posts, baseFilters);
    expect(filtered.map(p => p.permalink)).toEqual(['/b/2']);
  });

  it('keeps engager-sourced replies even when drop_replies_to_others is set', () => {
    const posts = [
      { permalink: '/a/1', replyingTo: true, likes: 10, replies: 0, lang: 'en', _engagerSource: 'engager:competitor:zapier' },
      { permalink: '/b/2', replyingTo: true, likes: 10, replies: 0, lang: 'en' },
    ];
    const filtered = filterPosts(posts, baseFilters);
    expect(filtered.map(p => p.permalink)).toEqual(['/a/1']);
  });

  it('bypasses min_engagement for engager-sourced rows so low-like repliers survive', () => {
    const posts = [
      { permalink: '/a/1', replyingTo: true, likes: 0, replies: 0, lang: 'en', _engagerSource: 'engager:own-post' },
      { permalink: '/b/2', replyingTo: false, likes: 0, replies: 0, lang: 'en' },
    ];
    const filtered = filterPosts(posts, baseFilters);
    expect(filtered.map(p => p.permalink)).toEqual(['/a/1']);
  });

  it('still drops retweets even for engager-sourced rows', () => {
    const posts = [
      { permalink: '/a/1', replyingTo: true, isRetweet: true, likes: 0, replies: 0, lang: 'en', _engagerSource: 'engager:own-post' },
    ];
    const filtered = filterPosts(posts, { ...baseFilters, drop_retweets: true });
    expect(filtered).toEqual([]);
  });

  it('still drops non-matching language even for engager-sourced rows', () => {
    const posts = [
      { permalink: '/a/1', replyingTo: true, likes: 0, replies: 0, lang: 'es', _engagerSource: 'engager:own-post' },
      { permalink: '/b/2', replyingTo: true, likes: 0, replies: 0, lang: 'en', _engagerSource: 'engager:own-post' },
    ];
    const filtered = filterPosts(posts, baseFilters);
    expect(filtered.map(p => p.permalink)).toEqual(['/b/2']);
  });
});

describe('buildEngagerRecord', () => {
  it('captures handle, parent, source, engagement, and truncated text', () => {
    const row = {
      author: 'shannholmberg',
      displayName: 'Shann',
      permalink: '/shannholmberg/status/123',
      likes: 2,
      replies: 1,
      reposts: 0,
      lang: 'en',
      text: 'same pain. glue everywhere',
      datetime: '2026-04-17T00:00:00Z',
    };
    const rec = buildEngagerRecord(row, 'engager:competitor:zapier', 'zapier', '/zapier/status/999');
    expect(rec.handle).toBe('shannholmberg');
    expect(rec.parent_author).toBe('zapier');
    expect(rec.parent_permalink).toBe('/zapier/status/999');
    expect(rec.engager_source).toBe('engager:competitor:zapier');
    expect(rec.text).toBe('same pain. glue everywhere');
    expect(rec.likes).toBe(2);
    expect(typeof rec.first_seen_ts).toBe('string');
  });

  it('defaults missing fields to null/zero without throwing', () => {
    const rec = buildEngagerRecord({}, 'engager:own-post', null, null);
    expect(rec.handle).toBeNull();
    expect(rec.parent_author).toBeNull();
    expect(rec.likes).toBe(0);
    expect(rec.text).toBe('');
  });

  it('truncates overlong text to 600 chars', () => {
    const long = 'x'.repeat(2000);
    const rec = buildEngagerRecord({ text: long, author: 'a', permalink: '/a/1' }, 'engager:own-post', 'ohwow_fun', '/ohwow_fun/status/1');
    expect(rec.text.length).toBe(600);
  });
});

describe('writeEngagersSidecar', () => {
  let tmpHome;
  let origHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'x-engagers-test-'));
    origHome = process.env.HOME;
    // engagersSidecarPath uses os.homedir() — redirect HOME so the test
    // write lands in a throwaway dir, not the real workspace.
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes one JSONL row per record under ~/.ohwow/workspaces/<ws>/', () => {
    const rows = [
      buildEngagerRecord({ author: 'a', permalink: '/a/1', text: 'first', likes: 0, replies: 0 }, 'engager:own-post', 'ohwow_fun', '/ohwow_fun/status/1'),
      buildEngagerRecord({ author: 'b', permalink: '/b/2', text: 'second', likes: 3, replies: 1 }, 'engager:competitor:zapier', 'zapier', '/zapier/status/2'),
    ];
    const written = writeEngagersSidecar('testws', '2026-04-17', rows);
    expect(written).toContain('testws');
    expect(written).toContain('x-engagers-2026-04-17.jsonl');
    const contents = fs.readFileSync(written, 'utf8').trim().split('\n');
    expect(contents.length).toBe(2);
    const first = JSON.parse(contents[0]);
    expect(first.handle).toBe('a');
    expect(first.engager_source).toBe('engager:own-post');
    const second = JSON.parse(contents[1]);
    expect(second.parent_author).toBe('zapier');
  });

  it('returns null and writes nothing for empty input', () => {
    const written = writeEngagersSidecar('testws', '2026-04-17', []);
    expect(written).toBeNull();
    const expectedPath = engagersSidecarPath('testws', '2026-04-17');
    expect(fs.existsSync(expectedPath)).toBe(false);
  });

  it('overwrites rather than appends on re-run', () => {
    const first = [buildEngagerRecord({ author: 'a', permalink: '/a/1' }, 'engager:own-post', 'ohwow_fun', '/ohwow_fun/status/1')];
    writeEngagersSidecar('testws', '2026-04-17', first);
    const second = [
      buildEngagerRecord({ author: 'b', permalink: '/b/1' }, 'engager:own-post', 'ohwow_fun', '/ohwow_fun/status/2'),
      buildEngagerRecord({ author: 'c', permalink: '/c/1' }, 'engager:own-post', 'ohwow_fun', '/ohwow_fun/status/2'),
    ];
    const written = writeEngagersSidecar('testws', '2026-04-17', second);
    const lines = fs.readFileSync(written, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).handle).toBe('b');
  });
});
