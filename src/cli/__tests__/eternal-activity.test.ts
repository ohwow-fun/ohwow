/**
 * Tests that runEternalCli calls recordActivity for the 'conservative' and
 * 'normal' subcommands, and does NOT call it for 'status'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that resolve these modules.
// ---------------------------------------------------------------------------

const mockRecordActivity = vi.fn().mockResolvedValue(undefined);
const mockSetEternalMode = vi.fn().mockResolvedValue(undefined);
const mockGetEternalState = vi.fn().mockResolvedValue({
  mode: 'normal',
  lastActivityAt: null,
  modeChangedAt: null,
  modeChangedReason: null,
});

vi.mock('../../eternal/index.js', () => ({
  getEternalState: (...args: unknown[]) => mockGetEternalState(...args),
  setEternalMode: (...args: unknown[]) => mockSetEternalMode(...args),
  recordActivity: (...args: unknown[]) => mockRecordActivity(...args),
}));

// Mock db modules so no real filesystem is touched.
const mockDb = {} as Record<string, unknown>;
const mockRawDb = {} as Record<string, unknown>;

vi.mock('../../db/init.js', () => ({
  initDatabase: () => mockRawDb,
}));

vi.mock('../../db/sqlite-adapter.js', () => ({
  createSqliteAdapter: () => mockDb,
}));

vi.mock('../../config.js', () => ({
  loadConfig: () => ({
    dbPath: '/tmp/ohwow-test/eternal-activity.db',
  }),
}));

// Suppress console.log output in tests.
vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { ...actual, dirname: () => '/tmp/ohwow-test' };
});

// Import after mocks.
const { runEternalCli } = await import('../eternal.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// runEternalCli calls process.exit — stub it so tests don't actually exit.
const mockExit = vi
  .spyOn(process, 'exit')
  .mockImplementation((_code?: string | number | null | undefined) => {
    throw new Error('process.exit called');
  });

// Suppress console output.
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runEternalCli — recordActivity wiring', () => {
  it('calls recordActivity after setEternalMode for "conservative"', async () => {
    await expect(runEternalCli(['conservative'])).rejects.toThrow('process.exit called');

    expect(mockSetEternalMode).toHaveBeenCalledWith(mockDb, 'conservative', 'manual: operator CLI');
    expect(mockRecordActivity).toHaveBeenCalledWith(mockDb);
    expect(mockRecordActivity).toHaveBeenCalledTimes(1);
  });

  it('calls recordActivity after setEternalMode for "normal"', async () => {
    await expect(runEternalCli(['normal'])).rejects.toThrow('process.exit called');

    expect(mockSetEternalMode).toHaveBeenCalledWith(mockDb, 'normal', 'manual: operator CLI');
    expect(mockRecordActivity).toHaveBeenCalledWith(mockDb);
    expect(mockRecordActivity).toHaveBeenCalledTimes(1);
  });

  it('does NOT call recordActivity for "status"', async () => {
    await expect(runEternalCli(['status'])).rejects.toThrow('process.exit called');

    expect(mockGetEternalState).toHaveBeenCalledWith(mockDb);
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });
});

// Satisfy TS — mockExit is used to satisfy the import.
void mockExit;
