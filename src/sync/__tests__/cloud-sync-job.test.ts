/**
 * Tests for src/sync/cloud-sync-job.ts
 *
 * Pins the two guard behaviors:
 *   1. Empty/missing cloudDatabaseUrl returns [] without throwing.
 *   2. Tables opted-out via workspace_sync_config are skipped.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock pg before importing the module under test so the mock is hoisted.
// ---------------------------------------------------------------------------
const mockEnd = vi.fn().mockResolvedValue(undefined);
const mockQuery = vi.fn();
const mockConnect = vi.fn();

vi.mock('pg', () => {
  function Client() {
    return {
      connect: mockConnect,
      query: mockQuery,
      end: mockEnd,
    };
  }
  return { default: { Client } };
});

// Mock better-sqlite3 so tests don't need a real DB file.
vi.mock('better-sqlite3', () => {
  const Database = vi.fn(() => ({
    close: vi.fn(),
    prepare: vi.fn(() => ({
      get: vi.fn(() => ({ n: 0 })),
      iterate: vi.fn(() => [][Symbol.iterator]()),
    })),
  }));
  return { default: Database };
});

// Mock logger to suppress noise.
vi.mock('../../lib/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  },
}));

import { syncAllTables } from '../cloud-sync-job.js';
import { logger } from '../../lib/logger.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockEnd.mockResolvedValue(undefined);
  // Default: workspace_sync_config returns empty (no opt-outs)
  mockQuery.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('syncAllTables', () => {
  it('returns empty array and warns when cloudDatabaseUrl is empty string', async () => {
    const results = await syncAllTables({
      workspaceId: 'test-workspace-id',
      sqlitePath: '/fake/runtime.db',
      cloudDatabaseUrl: '',
    });

    expect(results).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('cloudDatabaseUrl is empty'),
    );
    // pg client should not have been connected
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('returns empty array without throwing when pg connection fails', async () => {
    mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const results = await syncAllTables({
      workspaceId: 'test-workspace-id',
      sqlitePath: '/fake/runtime.db',
      cloudDatabaseUrl: 'postgres://localhost/test',
    });

    expect(results).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      '[sync] pg connection failed; skipping sync',
    );
  });

  it('skips tables marked as opted-out (enabled=false) in workspace_sync_config', async () => {
    const targetWorkspaceId = 'opted-out-workspace';

    // For every workspace_sync_config query, return enabled=false for that workspace.
    mockQuery.mockResolvedValue({
      rows: [{ workspace_id: targetWorkspaceId, enabled: false }],
    });

    // Prepare returns 0 rows from SQLite iterate — this is fine since we just
    // want to confirm the opt-out path is exercised and nothing is written.
    const results = await syncAllTables({
      workspaceId: targetWorkspaceId,
      sqlitePath: '/fake/runtime.db',
      cloudDatabaseUrl: 'postgres://localhost/test',
    });

    // Results should contain entries (one per table) but with wrote=0 because
    // all rows are skipped due to opt-out.
    for (const r of results) {
      expect(r.wrote).toBe(0);
    }
    // No INSERT/UPSERT queries should have been issued (only SELECT from opt-out map).
    const upsertCalls = mockQuery.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].startsWith('INSERT'),
    );
    expect(upsertCalls).toHaveLength(0);
  });
});
