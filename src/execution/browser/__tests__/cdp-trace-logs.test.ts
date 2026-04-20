/**
 * Freeze tests: structured cdp:true trace log events.
 *
 * Every instrumented action must emit exactly the expected structured
 * object to logger.info / logger.debug. These tests mock the pino logger
 * at the module boundary and assert the exact fields passed, catching
 * accidental regressions where a structured field is dropped, renamed,
 * or the whole call becomes a free-form string.
 *
 * Files under test (implementation commit 573a107):
 *   - src/execution/browser/browser-claims.ts  (claim / release)
 *   - src/execution/browser/chrome-profile-router.ts (reuse:hit / tab:close)
 *   - src/execution/browser/raw-cdp.ts         (navigate / tab:attach)
 *   - src/orchestrator/tools/social-cdp-helpers.ts (type)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Logger mock — vi.hoisted ensures the variables exist when vi.mock factory runs.
// ---------------------------------------------------------------------------

const { mockInfo, mockDebug, mockWarn } = vi.hoisted(() => ({
  mockInfo: vi.fn(),
  mockDebug: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: mockInfo,
    debug: mockDebug,
    warn: mockWarn,
    error: vi.fn(),
    trace: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mock registration)
// ---------------------------------------------------------------------------

import {
  claimTarget,
  releaseAllForOwner,
  debugSnapshot,
} from '../browser-claims.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetClaims(): void {
  for (const entry of debugSnapshot()) releaseAllForOwner(entry.owner);
}

/** Return every cdp:true call recorded on `mockFn`. */
function cdpCalls(mockFn: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return mockFn.mock.calls
    .filter((args) => args[0] && typeof args[0] === 'object' && (args[0] as Record<string, unknown>).cdp === true)
    .map((args) => args[0] as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// browser-claims.ts — claimTarget emits claim log
// ---------------------------------------------------------------------------

describe('browser-claims: claimTarget emits structured claim log', () => {
  beforeEach(() => {
    resetClaims();
    mockInfo.mockClear();
    mockDebug.mockClear();
  });

  it('emits { cdp: true, action: "claim", profile, targetId, owner } on first claim', () => {
    claimTarget({ profileDir: 'Default', targetId: 'tid-1' }, 'test-owner');

    const claims = cdpCalls(mockInfo).filter((c) => c.action === 'claim');
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      cdp: true,
      action: 'claim',
      profile: 'Default',
      targetId: 'tid-1',
      owner: 'test-owner',
    });
  });

  it('does NOT emit a second claim log when the same owner reclaims (idempotent)', () => {
    claimTarget({ profileDir: 'Default', targetId: 'tid-1' }, 'test-owner');
    mockInfo.mockClear();

    // Reclaim by same owner — should not log again
    claimTarget({ profileDir: 'Default', targetId: 'tid-1' }, 'test-owner');

    const claims = cdpCalls(mockInfo).filter((c) => c.action === 'claim');
    expect(claims).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// browser-claims.ts — release() emits release log
// ---------------------------------------------------------------------------

describe('browser-claims: release() emits structured release log', () => {
  beforeEach(() => {
    resetClaims();
    mockInfo.mockClear();
    mockDebug.mockClear();
  });

  it('emits { cdp: true, action: "release", profile, targetId, owner } on release()', () => {
    const handle = claimTarget({ profileDir: 'Default', targetId: 'tid-2' }, 'owner-a');
    mockInfo.mockClear();

    handle!.release();

    const releases = cdpCalls(mockInfo).filter((c) => c.action === 'release');
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      cdp: true,
      action: 'release',
      profile: 'Default',
      targetId: 'tid-2',
      owner: 'owner-a',
    });
  });

  it('does NOT emit a second release log when release() is called a second time (idempotent)', () => {
    const handle = claimTarget({ profileDir: 'Default', targetId: 'tid-2' }, 'owner-a');
    handle!.release();
    mockInfo.mockClear();

    // Second call — claim is already gone, no log expected
    handle!.release();

    const releases = cdpCalls(mockInfo).filter((c) => c.action === 'release');
    expect(releases).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// browser-claims.ts — releaseAllForOwner emits release log per entry
// ---------------------------------------------------------------------------

describe('browser-claims: releaseAllForOwner emits release log per claim', () => {
  beforeEach(() => {
    resetClaims();
    mockInfo.mockClear();
    mockDebug.mockClear();
  });

  it('emits { cdp: true, action: "release", profile, targetId, owner } for each released claim', () => {
    claimTarget({ profileDir: 'Default', targetId: 'tid-3' }, 'owner-b');
    claimTarget({ profileDir: 'Profile 1', targetId: 'tid-4' }, 'owner-b');
    mockInfo.mockClear();

    releaseAllForOwner('owner-b');

    const releases = cdpCalls(mockInfo).filter((c) => c.action === 'release');
    expect(releases).toHaveLength(2);
    for (const r of releases) {
      expect(r).toMatchObject({
        cdp: true,
        action: 'release',
        owner: 'owner-b',
      });
      expect(typeof r.profile).toBe('string');
      expect(typeof r.targetId).toBe('string');
    }
    // Both original profile/targetId pairs appear in the logs
    const profiles = releases.map((r) => r.profile);
    const targetIds = releases.map((r) => r.targetId);
    expect(profiles).toContain('Default');
    expect(profiles).toContain('Profile 1');
    expect(targetIds).toContain('tid-3');
    expect(targetIds).toContain('tid-4');
  });
});

// ---------------------------------------------------------------------------
// chrome-profile-router.ts — closeTabById emits tab:close log
// ---------------------------------------------------------------------------

// Mock raw-cdp so closeTabById doesn't try to connect to a real Chrome.
vi.mock('../raw-cdp.js', () => ({
  RawCdpBrowser: {
    connect: vi.fn().mockResolvedValue({
      getTargets: vi.fn().mockResolvedValue([]),
      closeTarget: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      on: vi.fn(() => () => {}),
      send: vi.fn().mockResolvedValue({}),
    }),
  },
}));

// Mock chrome-lifecycle so ensureDebugChrome doesn't try to spawn Chrome.
vi.mock('../chrome-lifecycle.js', async () => {
  const actual = await vi.importActual<typeof import('../chrome-lifecycle.js')>('../chrome-lifecycle.js');
  return {
    ...actual,
    ensureDebugChrome: vi.fn().mockResolvedValue(undefined),
    listProfiles: vi.fn().mockReturnValue([]),
    openProfileWindow: vi.fn().mockResolvedValue({ browserContextId: 'ctx-mock' }),
  };
});

import { closeTabById } from '../chrome-profile-router.js';

describe('chrome-profile-router: closeTabById emits structured tab:close log', () => {
  beforeEach(() => {
    mockDebug.mockClear();
    mockInfo.mockClear();
  });

  it('emits { cdp: true, action: "tab:close", targetId } before closing', async () => {
    await closeTabById('target-abc');

    const tabCloseCalls = cdpCalls(mockDebug).filter((c) => c.action === 'tab:close');
    expect(tabCloseCalls).toHaveLength(1);
    expect(tabCloseCalls[0]).toMatchObject({
      cdp: true,
      action: 'tab:close',
      targetId: 'target-abc',
    });
  });
});

// NOTE: raw-cdp.ts (tab:attach / navigate) logs are tested in the separate
// cdp-trace-logs-rawcdp.test.ts file, which does NOT mock the raw-cdp module.
// This file mocks raw-cdp.js for chrome-profile-router tests and cannot also
// exercise the real RawCdpBrowser methods (vi.mock is file-scoped).

// ---------------------------------------------------------------------------
// social-cdp-helpers.ts — typeIntoRichTextbox emits exactly ONE type log
// ---------------------------------------------------------------------------

// We need a RawCdpPage stub that satisfies typeIntoRichTextbox's interface.
// The function uses: page.evaluate, page.pressKey, page.typeText, and
// (page as any).send — and the `send` field directly on the object.

function makeFakePage(targetId = 'fake-page-target'): Record<string, unknown> {
  const fakeSend = vi.fn().mockResolvedValue(undefined);
  return {
    targetId,
    evaluate: vi.fn().mockResolvedValue(0), // always returns 0 chars measured
    pressKey: vi.fn().mockResolvedValue(undefined),
    typeText: vi.fn().mockResolvedValue(undefined),
    send: fakeSend,
  };
}

import { typeIntoRichTextbox } from '../../../orchestrator/tools/social-cdp-helpers.js';

describe('social-cdp-helpers: typeIntoRichTextbox emits exactly one cdp:true type log per call', () => {
  beforeEach(() => {
    mockDebug.mockClear();
    mockInfo.mockClear();
  });

  it('emits { cdp: true, action: "type", len } exactly once for a short string', async () => {
    const page = makeFakePage();
    const text = 'Hello world';

    await typeIntoRichTextbox(page as never, '[contenteditable]', text);

    const typeLogs = cdpCalls(mockDebug).filter((c) => c.action === 'type');
    expect(typeLogs).toHaveLength(1);
    expect(typeLogs[0]).toMatchObject({
      cdp: true,
      action: 'type',
      len: text.length,
    });
  });

  it('emits { cdp: true, action: "type", len } exactly once for a longer string — no per-character spam', async () => {
    const page = makeFakePage();
    // 200-char string to ensure per-char logging would produce 200 calls
    const text = 'a'.repeat(200);

    await typeIntoRichTextbox(page as never, '[contenteditable]', text);

    const typeLogs = cdpCalls(mockDebug).filter((c) => c.action === 'type');
    expect(typeLogs).toHaveLength(1);
    expect(typeLogs[0]).toMatchObject({
      cdp: true,
      action: 'type',
      len: 200,
    });
  });

  it('reports the correct text length in the type log', async () => {
    const page = makeFakePage();
    const text = 'Testing 1 2 3';

    await typeIntoRichTextbox(page as never, '[contenteditable]', text);

    const typeLogs = cdpCalls(mockDebug).filter((c) => c.action === 'type');
    expect(typeLogs[0]?.len).toBe(text.length);
  });
});
