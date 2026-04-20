/**
 * Freeze the two-pass tab-reuse pattern in tool-executor.ts for X and Threads.
 *
 * The original bug: x_compose_tweet and threads_compose_post called
 * openProfileWindow unconditionally on every invocation, opening a new tab each
 * time instead of reusing an existing x.com / threads.com tab.
 *
 * The fix (SHA 2738323): both X and Threads blocks in executeToolCall now call
 * findReusableTabForHost first and only fall through to openProfileWindow when
 * that returns null.
 *
 * These tests assert:
 *   1. X path: when findReusableTabForHost returns a hit, openProfileWindow NOT called.
 *   2. X path: when findReusableTabForHost returns null, openProfileWindow IS called.
 *   3. Threads path: same two-pass contract for threads_compose_post.
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
  composeThreadViaBrowser: vi.fn(),
  composeArticleViaBrowser: vi.fn(),
  sendDmViaBrowser: vi.fn(),
  listDmsViaBrowser: vi.fn(),
  deleteLastTweetViaBrowser: vi.fn(),
}));

const threadsPostingMocks = vi.hoisted(() => ({
  composeThreadsPostViaBrowser: vi.fn(),
  composeThreadsThreadViaBrowser: vi.fn(),
  readThreadsProfileViaBrowser: vi.fn(),
}));

vi.mock('../../execution/browser/chrome-profile-router.js', () => profileRouterMocks);
vi.mock('../../execution/browser/profile-mutex.js', () => profileMutexMocks);
vi.mock('../../execution/browser/chrome-lifecycle.js', () => ({
  ...lifecycleMocks,
  DEBUG_DATA_DIR: '/tmp/fake-chrome-data',
}));
vi.mock('../tools/x-posting.js', () => xPostingMocks);
vi.mock('../tools/threads-posting.js', () => threadsPostingMocks);
vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../execution/browser/browser-tools.js', () => ({
  BROWSER_ACTIVATION_MESSAGE: 'Browser activated.',
  executeBrowserTool: vi.fn(),
  formatBrowserToolResult: vi.fn().mockReturnValue([]),
  isBrowserTool: vi.fn().mockReturnValue(false),
}));
vi.mock('../../mcp/tool-adapter.js', () => ({
  isMcpTool: vi.fn().mockReturnValue(false),
}));
vi.mock('../../execution/browser/screenshot-storage.js', () => ({
  saveScreenshotLocally: vi.fn(),
}));
vi.mock('../../media/storage.js', () => ({
  saveMediaFile: vi.fn(),
  saveMediaFromUrl: vi.fn(),
}));
vi.mock('../../media/media-router.js', () => ({
  estimateMediaCost: vi.fn().mockReturnValue({ credits: 1, description: 'test' }),
}));
vi.mock('../result-summarizer.js', () => ({
  summarizeToolResult: vi.fn().mockImplementation((_name: string, content: string) => content),
}));
vi.mock('../error-recovery.js', () => ({
  retryTransient: vi.fn().mockImplementation((fn: () => unknown) => fn()),
  CircuitBreaker: vi.fn(),
  attemptRecovery: vi.fn().mockResolvedValue({ shouldRetry: false }),
  classifyError: vi.fn().mockReturnValue('unknown'),
}));
vi.mock('../tools/registry.js', () => ({
  toolRegistry: new Map(),
}));
vi.mock('../runtime-tool-registry.js', () => ({
  runtimeToolRegistry: new Map(),
}));

// ── Import after mocks ───────────────────────────────────────────────────────

import { executeToolCall, type ToolCallRequest, type ToolExecutionContext } from '../tool-executor.js';
import type { OrchestratorEvent } from '../orchestrator-types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const FAKE_PROFILE = {
  directory: 'Profile 1',
  email: 'alice@example.com',
  gaiaName: 'Alice',
  localProfileName: 'Alice',
};

function fakeReusableTab(browserContextId = 'ctx-profile-1') {
  return {
    browserContextId,
    targetId: 'tid-existing',
    page: { close: vi.fn() },
    closeBrowser: vi.fn(),
  };
}

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
    }),
    rpc: vi.fn().mockResolvedValue({ data: null }),
  } as never;
}

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    toolCtx: {
      db: makeDb(),
      workspaceId: 'ws-1',
      engine: {} as never,
      channels: {} as never,
      controlPlane: null,
    },
    executedToolCalls: new Map(),
    browserState: { service: null, activated: false, headless: true, dataDir: '' },
    waitForPermission: vi.fn().mockResolvedValue(true),
    addAllowedPath: vi.fn(),
    ...overrides,
  };
}

async function drainGen(gen: AsyncGenerator<OrchestratorEvent, unknown>) {
  const events: OrchestratorEvent[] = [];
  for (;;) {
    const { value, done } = await gen.next();
    if (done) return { events, outcome: value };
    events.push(value as OrchestratorEvent);
  }
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

  profileMutexMocks.withProfileLock.mockImplementation(
    async (_dir: string, fn: () => Promise<unknown>) => fn(),
  );

  lifecycleMocks.profileByHandleHint.mockReturnValue(null);

  xPostingMocks.composeTweetViaBrowser.mockResolvedValue({ success: true, message: 'dry run ok' });
  xPostingMocks.composeThreadViaBrowser.mockResolvedValue({ success: true, message: 'ok' });
  xPostingMocks.composeArticleViaBrowser.mockResolvedValue({ success: true, message: 'ok' });
  xPostingMocks.sendDmViaBrowser.mockResolvedValue({ success: true, message: 'ok' });
  xPostingMocks.listDmsViaBrowser.mockResolvedValue({ success: true, message: 'ok', threads: [] });
  xPostingMocks.deleteLastTweetViaBrowser.mockResolvedValue({ success: true, message: 'ok' });

  threadsPostingMocks.composeThreadsPostViaBrowser.mockResolvedValue({ success: true, message: 'ok' });
  threadsPostingMocks.composeThreadsThreadViaBrowser.mockResolvedValue({ success: true, message: 'ok' });
  threadsPostingMocks.readThreadsProfileViaBrowser.mockResolvedValue({ success: true, message: 'ok' });
});

// ── X posting tab-reuse ──────────────────────────────────────────────────────

describe('tool-executor — X posting tab-reuse (x_compose_tweet)', () => {
  it('does NOT call openProfileWindow when findReusableTabForHost returns a hit', async () => {
    profileRouterMocks.findReusableTabForHost.mockResolvedValue(fakeReusableTab('ctx-profile-1'));

    const request: ToolCallRequest = {
      id: 'call-1',
      name: 'x_compose_tweet',
      input: { text: 'Hello', dry_run: true },
    };
    await drainGen(executeToolCall(request, makeCtx()));

    expect(profileRouterMocks.findReusableTabForHost).toHaveBeenCalledWith(
      expect.objectContaining({ hostMatch: 'x.com' }),
    );
    expect(profileRouterMocks.openProfileWindow).not.toHaveBeenCalled();
  });

  it('calls openProfileWindow when findReusableTabForHost returns null', async () => {
    profileRouterMocks.findReusableTabForHost.mockResolvedValue(null);

    const request: ToolCallRequest = {
      id: 'call-1',
      name: 'x_compose_tweet',
      input: { text: 'Hello', dry_run: true },
    };
    await drainGen(executeToolCall(request, makeCtx()));

    expect(profileRouterMocks.findReusableTabForHost).toHaveBeenCalledWith(
      expect.objectContaining({ hostMatch: 'x.com' }),
    );
    expect(profileRouterMocks.openProfileWindow).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://x.com/home' }),
    );
  });

  it('skips findReusableTabForHost on cold start (no cached browserContextId)', async () => {
    profileRouterMocks.resolveBrowserContextForProfile.mockReturnValue(null);

    const request: ToolCallRequest = {
      id: 'call-1',
      name: 'x_compose_tweet',
      input: { text: 'Hello', dry_run: true },
    };
    await drainGen(executeToolCall(request, makeCtx()));

    expect(profileRouterMocks.findReusableTabForHost).not.toHaveBeenCalled();
    expect(profileRouterMocks.openProfileWindow).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://x.com/home' }),
    );
  });

  it('uses the reused browserContextId as expectedBrowserContextId in the composer call', async () => {
    profileRouterMocks.findReusableTabForHost.mockResolvedValue(fakeReusableTab('ctx-reused'));

    const request: ToolCallRequest = {
      id: 'call-1',
      name: 'x_compose_tweet',
      input: { text: 'Reuse me', dry_run: true },
    };
    await drainGen(executeToolCall(request, makeCtx()));

    expect(xPostingMocks.composeTweetViaBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ expectedBrowserContextId: 'ctx-reused' }),
    );
  });
});

// ── Threads posting tab-reuse ────────────────────────────────────────────────

describe('tool-executor — Threads posting tab-reuse (threads_compose_post)', () => {
  it('does NOT call openProfileWindow when findReusableTabForHost returns a threads.com hit', async () => {
    profileRouterMocks.findReusableTabForHost.mockResolvedValue(fakeReusableTab('ctx-threads'));

    const request: ToolCallRequest = {
      id: 'call-2',
      name: 'threads_compose_post',
      input: { text: 'Threads post', dry_run: true },
    };
    await drainGen(executeToolCall(request, makeCtx()));

    expect(profileRouterMocks.findReusableTabForHost).toHaveBeenCalledWith(
      expect.objectContaining({ hostMatch: 'threads.com' }),
    );
    expect(profileRouterMocks.openProfileWindow).not.toHaveBeenCalled();
  });

  it('calls openProfileWindow when no reusable threads.com tab exists', async () => {
    profileRouterMocks.findReusableTabForHost.mockResolvedValue(null);

    const request: ToolCallRequest = {
      id: 'call-2',
      name: 'threads_compose_post',
      input: { text: 'Threads post', dry_run: true },
    };
    await drainGen(executeToolCall(request, makeCtx()));

    expect(profileRouterMocks.findReusableTabForHost).toHaveBeenCalledWith(
      expect.objectContaining({ hostMatch: 'threads.com' }),
    );
    expect(profileRouterMocks.openProfileWindow).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://www.threads.com/' }),
    );
  });

  it('uses the reused browserContextId as expectedBrowserContextId in the Threads composer call', async () => {
    profileRouterMocks.findReusableTabForHost.mockResolvedValue(fakeReusableTab('ctx-threads-reused'));

    const request: ToolCallRequest = {
      id: 'call-2',
      name: 'threads_compose_post',
      input: { text: 'Threads post', dry_run: true },
    };
    await drainGen(executeToolCall(request, makeCtx()));

    expect(threadsPostingMocks.composeThreadsPostViaBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ expectedBrowserContextId: 'ctx-threads-reused' }),
    );
  });
});
