/**
 * Freeze the two-pass tab-reuse pattern in deliverable-executor.ts.
 *
 * The original bug: ensureProfileChrome and ensureThreadsProfileChrome
 * called openProfileWindow unconditionally on every fire, causing a new
 * Chrome window/tab to appear for every cadence tick.
 *
 * The fix (SHA 2738323): both helpers now call findReusableTabForHost
 * first and only fall through to openProfileWindow when that returns null.
 *
 * These tests assert:
 *   1. When findReusableTabForHost returns a hit, openProfileWindow is NOT called.
 *   2. When findReusableTabForHost returns null, openProfileWindow IS called.
 *   3. Both X (ensureProfileChrome) and Threads (ensureThreadsProfileChrome) paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const profileRouterMocks = vi.hoisted(() => ({
  ensureDebugChrome: vi.fn(),
  openProfileWindow: vi.fn(),
  listProfiles: vi.fn(),
  findProfileByIdentity: vi.fn(),
  findReusableTabForHost: vi.fn(),
  resolveBrowserContextForProfile: vi.fn(),
}));

const profileMutexMocks = vi.hoisted(() => ({
  withProfileLock: vi.fn(),
}));

const lifecycleMocks = vi.hoisted(() => ({
  profileByHandleHint: vi.fn(),
}));

const xPostingMocks = vi.hoisted(() => ({
  composeTweetViaBrowser: vi.fn(),
  sendDmViaBrowser: vi.fn(),
}));

const threadsPostingMocks = vi.hoisted(() => ({
  composeThreadsPostViaBrowser: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const postedTextLogMocks = vi.hoisted(() => ({
  hasRecentlyPostedText: vi.fn(),
  recordPostedText: vi.fn(),
  hasRecentlyPostedTextForPlatform: vi.fn(),
  recordPostedTextForPlatform: vi.fn(),
}));

vi.mock('../browser/chrome-profile-router.js', () => profileRouterMocks);
vi.mock('../browser/profile-mutex.js', () => profileMutexMocks);
vi.mock('../browser/chrome-lifecycle.js', () => lifecycleMocks);
vi.mock('../../orchestrator/tools/x-posting.js', () => xPostingMocks);
vi.mock('../../orchestrator/tools/threads-posting.js', () => threadsPostingMocks);
vi.mock('../../lib/logger.js', () => loggerMocks);
vi.mock('../../lib/posted-text-log.js', () => postedTextLogMocks);

// ── Import after mocks ───────────────────────────────────────────────────────

import { DeliverableExecutor } from '../deliverable-executor.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const FAKE_PROFILE = {
  directory: 'Profile 1',
  email: 'alice@example.com',
  gaiaName: 'Alice',
  localProfileName: 'Alice',
};

/** A fake reusable tab returned by findReusableTabForHost when one exists. */
function fakeReusableTab(browserContextId = 'ctx-profile-1') {
  return {
    browserContextId,
    targetId: 'tid-existing',
    page: { close: vi.fn() },
    closeBrowser: vi.fn(),
  };
}

/** Minimal DatabaseAdapter stub with runtime_settings key/value lookup. */
function makeDb(settings: Record<string, string> = {}) {
  return {
    from: (_table: string) => ({
      select: (_col: string) => ({
        eq: (_col2: string, key: string) => ({
          maybeSingle: () => Promise.resolve({
            data: settings[key] != null ? { value: settings[key] } : null,
          }),
        }),
      }),
      update: (_patch: unknown) => ({
        eq: () => Promise.resolve({ data: null }),
      }),
    }),
  } as never;
}

/** Build a minimal deliverable row. */
function makeDeliverableRow(provider: 'x' | 'threads', text: string) {
  return {
    id: 'del-1',
    workspace_id: 'ws-1',
    task_id: 'task-1',
    deliverable_type: 'social_post',
    provider,
    content: JSON.stringify({ text }),
    status: 'approved',
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  profileRouterMocks.listProfiles.mockReturnValue([FAKE_PROFILE]);
  profileRouterMocks.findProfileByIdentity.mockReturnValue(null);
  profileRouterMocks.ensureDebugChrome.mockResolvedValue({});
  profileRouterMocks.openProfileWindow.mockResolvedValue({
    targetId: 'tid-new',
    browserContextId: 'ctx-new',
  });
  profileRouterMocks.resolveBrowserContextForProfile.mockReturnValue('ctx-profile-1');
  profileRouterMocks.findReusableTabForHost.mockResolvedValue(null); // default: no reusable tab

  // withProfileLock just immediately invokes the callback
  profileMutexMocks.withProfileLock.mockImplementation(
    async (_dir: string, fn: () => Promise<unknown>) => fn(),
  );

  lifecycleMocks.profileByHandleHint.mockReturnValue(null);

  xPostingMocks.composeTweetViaBrowser.mockResolvedValue({
    success: true,
    message: 'Dry run complete.',
  });
  xPostingMocks.sendDmViaBrowser.mockResolvedValue({ success: true, message: 'ok' });

  threadsPostingMocks.composeThreadsPostViaBrowser.mockResolvedValue({
    success: true,
    message: 'Dry run complete.',
  });

  postedTextLogMocks.hasRecentlyPostedText.mockResolvedValue({ alreadyPosted: false });
  postedTextLogMocks.hasRecentlyPostedTextForPlatform.mockResolvedValue({ alreadyPosted: false });
  postedTextLogMocks.recordPostedText.mockResolvedValue(undefined);
  postedTextLogMocks.recordPostedTextForPlatform.mockResolvedValue(undefined);
});

// ── X posting (ensureProfileChrome) ─────────────────────────────────────────

describe('deliverable-executor — X posting tab-reuse (ensureProfileChrome)', () => {
  it('does NOT open a new tab when findReusableTabForHost returns a hit', async () => {
    // Arrange: findReusableTabForHost finds an existing x.com tab
    profileRouterMocks.findReusableTabForHost.mockResolvedValue(fakeReusableTab('ctx-profile-1'));

    const db = makeDb({ deliverable_executor_live: 'false' });
    const exec = new DeliverableExecutor(db);

    // Stub the DB to return our deliverable row
    (db as never as Record<string, unknown>).from = (table: string) => {
      if (table === 'agent_workforce_deliverables') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: makeDeliverableRow('x', 'Hello world') }) }) }),
          update: () => ({ eq: () => Promise.resolve({ data: null }) }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }),
        update: () => ({ eq: () => Promise.resolve({ data: null }) }),
      };
    };

    await exec.execute('del-1');

    // findReusableTabForHost MUST have been called for x.com
    expect(profileRouterMocks.findReusableTabForHost).toHaveBeenCalledWith(
      expect.objectContaining({ hostMatch: 'x.com' }),
    );
    // openProfileWindow must NOT have been called — reusable tab found
    expect(profileRouterMocks.openProfileWindow).not.toHaveBeenCalled();
  });

  it('opens a new tab when findReusableTabForHost returns null (no reusable tab)', async () => {
    // Arrange: no reusable tab
    profileRouterMocks.findReusableTabForHost.mockResolvedValue(null);

    const db = makeDb({ deliverable_executor_live: 'false' });
    const exec = new DeliverableExecutor(db);

    (db as never as Record<string, unknown>).from = (table: string) => {
      if (table === 'agent_workforce_deliverables') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: makeDeliverableRow('x', 'Hello world') }) }) }),
          update: () => ({ eq: () => Promise.resolve({ data: null }) }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }),
        update: () => ({ eq: () => Promise.resolve({ data: null }) }),
      };
    };

    await exec.execute('del-1');

    // findReusableTabForHost was called first
    expect(profileRouterMocks.findReusableTabForHost).toHaveBeenCalledWith(
      expect.objectContaining({ hostMatch: 'x.com' }),
    );
    // openProfileWindow falls through as second pass
    expect(profileRouterMocks.openProfileWindow).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://x.com/home' }),
    );
  });

  it('skips findReusableTabForHost when resolveBrowserContextForProfile returns null (cold start)', async () => {
    // On cold start, no browserContextId is cached — skip reuse attempt
    profileRouterMocks.resolveBrowserContextForProfile.mockReturnValue(null);

    const db = makeDb({ deliverable_executor_live: 'false' });
    const exec = new DeliverableExecutor(db);

    (db as never as Record<string, unknown>).from = (table: string) => {
      if (table === 'agent_workforce_deliverables') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: makeDeliverableRow('x', 'Cold start') }) }) }),
          update: () => ({ eq: () => Promise.resolve({ data: null }) }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }),
        update: () => ({ eq: () => Promise.resolve({ data: null }) }),
      };
    };

    await exec.execute('del-1');

    // findReusableTabForHost skipped (no expectedBrowserContextId)
    expect(profileRouterMocks.findReusableTabForHost).not.toHaveBeenCalled();
    // openProfileWindow opens a fresh tab — the only path available
    expect(profileRouterMocks.openProfileWindow).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://x.com/home' }),
    );
  });
});

// ── Threads posting (ensureThreadsProfileChrome) ─────────────────────────────

describe('deliverable-executor — Threads posting tab-reuse (ensureThreadsProfileChrome)', () => {
  it('does NOT open a new tab when findReusableTabForHost returns a threads.com hit', async () => {
    profileRouterMocks.findReusableTabForHost.mockResolvedValue(fakeReusableTab('ctx-threads-1'));

    const db = makeDb({ deliverable_executor_live: 'false' });
    const exec = new DeliverableExecutor(db);

    (db as never as Record<string, unknown>).from = (table: string) => {
      if (table === 'agent_workforce_deliverables') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: makeDeliverableRow('threads', 'Thread text') }) }) }),
          update: () => ({ eq: () => Promise.resolve({ data: null }) }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }),
        update: () => ({ eq: () => Promise.resolve({ data: null }) }),
      };
    };

    await exec.execute('del-1');

    expect(profileRouterMocks.findReusableTabForHost).toHaveBeenCalledWith(
      expect.objectContaining({ hostMatch: 'threads.com' }),
    );
    expect(profileRouterMocks.openProfileWindow).not.toHaveBeenCalled();
  });

  it('opens a new tab when no reusable threads.com tab exists', async () => {
    profileRouterMocks.findReusableTabForHost.mockResolvedValue(null);

    const db = makeDb({ deliverable_executor_live: 'false' });
    const exec = new DeliverableExecutor(db);

    (db as never as Record<string, unknown>).from = (table: string) => {
      if (table === 'agent_workforce_deliverables') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: makeDeliverableRow('threads', 'Thread text') }) }) }),
          update: () => ({ eq: () => Promise.resolve({ data: null }) }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }),
        update: () => ({ eq: () => Promise.resolve({ data: null }) }),
      };
    };

    await exec.execute('del-1');

    expect(profileRouterMocks.findReusableTabForHost).toHaveBeenCalledWith(
      expect.objectContaining({ hostMatch: 'threads.com' }),
    );
    expect(profileRouterMocks.openProfileWindow).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://www.threads.com/' }),
    );
  });
});
