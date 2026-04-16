import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getOrCreate,
  hashInputs,
  stableStringify,
  list,
  cacheUri,
  parseCacheUri,
  resolveCacheUri,
} from '../asset-cache.js';

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ohwow-asset-cache-'));
  process.env.OHWOW_MEDIA_CACHE_DIR = dir;
  return dir;
}

describe('asset-cache', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it('stableStringify sorts object keys deterministically', () => {
    const a = stableStringify({ b: 1, a: 2, c: [{ y: 1, x: 2 }] });
    const b = stableStringify({ c: [{ x: 2, y: 1 }], a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('hashInputs is deterministic and order-independent', () => {
    const h1 = hashInputs('voice', { voice: 'af', text: 'hi', speed: 1 });
    const h2 = hashInputs('voice', { speed: 1, text: 'hi', voice: 'af' });
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it('hashInputs differs across modalities with same payload', () => {
    const h1 = hashInputs('voice', { prompt: 'x' });
    const h2 = hashInputs('music', { prompt: 'x' });
    expect(h1).not.toBe(h2);
  });

  it('getOrCreate produces on miss and reuses on hit', async () => {
    let produceCalls = 0;
    const makeGen = () => ({
      produce: async () => {
        produceCalls++;
        return { buffer: Buffer.from('hello'), extension: '.mp3' };
      },
    });

    const first = await getOrCreate('voice', { text: 'hi' }, makeGen());
    expect(first.cached).toBe(false);
    expect(first.hash).toHaveLength(64);
    expect(produceCalls).toBe(1);

    const second = await getOrCreate('voice', { text: 'hi' }, makeGen());
    expect(second.cached).toBe(true);
    expect(second.hash).toBe(first.hash);
    expect(second.path).toBe(first.path);
    expect(produceCalls).toBe(1);
  });

  it('different inputs produce different cache paths', async () => {
    const gen = (tag: string) => ({
      produce: async () => ({ buffer: Buffer.from(tag), extension: '.mp3' }),
    });
    const a = await getOrCreate('voice', { text: 'a' }, gen('a'));
    const b = await getOrCreate('voice', { text: 'b' }, gen('b'));
    expect(a.hash).not.toBe(b.hash);
    expect(a.path).not.toBe(b.path);
  });

  it('list returns sidecar metadata', async () => {
    await getOrCreate(
      'music',
      { prompt: 'lofi' },
      { produce: async () => ({ buffer: Buffer.from('x'), extension: '.wav' }) },
    );
    const entries = await list();
    expect(entries).toHaveLength(1);
    expect(entries[0].modality).toBe('music');
    expect(entries[0].inputs).toEqual({ prompt: 'lofi' });
  });

  it('cache:// URIs roundtrip and resolve to paths', async () => {
    const { hash, path } = await getOrCreate(
      'voice',
      { text: 'ohwow' },
      { produce: async () => ({ buffer: Buffer.from('x'), extension: '.mp3' }) },
    );
    const uri = cacheUri(hash);
    expect(parseCacheUri(uri)).toBe(hash);
    expect(await resolveCacheUri(uri)).toBe(path);
  });

  it('resolveCacheUri returns null for unknown hashes', async () => {
    expect(await resolveCacheUri('cache://deadbeef')).toBeNull();
    expect(await resolveCacheUri('audio/file.mp3')).toBeNull();
  });
});
