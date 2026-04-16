import { describe, it, expect, vi, beforeEach } from 'vitest';

const profileRouterMocks = vi.hoisted(() => ({
  ensureDebugChrome: vi.fn(),
  openProfileWindow: vi.fn(),
  listProfiles: vi.fn(),
  findProfileByIdentity: vi.fn(),
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

vi.mock('../../browser/chrome-profile-router.js', () => profileRouterMocks);
vi.mock('../../browser/chrome-lifecycle.js', () => lifecycleMocks);
vi.mock('../../../orchestrator/tools/x-posting.js', () => xPostingMocks);

import { xPostingExecutor } from '../x-posting-executor.js';
import type { ToolExecutionContext } from '../types.js';

function makeCtx(overrides?: {
  xPostingProfile?: string | null;
  xPostingHandle?: string | null;
}): ToolExecutionContext {
  const settings: Record<string, string> = {};
  if (overrides?.xPostingProfile != null) settings.x_posting_profile = overrides.xPostingProfile;
  if (overrides?.xPostingHandle != null) settings.x_posting_handle = overrides.xPostingHandle;
  return {
    taskId: 't',
    agentId: 'a',
    workspaceId: 'ws-1',
    scraplingService: {} as never,
    fileAccessGuard: null,
    mcpClients: null,
    circuitBreaker: {} as never,
    db: {
      from: () => ({
        select: () => ({
          eq: (_col: string, key: string) => ({
            maybeSingle: () => Promise.resolve({
              data: settings[key] != null ? { value: settings[key] } : null,
            }),
          }),
        }),
      }),
    } as never,
    browserService: null,
    browserActivated: false,
    desktopService: null,
    desktopActivated: false,
    docMountManager: null,
    modelRouter: null,
  };
}

beforeEach(() => {
  Object.values(profileRouterMocks).forEach((fn) => fn.mockReset());
  Object.values(lifecycleMocks).forEach((fn) => fn.mockReset());
  Object.values(xPostingMocks).forEach((fn) => fn.mockReset());
  profileRouterMocks.listProfiles.mockReturnValue([
    { directory: 'Profile 1', email: 'alice@example.com', gaiaName: 'User', localProfileName: 'User' },
    { directory: 'Default', email: null, gaiaName: null, localProfileName: null },
  ]);
  profileRouterMocks.findProfileByIdentity.mockImplementation(
    (profiles: Array<{ directory: string; email?: string | null }>, id: string) =>
      profiles.find((p) => p.directory === id || p.email === id) ?? null,
  );
  profileRouterMocks.ensureDebugChrome.mockResolvedValue({
    cdpHttpUrl: 'http://localhost:9222',
    cdpWsUrl: 'ws://localhost:9222',
    pid: 1234,
    profileDirAtLaunch: 'Profile 1',
  });
  profileRouterMocks.openProfileWindow.mockResolvedValue({
    targetId: 'tid',
    browserContextId: 'ctx-profile-1',
  });
});

describe('xPostingExecutor', () => {
  it('claims every x_* tool name and nothing else', () => {
    expect(xPostingExecutor.canHandle('x_compose_tweet')).toBe(true);
    expect(xPostingExecutor.canHandle('x_compose_thread')).toBe(true);
    expect(xPostingExecutor.canHandle('x_compose_article')).toBe(true);
    expect(xPostingExecutor.canHandle('x_send_dm')).toBe(true);
    expect(xPostingExecutor.canHandle('x_list_dms')).toBe(true);
    expect(xPostingExecutor.canHandle('x_delete_tweet')).toBe(true);
    expect(xPostingExecutor.canHandle('browser_navigate')).toBe(false);
    expect(xPostingExecutor.canHandle('get_state')).toBe(false);
  });

  it('pins the runtime_settings.x_posting_profile before calling composeTweetViaBrowser', async () => {
    xPostingMocks.composeTweetViaBrowser.mockResolvedValue({
      success: true,
      message: 'Dry run complete.',
      currentUrl: 'https://x.com/compose/post',
    });
    const res = await xPostingExecutor.execute(
      'x_compose_tweet',
      { text: 'Hello', dry_run: true },
      makeCtx({ xPostingProfile: 'alice@example.com', xPostingHandle: 'example_com' }),
    );
    expect(profileRouterMocks.ensureDebugChrome).toHaveBeenCalledWith({ preferredProfile: 'Profile 1' });
    expect(profileRouterMocks.openProfileWindow).toHaveBeenCalledWith(
      expect.objectContaining({ profileDir: 'Profile 1', url: 'https://x.com/home' }),
    );
    expect(xPostingMocks.composeTweetViaBrowser).toHaveBeenCalledWith({
      text: 'Hello',
      dryRun: true,
      expectedHandle: 'example_com',
      expectedBrowserContextId: 'ctx-profile-1',
    });
    expect(res.is_error).toBeFalsy();
  });

  it('defaults dry_run to TRUE even when the agent omits it', async () => {
    xPostingMocks.composeTweetViaBrowser.mockResolvedValue({ success: true, message: 'ok' });
    await xPostingExecutor.execute(
      'x_compose_tweet',
      { text: 'hi' },
      makeCtx({ xPostingProfile: 'Profile 1' }),
    );
    expect(xPostingMocks.composeTweetViaBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  it('falls back to profileByHandleHint when only x_posting_handle is set', async () => {
    lifecycleMocks.profileByHandleHint.mockReturnValue({
      directory: 'Profile 1', email: 'alice@example.com', gaiaName: null, localProfileName: null,
    });
    xPostingMocks.composeTweetViaBrowser.mockResolvedValue({ success: true, message: 'ok' });
    await xPostingExecutor.execute('x_compose_tweet', { text: 'x' }, makeCtx({ xPostingHandle: 'example_com' }));
    expect(lifecycleMocks.profileByHandleHint).toHaveBeenCalled();
    expect(profileRouterMocks.ensureDebugChrome).toHaveBeenCalledWith({ preferredProfile: 'Profile 1' });
  });

  it('returns is_error=true when no Chrome profiles exist', async () => {
    profileRouterMocks.listProfiles.mockReturnValue([]);
    const res = await xPostingExecutor.execute('x_compose_tweet', { text: 'x' }, makeCtx());
    expect(res.is_error).toBe(true);
    expect(String(res.content)).toContain('No Chrome profiles found');
    expect(profileRouterMocks.ensureDebugChrome).not.toHaveBeenCalled();
  });

  it('wraps composer errors into ToolCallResult instead of throwing', async () => {
    xPostingMocks.composeTweetViaBrowser.mockRejectedValue(new Error('CDP detach'));
    const res = await xPostingExecutor.execute(
      'x_compose_tweet',
      { text: 'x' },
      makeCtx({ xPostingProfile: 'Profile 1' }),
    );
    expect(res.is_error).toBe(true);
    expect(String(res.content)).toContain('CDP detach');
  });

  it('converts a hung composer into a TimeoutError ToolCallResult instead of wedging the task', async () => {
    xPostingMocks.composeTweetViaBrowser.mockImplementation(
      () => new Promise(() => {}),
    );
    vi.useFakeTimers();
    try {
      const promise = xPostingExecutor.execute(
        'x_compose_tweet',
        { text: 'x' },
        makeCtx({ xPostingProfile: 'Profile 1' }),
      );
      await vi.advanceTimersByTimeAsync(95_000);
      const res = await promise;
      expect(res.is_error).toBe(true);
      expect(String(res.content)).toContain('timed out after 90000ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispatches x_compose_thread with tweets array + profile pin', async () => {
    xPostingMocks.composeThreadViaBrowser.mockResolvedValue({
      success: true,
      message: 'Thread posted',
      tweetsTyped: 3,
      tweetsPublished: 3,
    });
    const res = await xPostingExecutor.execute(
      'x_compose_thread',
      { tweets: ['a', 'b', 'c'], dry_run: false },
      makeCtx({ xPostingProfile: 'Profile 1' }),
    );
    expect(xPostingMocks.composeThreadViaBrowser).toHaveBeenCalledWith({
      tweets: ['a', 'b', 'c'],
      dryRun: false,
      expectedBrowserContextId: 'ctx-profile-1',
    });
    expect(res.is_error).toBeFalsy();
  });
});
