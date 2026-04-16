import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Pre-mock every heavy dependency before `connectAndPinCdpPage` is imported.
// chrome-lifecycle spawns real processes; playwright-core dials CDP. Both
// are replaced with deterministic fakes so the test exercises the pin
// + ledger wiring only.

const chromeLifecycleMocks = vi.hoisted(() => ({
  ensureDebugChrome: vi.fn(),
  openProfileWindow: vi.fn(),
  listProfiles: vi.fn(),
  findProfileByIdentity: vi.fn(),
  listChromeWindowTitlesMac: vi.fn(),
  parseWindowTitleSuffix: vi.fn(),
}));

vi.mock('../chrome-lifecycle.js', async () => {
  const actual = await vi.importActual<typeof import('../chrome-lifecycle.js')>(
    '../chrome-lifecycle.js',
  );
  return {
    ...actual,
    ensureDebugChrome: chromeLifecycleMocks.ensureDebugChrome,
    openProfileWindow: chromeLifecycleMocks.openProfileWindow,
    listProfiles: chromeLifecycleMocks.listProfiles,
    findProfileByIdentity: chromeLifecycleMocks.findProfileByIdentity,
    listChromeWindowTitlesMac: chromeLifecycleMocks.listChromeWindowTitlesMac,
    parseWindowTitleSuffix: chromeLifecycleMocks.parseWindowTitleSuffix,
  };
});

// Playwright's connectOverCDP returns a Browser whose contexts/pages we
// fully control. The routing helper reads page titles and URLs; both are
// stubbed to match the profile's localProfileName so title-suffix match
// returns `only-candidate`.
const fakePage = {
  title: vi.fn().mockResolvedValue(''),
  url: vi.fn().mockReturnValue('https://example.com/'),
  goto: vi.fn().mockResolvedValue(undefined),
};
const fakeContext = { pages: () => [fakePage] };
const fakeBrowser = {
  contexts: () => [fakeContext],
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('playwright-core', () => ({
  chromium: {
    connectOverCDP: vi.fn().mockResolvedValue(fakeBrowser),
  },
}));

const TEST_SLUG = `router-test-${Date.now()}`;
const LEDGER_DIR = path.join(os.homedir(), '.ohwow', 'workspaces', TEST_SLUG);
const LEDGER_PATH = path.join(LEDGER_DIR, 'chrome-profile-events.jsonl');

import { _setSlugForTests } from '../chrome-profile-ledger.js';
import { connectAndPinCdpPage } from '../chrome-profile-router.js';

beforeEach(() => {
  try { fs.rmSync(LEDGER_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  _setSlugForTests(TEST_SLUG);

  chromeLifecycleMocks.ensureDebugChrome.mockReset().mockResolvedValue({
    cdpHttpUrl: 'http://localhost:9222',
    cdpWsUrl: 'ws://localhost:9222/devtools',
    pid: 1234,
    profileDirAtLaunch: 'Profile 1',
  });
  chromeLifecycleMocks.openProfileWindow.mockReset().mockResolvedValue({
    targetId: 'target-abc',
    browserContextId: 'ctx-xyz',
  });
  chromeLifecycleMocks.listProfiles.mockReset().mockReturnValue([
    { directory: 'Profile 1', email: 'user@example.com', gaiaName: 'User', localProfileName: 'User' },
    { directory: 'Default', email: null, gaiaName: null, localProfileName: null },
  ]);
  chromeLifecycleMocks.findProfileByIdentity.mockReset().mockImplementation(
    (profiles: Array<{ directory: string; email?: string | null }>, identity: string) =>
      profiles.find((p) => p.directory === identity || p.email === identity) ?? null,
  );
  // Make routeToProfile's macOS window-title correlation find a
  // candidate so the helper can return successfully. One window title
  // "example.com - Google Chrome - User" parses to suffix "User",
  // which matches Profile 1's localProfileName.
  chromeLifecycleMocks.listChromeWindowTitlesMac.mockReset().mockResolvedValue([
    'example.com - Google Chrome - User',
  ]);
  chromeLifecycleMocks.parseWindowTitleSuffix.mockReset().mockImplementation(
    (title: string) => (title.endsWith(' - User') ? 'User' : null),
  );
});

afterEach(() => {
  _setSlugForTests(null);
  try { fs.rmSync(LEDGER_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function readLedger(): Array<Record<string, unknown>> {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  return fs.readFileSync(LEDGER_PATH, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function settleLedger(minEvents = 1, timeoutMs = 1000): Promise<void> {
  // appendChromeProfileEvent is fire-and-forget — it does mkdir + writeFile
  // off the caller's critical path. Poll for the write to land.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readLedger().length >= minEvents) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('connectAndPinCdpPage', () => {
  it('resolves the explicit profile hint, opens a tab on the target URL, and writes a route ledger event', async () => {
    const result = await connectAndPinCdpPage({
      url: 'https://example.com/welcome',
      profile: 'user@example.com',
    });

    expect(chromeLifecycleMocks.ensureDebugChrome).toHaveBeenCalledWith(
      expect.objectContaining({ preferredProfile: 'Profile 1' }),
    );
    expect(chromeLifecycleMocks.openProfileWindow).toHaveBeenCalledWith(
      expect.objectContaining({ profileDir: 'Profile 1', url: 'https://example.com/welcome' }),
    );
    expect(result.profile.directory).toBe('Profile 1');
    expect(result.browserContextId).toBe('ctx-xyz');

    await settleLedger();
    const events = readLedger();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'route',
      expected_profile: 'Profile 1',
      resolved_profile: 'Profile 1',
      mismatch: false,
    });
  });

  it('falls back to the first profile with an email when no hint is provided', async () => {
    await connectAndPinCdpPage({ url: 'https://example.com/a' });

    expect(chromeLifecycleMocks.openProfileWindow).toHaveBeenCalledWith(
      expect.objectContaining({ profileDir: 'Profile 1' }),
    );
    await settleLedger();
    const events = readLedger();
    expect(events[0]).toMatchObject({ source: 'route', expected_profile: 'Profile 1' });
  });

  it('throws DEBUG_DIR_MISSING with actionable message when no profiles exist', async () => {
    chromeLifecycleMocks.listProfiles.mockReturnValueOnce([]);
    await expect(
      connectAndPinCdpPage({ url: 'https://example.com/' }),
    ).rejects.toThrow(/ohwow chrome bootstrap/);
  });
});
