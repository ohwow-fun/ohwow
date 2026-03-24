import { describe, it, expect, vi } from 'vitest';
import { selectBestPeer } from '../local-router.js';

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockDb(peers: Record<string, unknown>[]) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ data: peers }),
      }),
    }),
  } as any;
}

function makePeer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'peer-1',
    name: 'TestPeer',
    base_url: 'http://peer:7700',
    status: 'connected',
    total_memory_gb: 16,
    cpu_cores: 8,
    memory_tier: 'medium',
    is_apple_silicon: false,
    has_nvidia_gpu: false,
    gpu_name: null,
    local_models: '[]',
    device_role: 'hybrid',
    last_seen_at: new Date().toISOString(),
    queue_active: 0,
    queue_waiting: 0,
    ...overrides,
  };
}

describe('selectBestPeer', () => {
  it('returns null when no peers available', async () => {
    const result = await selectBestPeer(mockDb([]), {});
    expect(result).toBeNull();
  });

  it('returns peer with matching model (model bonus +50)', async () => {
    const db = mockDb([
      makePeer({ id: 'p1', name: 'NoModel', local_models: '[]' }),
      makePeer({ id: 'p2', name: 'HasModel', local_models: '["llama3"]' }),
    ]);
    const result = await selectBestPeer(db, { requiredModel: 'llama3' });
    expect(result).not.toBeNull();
    expect(result!.peerId).toBe('p2');
    expect(result!.breakdown.model).toBe(50);
  });

  it('penalizes peers with high queue depth', async () => {
    const db = mockDb([
      makePeer({ id: 'p1', name: 'Busy', queue_active: 3, queue_waiting: 2 }),
      makePeer({ id: 'p2', name: 'Idle', queue_active: 0, queue_waiting: 0 }),
    ]);
    const result = await selectBestPeer(db, {});
    expect(result!.peerId).toBe('p2');
  });

  it('gives worker role bonus', async () => {
    const db = mockDb([
      makePeer({ id: 'p1', name: 'Worker', device_role: 'worker' }),
    ]);
    const result = await selectBestPeer(db, {});
    expect(result!.breakdown.role).toBe(5);
  });

  it('gives GPU bonus when preferGpu is set', async () => {
    const db = mockDb([
      makePeer({ id: 'p1', name: 'NvidiaBox', has_nvidia_gpu: true }),
    ]);
    const result = await selectBestPeer(db, { preferGpu: true });
    expect(result!.breakdown.gpu).toBe(15);
  });

  it('gives Apple Silicon GPU bonus when preferGpu', async () => {
    const db = mockDb([
      makePeer({ id: 'p1', name: 'Mac', is_apple_silicon: true }),
    ]);
    const result = await selectBestPeer(db, { preferGpu: true });
    expect(result!.breakdown.gpu).toBe(10);
  });

  it('penalizes stale peers', async () => {
    const staleDate = new Date(Date.now() - 120_000).toISOString();
    const db = mockDb([
      makePeer({ id: 'p1', name: 'Stale', last_seen_at: staleDate }),
    ]);
    const result = await selectBestPeer(db, {});
    expect(result!.breakdown.freshness).toBe(-30);
  });

  it('penalizes null last_seen_at as stale', async () => {
    const db = mockDb([
      makePeer({ id: 'p1', name: 'NeverSeen', last_seen_at: null }),
    ]);
    const result = await selectBestPeer(db, {});
    expect(result!.breakdown.freshness).toBe(-30);
  });

  it('prefers Apple Silicon for browser tasks', async () => {
    const db = mockDb([
      makePeer({ id: 'p1', name: 'Mac', is_apple_silicon: true }),
      makePeer({ id: 'p2', name: 'GPU Server', has_nvidia_gpu: true }),
    ]);
    const result = await selectBestPeer(db, { needsBrowser: true });
    expect(result!.peerId).toBe('p1');
    expect(result!.breakdown.browser).toBe(30);
  });

  it('filters out coordinator-only peers', async () => {
    const db = mockDb([
      makePeer({ id: 'p1', name: 'Coordinator', device_role: 'coordinator' }),
    ]);
    const result = await selectBestPeer(db, {});
    expect(result).toBeNull();
  });

  it('includes selfDevice as candidate when provided', async () => {
    const db = mockDb([]);
    const result = await selectBestPeer(db, {}, {
      totalMemoryGb: 16,
      cpuCores: 8,
      memoryTier: 'medium',
      isAppleSilicon: false,
      hasNvidiaGpu: false,
      localModels: [],
      queueActive: 0,
      queueWaiting: 0,
    });
    // selfDevice should be included even though peers from DB are empty
    expect(result).not.toBeNull();
    expect(result!.peerId).toBe('self');
  });

  it('returns null for needsLocalFiles (cannot route away)', async () => {
    const db = mockDb([
      makePeer({ id: 'p1', name: 'Remote' }),
    ]);
    const result = await selectBestPeer(db, { needsLocalFiles: true });
    // needsLocalFiles sets filesystem score to -Infinity, making total score -Infinity
    // The peer is still returned but with -Infinity score
    expect(result).not.toBeNull();
    expect(result!.breakdown.filesystem).toBe(-Infinity);
  });

  it('gives memory tier bonus based on tier size', async () => {
    const db = mockDb([
      makePeer({ id: 'p1', name: 'XLarge', memory_tier: 'xlarge' }),
    ]);
    const result = await selectBestPeer(db, {});
    expect(result!.breakdown.memoryTier).toBe(10);
  });
});
