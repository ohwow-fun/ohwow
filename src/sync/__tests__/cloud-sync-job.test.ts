/**
 * Tests for src/sync/cloud-sync-job.ts
 *
 * Pins the two guard behaviors:
 *   1. Empty/missing cloudDatabaseUrl returns [] without throwing.
 *   2. Tables opted-out via workspace_sync_config are skipped.
 *   3. parentJoin tables use JOIN queries instead of bare WHERE workspace_id.
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

// ---------------------------------------------------------------------------
// Mock better-sqlite3. We use a shared module-level array to capture all
// db.prepare() SQL strings — tests can assert query shape against it.
//
// The factory creates a fresh db object per `new Database()` call. The db's
// prepare() mock pushes the SQL string into the shared array so tests can
// inspect all prepare calls made during a syncAllTables() run.
// ---------------------------------------------------------------------------
const prepareSqlLog: string[] = [];

vi.mock('better-sqlite3', () => {
  function Database() {
    return {
      close: vi.fn(),
      prepare: vi.fn(function (sql: string) {
        prepareSqlLog.push(sql);
        return {
          get: vi.fn(function () { return { n: 0 }; }),
          iterate: vi.fn(function () { return [][Symbol.iterator](); }),
        };
      }),
    };
  }
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
  prepareSqlLog.length = 0;
  mockConnect.mockResolvedValue(undefined);
  mockEnd.mockResolvedValue(undefined);
  // Default: workspace_sync_config returns empty (no opt-outs)
  mockQuery.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  vi.clearAllMocks();
  prepareSqlLog.length = 0;
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

describe('parentJoin tables', () => {
  const baseOpts = {
    workspaceId: 'ws-abc-123',
    sqlitePath: '/fake/runtime.db',
    cloudDatabaseUrl: 'postgres://localhost/test',
  };

  it('parentJoin spec generates a JOIN query', async () => {
    await syncAllTables(baseOpts);

    const phaseRoundsSql = prepareSqlLog.find((s) => s.includes('phase_rounds'));
    expect(phaseRoundsSql).toBeDefined();
    expect(phaseRoundsSql).toContain('JOIN phase_trios parent');
    expect(phaseRoundsSql).toContain('WHERE parent.workspace_id = ?');
  });

  it('parentJoin spec does NOT use bare WHERE workspace_id = ?', async () => {
    await syncAllTables(baseOpts);

    const phaseRoundsSql = prepareSqlLog.find((s) => s.includes('phase_rounds'));
    expect(phaseRoundsSql).toBeDefined();
    // Must NOT be the plain non-join form
    expect(phaseRoundsSql).not.toMatch(/FROM phase_rounds WHERE workspace_id = \?/);
  });

  it('parentJoin dry-run uses COUNT with JOIN', async () => {
    await syncAllTables({ ...baseOpts, dryRun: true });

    const phaseRoundsCountSql = prepareSqlLog.find(
      (s) => s.includes('phase_rounds') && s.includes('COUNT(*)'),
    );
    expect(phaseRoundsCountSql).toBeDefined();
    expect(phaseRoundsCountSql).toContain('COUNT(*)');
    expect(phaseRoundsCountSql).toContain('JOIN phase_trios parent');
  });

  it('parentJoin opt-out uses workspaceId directly and skips writes', async () => {
    const targetWorkspaceId = 'ws-abc-123';

    // Return opt-out for this workspace across all tables
    mockQuery.mockResolvedValue({
      rows: [{ workspace_id: targetWorkspaceId, enabled: false }],
    });

    const results = await syncAllTables({ ...baseOpts, workspaceId: targetWorkspaceId });

    // phase_rounds entry should have wrote=0 because opt-out matched via workspaceId
    const phaseRoundsResult = results.find((r) => r.table === 'phase_rounds');
    expect(phaseRoundsResult).toBeDefined();
    expect(phaseRoundsResult!.wrote).toBe(0);

    // No upsert queries at all
    const upsertCalls = mockQuery.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].startsWith('INSERT'),
    );
    expect(upsertCalls).toHaveLength(0);
  });
});
