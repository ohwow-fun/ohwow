import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retrieveFromMesh } from '../distributed-retrieval.js';
import type { RagChunk } from '../retrieval.js';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makePeer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'peer-1',
    name: 'Laptop',
    base_url: 'http://192.168.1.10:7700',
    peer_token: 'tok-abc',
    last_seen_at: new Date().toISOString(),
    knowledge_chunk_count: 10,
    ...overrides,
  };
}

function makeChunk(overrides: Partial<RagChunk> = {}): RagChunk {
  return {
    id: 'chunk-1',
    documentId: 'doc-1',
    documentTitle: 'Test Doc',
    content: 'Some knowledge content about distributed systems and mesh networking.',
    score: 0.8,
    tokenCount: 20,
    ...overrides,
  };
}

function mockDb(peers: Record<string, unknown>[] = []) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function chain(): any {
    return {
      select: () => chain(),
      eq: () => chain(),
      then: (resolve: (v: { data: typeof peers }) => void, reject?: (e: unknown) => void) => {
        return Promise.resolve({ data: peers }).then(resolve, reject);
      },
    };
  }
  return { from: () => chain() } as unknown as import('../../../db/adapter-types.js').DatabaseAdapter;
}

describe('retrieveFromMesh', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty when no active peers', async () => {
    const result = await retrieveFromMesh({
      db: mockDb([]),
      workspaceId: 'local',
      query: 'test query',
    });

    expect(result.chunks).toEqual([]);
    expect(result.peerSources).toEqual([]);
  });

  it('skips peers with no knowledge chunks', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const db = mockDb([makePeer({ knowledge_chunk_count: 0 })]);

    const result = await retrieveFromMesh({
      db,
      workspaceId: 'local',
      query: 'test',
    });

    expect(result.chunks).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips stale peers (last seen > 60s ago)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const stalePeer = makePeer({
      last_seen_at: new Date(Date.now() - 120_000).toISOString(),
    });
    const db = mockDb([stalePeer]);

    const result = await retrieveFromMesh({
      db,
      workspaceId: 'local',
      query: 'test',
    });

    expect(result.chunks).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('queries peers in parallel and merges results', async () => {
    const chunk1 = makeChunk({ id: 'c1', content: 'Alpha content about distributed systems' });
    const chunk2 = makeChunk({ id: 'c2', content: 'Beta content about mesh networking protocols' });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ chunks: [chunk1, chunk2] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const db = mockDb([makePeer()]);
    const result = await retrieveFromMesh({
      db,
      workspaceId: 'local',
      query: 'distributed systems',
    });

    expect(result.chunks).toHaveLength(2);
    expect(result.peerSources).toHaveLength(1);
    expect(result.peerSources[0].chunkCount).toBe(2);
  });

  it('applies 0.9x score penalty to remote chunks', async () => {
    const chunk = makeChunk({ score: 1.0 });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ chunks: [chunk] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const db = mockDb([makePeer()]);
    const result = await retrieveFromMesh({
      db,
      workspaceId: 'local',
      query: 'test',
    });

    expect(result.chunks[0].score).toBeCloseTo(0.9);
  });

  it('deduplicates by content prefix', async () => {
    const content = 'Identical content that appears on both peers for deduplication testing purposes.';
    const chunk1 = makeChunk({ id: 'c1', content, score: 0.9 });
    const chunk2 = makeChunk({ id: 'c2', content, score: 0.7 });

    // Two peers return same content
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ chunks: [chunk1] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ chunks: [chunk2] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const db = mockDb([
      makePeer({ id: 'peer-1', name: 'Laptop' }),
      makePeer({ id: 'peer-2', name: 'Desktop' }),
    ]);

    const result = await retrieveFromMesh({
      db,
      workspaceId: 'local',
      query: 'test',
    });

    // Should only have 1 chunk (deduped)
    expect(result.chunks).toHaveLength(1);
  });

  it('handles peer timeout gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const db = mockDb([makePeer()]);
    const result = await retrieveFromMesh({
      db,
      workspaceId: 'local',
      query: 'test',
      timeout: 100,
    });

    expect(result.chunks).toEqual([]);
    expect(result.peerSources).toEqual([]);
  });

  it('handles peer returning error response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );

    const db = mockDb([makePeer()]);
    const result = await retrieveFromMesh({
      db,
      workspaceId: 'local',
      query: 'test',
    });

    expect(result.chunks).toEqual([]);
    expect(result.peerSources).toEqual([]);
  });

  it('limits to maxPeers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ chunks: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const peers = [
      makePeer({ id: 'p1', name: 'A', knowledge_chunk_count: 100 }),
      makePeer({ id: 'p2', name: 'B', knowledge_chunk_count: 50 }),
      makePeer({ id: 'p3', name: 'C', knowledge_chunk_count: 25 }),
      makePeer({ id: 'p4', name: 'D', knowledge_chunk_count: 10 }),
    ];

    const db = mockDb(peers);
    await retrieveFromMesh({
      db,
      workspaceId: 'local',
      query: 'test',
      maxPeers: 2,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
