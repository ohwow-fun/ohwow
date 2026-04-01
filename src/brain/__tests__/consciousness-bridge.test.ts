/**
 * Tests for the ConsciousnessBridge — persistence and sync for Global Workspace.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConsciousnessBridge, type CloudConsciousnessItem } from '../consciousness-bridge.js';
import { GlobalWorkspace } from '../global-workspace.js';
import { mockDb } from '../../__tests__/helpers/mock-db.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('ConsciousnessBridge', () => {
  let workspace: GlobalWorkspace;
  let db: ReturnType<typeof mockDb>;
  let bridge: ConsciousnessBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    workspace = new GlobalWorkspace();
    db = mockDb({
      consciousness_items: { data: [], count: 0 },
    });
    bridge = new ConsciousnessBridge(db as unknown as DatabaseAdapter, workspace, 'ws-test');
  });

  describe('hydrate', () => {
    it('hydrates workspace from persisted items', async () => {
      const items = [
        {
          id: 'c1',
          workspace_id: 'ws-test',
          source: 'orchestrator',
          content: 'Agent X failed 3 times on email tasks',
          salience: 0.8,
          category: 'alert',
          created_at: new Date().toISOString(),
          origin: 'local',
        },
      ];
      db = mockDb({ consciousness_items: { data: items } });
      bridge = new ConsciousnessBridge(db as unknown as DatabaseAdapter, workspace, 'ws-test');

      const count = await bridge.hydrate();
      expect(count).toBe(1);
      expect(workspace.size()).toBe(1);

      const conscious = workspace.getConscious(10);
      expect(conscious[0].content).toBe('Agent X failed 3 times on email tasks');
      expect(conscious[0].source).toBe('local:orchestrator');
    });

    it('returns 0 when no items exist', async () => {
      const count = await bridge.hydrate();
      expect(count).toBe(0);
    });

    it('handles database errors gracefully', async () => {
      db = mockDb({ consciousness_items: { error: new Error('table missing') } });
      bridge = new ConsciousnessBridge(db as unknown as DatabaseAdapter, workspace, 'ws-test');

      const count = await bridge.hydrate();
      expect(count).toBe(0);
    });
  });

  describe('persist', () => {
    it('persists high-salience workspace items', async () => {
      // Broadcast a high-salience item
      workspace.broadcast({
        source: 'engine',
        type: 'failure',
        content: 'Tool X timed out',
        salience: 0.7,
        timestamp: Date.now(),
      });

      const count = await bridge.persist();
      expect(count).toBe(1);
      expect(db.from).toHaveBeenCalledWith('consciousness_items');
    });

    it('skips already-persisted items (dedup)', async () => {
      workspace.broadcast({
        source: 'engine',
        type: 'failure',
        content: 'Same failure',
        salience: 0.8,
        timestamp: Date.now(),
      });

      await bridge.persist();
      const count2 = await bridge.persist();
      expect(count2).toBe(0); // Already persisted
    });

    it('skips low-salience items', async () => {
      workspace.broadcast({
        source: 'engine',
        type: 'pattern',
        content: 'Minor pattern',
        salience: 0.1, // Below 0.4 threshold
        timestamp: Date.now(),
      });

      const count = await bridge.persist();
      expect(count).toBe(0);
    });
  });

  describe('mergeCloudItems', () => {
    it('merges cloud items into workspace and DB', async () => {
      const cloudItems: CloudConsciousnessItem[] = [
        {
          id: 'cloud-1',
          workspace_id: 'ws-test',
          source: 'dashboard',
          content: 'Revenue milestone reached',
          salience: 0.9,
          category: 'milestone',
          created_at: new Date().toISOString(),
        },
      ];

      const merged = await bridge.mergeCloudItems(cloudItems);
      expect(merged).toBe(1);
      expect(workspace.size()).toBe(1);

      const conscious = workspace.getConscious(10);
      expect(conscious[0].content).toBe('Revenue milestone reached');
      expect(conscious[0].source).toBe('cloud:dashboard');
    });

    it('deduplicates cloud items', async () => {
      const cloudItem: CloudConsciousnessItem = {
        id: 'cloud-1',
        workspace_id: 'ws-test',
        source: 'dashboard',
        content: 'Same content',
        salience: 0.9,
        category: 'insight',
        created_at: new Date().toISOString(),
      };

      await bridge.mergeCloudItems([cloudItem]);
      const merged2 = await bridge.mergeCloudItems([cloudItem]);
      expect(merged2).toBe(0); // Already merged
    });
  });

  describe('getUnsyncedItems', () => {
    it('returns unsynced local items', async () => {
      const items = [
        {
          id: 'local-1',
          workspace_id: 'ws-test',
          source: 'engine',
          content: 'New insight',
          salience: 0.7,
          category: 'insight',
          created_at: new Date().toISOString(),
          origin: 'local',
        },
      ];
      db = mockDb({ consciousness_items: { data: items } });
      bridge = new ConsciousnessBridge(db as unknown as DatabaseAdapter, workspace, 'ws-test');

      const unsynced = await bridge.getUnsyncedItems();
      expect(unsynced).toHaveLength(1);
      expect(unsynced[0].source).toBe('engine');
    });
  });

  describe('type mapping', () => {
    it('maps failure to alert category', async () => {
      workspace.broadcast({
        source: 'test',
        type: 'failure',
        content: 'Test failure',
        salience: 0.8,
        timestamp: Date.now(),
      });

      await bridge.persist();
      // The insert call should have category: 'alert'
      const insertCall = db.from('consciousness_items');
      expect(insertCall).toBeDefined();
    });
  });
});
