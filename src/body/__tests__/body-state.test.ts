/**
 * Tests for the BodyStateService — unified system health reporting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BodyStateService } from '../body-state.js';
import { mockDb } from '../../__tests__/helpers/mock-db.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('BodyStateService', () => {
  let db: ReturnType<typeof mockDb>;
  let service: BodyStateService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = mockDb({
      agent_workforce_agents: { data: [{ id: 'a1', name: 'Writer' }] },
      agent_workforce_tasks: { data: [], count: 0 },
      agent_workforce_agent_memory: { data: [], count: 50 },
    });
    service = new BodyStateService(db as unknown as DatabaseAdapter, 'ws-test');
  });

  describe('getBodyState', () => {
    it('returns a complete body state snapshot', async () => {
      const state = await service.getBodyState();
      expect(state).toBeDefined();
      expect(state.overallHealth).toBeDefined();
      expect(state.organs).toBeInstanceOf(Array);
      expect(state.agentPerformance).toBeInstanceOf(Array);
      expect(state.memory).toBeDefined();
      expect(state.memory.cap).toBe(1000);
      expect(state.pipeline).toBeDefined();
      expect(state.cost).toBeDefined();
      expect(state.timestamp).toBeDefined();
    });

    it('reports healthy when no issues', async () => {
      const state = await service.getBodyState();
      expect(state.overallHealth).toBe('healthy');
    });

    it('reports low memory pressure for small counts', async () => {
      const state = await service.getBodyState();
      expect(state.memory.pressure).toBe('low');
      expect(state.memory.activeCount).toBe(50);
    });
  });

  describe('getProprioceptiveSummary', () => {
    it('returns a non-empty summary string', async () => {
      const summary = await service.getProprioceptiveSummary();
      expect(typeof summary).toBe('string');
      expect(summary).toContain('System health');
    });

    it('includes pipeline info when tasks exist', async () => {
      db = mockDb({
        agent_workforce_agents: { data: [] },
        agent_workforce_tasks: { data: [], count: 3 },
        agent_workforce_agent_memory: { data: [], count: 0 },
      });
      service = new BodyStateService(db as unknown as DatabaseAdapter, 'ws-test');

      const summary = await service.getProprioceptiveSummary();
      expect(summary).toContain('System health');
    });

    it('handles database errors gracefully', async () => {
      db = mockDb({
        agent_workforce_agents: { error: new Error('db error') },
        agent_workforce_tasks: { error: new Error('db error') },
        agent_workforce_agent_memory: { error: new Error('db error') },
      });
      service = new BodyStateService(db as unknown as DatabaseAdapter, 'ws-test');

      const summary = await service.getProprioceptiveSummary();
      expect(typeof summary).toBe('string');
    });
  });

  describe('memory pressure levels', () => {
    it('reports medium pressure above 500', async () => {
      db = mockDb({
        agent_workforce_agents: { data: [] },
        agent_workforce_tasks: { data: [], count: 0 },
        agent_workforce_agent_memory: { data: [], count: 600 },
      });
      service = new BodyStateService(db as unknown as DatabaseAdapter, 'ws-test');

      const state = await service.getBodyState();
      expect(state.memory.pressure).toBe('medium');
    });

    it('reports high pressure at 1000+', async () => {
      db = mockDb({
        agent_workforce_agents: { data: [] },
        agent_workforce_tasks: { data: [], count: 0 },
        agent_workforce_agent_memory: { data: [], count: 1200 },
      });
      service = new BodyStateService(db as unknown as DatabaseAdapter, 'ws-test');

      const state = await service.getBodyState();
      expect(state.memory.pressure).toBe('high');
    });
  });
});
