import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  findProfileByIdentity,
  parseLocalState,
  parseProfileDirectoryArg,
  parseUserDataDirArg,
  parseWindowTitleSuffix,
  type ProfileInfo,
} from '../chrome-lifecycle.js';

/**
 * Pure-parser tests for chrome-lifecycle. These cover every regex and
 * transform the module depends on so we can refactor internals with
 * confidence. Process-level integration (actually launching Chrome,
 * speaking CDP, etc) is covered by the orchestrator end-to-end path,
 * not here.
 */

describe('parseLocalState', () => {
  const dataDir = '/users/test/.ohwow/chrome-debug';

  it('extracts directory + email + names from the profile.info_cache map', () => {
    const raw = JSON.stringify({
      profile: {
        info_cache: {
          'Profile 2': {
            user_name: 'ing.jesusonoro@gmail.com',
            gaia_name: 'Jesus Oñoro',
            gaia_given_name: 'Jesus',
            name: 'Jesus',
          },
          'Profile 1': {
            user_name: '',
            name: 'ohwow.fun',
          },
        },
      },
    });
    const profiles = parseLocalState(raw, dataDir);
    expect(profiles).toHaveLength(2);

    const p2 = profiles.find((p) => p.directory === 'Profile 2')!;
    expect(p2.email).toBe('ing.jesusonoro@gmail.com');
    expect(p2.gaiaName).toBe('Jesus');
    expect(p2.localProfileName).toBe('Jesus');
    expect(p2.path).toBe(`${dataDir}/Profile 2`);

    // Profile 1 is the "signed out but cookies kept" shape we saw in
    // the field — no Google account, just a local name. Must be
    // represented with email=null (not an empty string).
    const p1 = profiles.find((p) => p.directory === 'Profile 1')!;
    expect(p1.email).toBeNull();
    expect(p1.localProfileName).toBe('ohwow.fun');
  });

  it('prefers gaia_given_name over gaia_name for gaiaName', () => {
    const raw = JSON.stringify({
      profile: {
        info_cache: {
          'Profile 3': {
            user_name: 'dbuidler@aved.ai',
            gaia_given_name: 'Jesus',
            gaia_name: 'Jesus Onoro',
            name: 'aved.ai',
          },
        },
      },
    });
    const profiles = parseLocalState(raw, dataDir);
    expect(profiles[0].gaiaName).toBe('Jesus');
  });

  it('returns [] on unparseable JSON without throwing', () => {
    expect(parseLocalState('not json', dataDir)).toEqual([]);
    expect(parseLocalState('', dataDir)).toEqual([]);
    expect(parseLocalState('{}', dataDir)).toEqual([]);
  });

  it('returns [] when profile.info_cache is missing or wrong type', () => {
    expect(parseLocalState(JSON.stringify({ profile: {} }), dataDir)).toEqual([]);
    expect(parseLocalState(JSON.stringify({ profile: { info_cache: 'oops' } }), dataDir)).toEqual([]);
    expect(parseLocalState(JSON.stringify({ profile: { info_cache: null } }), dataDir)).toEqual([]);
  });
});

describe('parseWindowTitleSuffix', () => {
  it('extracts the profile suffix from a standard Chrome title', () => {
    expect(parseWindowTitleSuffix('Products - Google Chrome - Jesus')).toBe('Jesus');
    expect(parseWindowTitleSuffix("Product Hunt - Google Chrome - ohwow.fun")).toBe('ohwow.fun');
  });

  it('handles the "- Pinned -" inflection before " - Google Chrome -"', () => {
    // Pinned windows add "- Pinned" before the app-name section. The
    // suffix regex matches on the LAST "- Google Chrome - X" so it
    // still picks up the correct suffix.
    expect(
      parseWindowTitleSuffix("Who's using Chrome? - Pinned - Google Chrome - Jesus"),
    ).toBe('Jesus');
  });

  it('returns null when no profile suffix is present', () => {
    expect(parseWindowTitleSuffix('Products - Google Chrome')).toBeNull();
    expect(parseWindowTitleSuffix('just a random string')).toBeNull();
    expect(parseWindowTitleSuffix('')).toBeNull();
  });

  it('rejects suspiciously long suffixes to avoid title-in-title false positives', () => {
    const huge = 'Foo - Google Chrome - ' + 'x'.repeat(100);
    expect(parseWindowTitleSuffix(huge)).toBeNull();
  });
});

describe('parseProfileDirectoryArg', () => {
  it('extracts Profile N from a ps output with profile name containing a space', () => {
    const cmd =
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ' +
      '--user-data-dir=/Users/jesus/.ohwow/chrome-debug ' +
      '--profile-directory=Profile 2 ' +
      '--remote-debugging-port=9222 --no-first-run';
    expect(parseProfileDirectoryArg(cmd)).toBe('Profile 2');
  });

  it('extracts Default when that is the profile', () => {
    const cmd = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/x --profile-directory=Default --remote-debugging-port=9222';
    expect(parseProfileDirectoryArg(cmd)).toBe('Default');
  });

  it('returns null when --profile-directory is not present', () => {
    const cmd = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/x --remote-debugging-port=9222';
    expect(parseProfileDirectoryArg(cmd)).toBeNull();
  });
});

describe('parseUserDataDirArg', () => {
  it('extracts the data dir path from a ps command line', () => {
    const cmd = 'Chrome --user-data-dir=/Users/jesus/.ohwow/chrome-debug --remote-debugging-port=9222';
    expect(parseUserDataDirArg(cmd)).toBe('/Users/jesus/.ohwow/chrome-debug');
  });

  it('returns null when not present', () => {
    expect(parseUserDataDirArg('Chrome --no-first-run')).toBeNull();
  });
});

describe('findProfileByIdentity', () => {
  const fixture: ProfileInfo[] = [
    { directory: 'Profile 1', path: '/x/Profile 1', email: null, gaiaName: null, localProfileName: 'ohwow.fun' },
    { directory: 'Profile 2', path: '/x/Profile 2', email: 'ing.jesusonoro@gmail.com', gaiaName: 'Jesus', localProfileName: 'Jesus' },
    { directory: 'Profile 3', path: '/x/Profile 3', email: 'dbuidler@aved.ai', gaiaName: 'Jesus Onoro', localProfileName: 'aved.ai' },
    { directory: 'Profile 8', path: '/x/Profile 8', email: 'ourpandaworld08@gmail.com', gaiaName: 'Jesus', localProfileName: 'Pandas' },
  ];

  it('matches an exact email (case-insensitive)', () => {
    const match = findProfileByIdentity(fixture, 'ing.jesusonoro@gmail.com');
    expect(match?.directory).toBe('Profile 2');
    expect(findProfileByIdentity(fixture, 'ING.JESUSONORO@GMAIL.COM')?.directory).toBe('Profile 2');
  });

  it('matches an exact directory name', () => {
    expect(findProfileByIdentity(fixture, 'Profile 3')?.directory).toBe('Profile 3');
  });

  it('matches an exact localProfileName', () => {
    expect(findProfileByIdentity(fixture, 'Pandas')?.directory).toBe('Profile 8');
    expect(findProfileByIdentity(fixture, 'ohwow.fun')?.directory).toBe('Profile 1');
  });

  it('falls back to substring match on any identity field', () => {
    // Substring on email.
    expect(findProfileByIdentity(fixture, 'jesusonoro')?.directory).toBe('Profile 2');
    // Substring on localProfileName.
    expect(findProfileByIdentity(fixture, 'panda')?.directory).toBe('Profile 8');
  });

  it('returns null when nothing matches', () => {
    expect(findProfileByIdentity(fixture, 'nope@nothing.com')).toBeNull();
    expect(findProfileByIdentity(fixture, '')).toBeNull();
  });

  it('prefers exact over substring when both would match', () => {
    // "Jesus" is an exact localProfileName on Profile 2 AND substring of
    // "Jesus Onoro" gaiaName on Profile 3. Exact must win.
    expect(findProfileByIdentity(fixture, 'Jesus')?.directory).toBe('Profile 2');
  });
});

/**
 * describeDebugChromeState walks the debug Chrome directory via
 * fs.existsSync + fs.readFileSync. These tests set up a temp dir,
 * monkey-patch the module's DEBUG_DATA_DIR into it via re-import
 * trickery isn't worth it — instead we directly test the pure
 * logic by reading a real temp tree and asserting the shape.
 *
 * Since `describeDebugChromeState` reads the module-level
 * `DEBUG_DATA_DIR` constant directly, we test it indirectly by
 * temporarily symlinking a temp dir at that location when possible,
 * and otherwise cover its individual building blocks (parseLocalState,
 * the profile-path existence check) above. A full integration test
 * lives in the bootstrap CLI smoke test below.
 */

describe('describeDebugChromeState integration (temp dir)', () => {
  let tempRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    // Redirect HOME so the module's join(homedir(), '.ohwow', 'chrome-debug')
    // lands in a temp dir. This works because the module evaluates
    // DEBUG_DATA_DIR at import time — but vitest isolates modules per
    // test file and we import fresh inside each test via dynamic import.
    originalHome = process.env.HOME;
    tempRoot = join(tmpdir(), `ohwow-chrome-lifecycle-test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
    mkdirSync(tempRoot, { recursive: true });
    process.env.HOME = tempRoot;
    // Clear the module cache so DEBUG_DATA_DIR recomputes against the new HOME.
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    vi.resetModules();
  });

  it('reports `missing` when the debug dir does not exist (fresh install)', async () => {
    const { describeDebugChromeState } = await import('../chrome-lifecycle.js');
    const state = describeDebugChromeState();
    expect(state.status).toBe('missing');
    if (state.status === 'missing') {
      expect(state.reason).toMatch(/fresh install/i);
      expect(state.bootstrapHint).toMatch(/ohwow chrome bootstrap/);
    }
  });

  it('reports `corrupted` with an actionable issue list when Local State is missing', async () => {
    const debugDir = join(tempRoot, '.ohwow', 'chrome-debug');
    mkdirSync(debugDir, { recursive: true });
    // No Local State, no profiles. Just an empty dir.
    const { describeDebugChromeState } = await import('../chrome-lifecycle.js');
    const state = describeDebugChromeState();
    expect(state.status).toBe('corrupted');
    if (state.status === 'corrupted') {
      expect(state.detectedIssues.some((i) => i.includes('Local State'))).toBe(true);
      expect(state.bootstrapHint).toMatch(/ohwow chrome bootstrap/);
    }
  });

  it('reports `corrupted` when Local State exists but is unparseable JSON', async () => {
    const debugDir = join(tempRoot, '.ohwow', 'chrome-debug');
    mkdirSync(debugDir, { recursive: true });
    writeFileSync(join(debugDir, 'Local State'), 'not valid json at all');
    const { describeDebugChromeState } = await import('../chrome-lifecycle.js');
    const state = describeDebugChromeState();
    // Empty parseLocalState result → "no profile directories found" issue.
    expect(state.status).toBe('corrupted');
  });

  it('reports `corrupted` when Local State lists ghost profiles pointing at deleted dirs', async () => {
    const debugDir = join(tempRoot, '.ohwow', 'chrome-debug');
    mkdirSync(debugDir, { recursive: true });
    // Local State mentions Profile 99 but the directory doesn't exist.
    writeFileSync(
      join(debugDir, 'Local State'),
      JSON.stringify({
        profile: {
          info_cache: {
            'Profile 99': { user_name: 'ghost@gone.com', name: 'Ghost' },
          },
        },
      }),
    );
    const { describeDebugChromeState } = await import('../chrome-lifecycle.js');
    const state = describeDebugChromeState();
    expect(state.status).toBe('corrupted');
    if (state.status === 'corrupted') {
      expect(state.detectedIssues.some((i) => i.toLowerCase().includes('disk'))).toBe(true);
    }
  });

  it('reports `ready` with the right profile count when the dir is fully set up', async () => {
    const debugDir = join(tempRoot, '.ohwow', 'chrome-debug');
    mkdirSync(debugDir, { recursive: true });
    // Create Profile 1 and Profile 2 directories so the existence
    // check passes.
    mkdirSync(join(debugDir, 'Profile 1'), { recursive: true });
    mkdirSync(join(debugDir, 'Profile 2'), { recursive: true });
    writeFileSync(
      join(debugDir, 'Local State'),
      JSON.stringify({
        profile: {
          info_cache: {
            'Profile 1': { user_name: '', name: 'ohwow.fun' },
            'Profile 2': { user_name: 'ing.jesusonoro@gmail.com', name: 'Jesus' },
          },
        },
      }),
    );
    const { describeDebugChromeState } = await import('../chrome-lifecycle.js');
    const state = describeDebugChromeState();
    expect(state.status).toBe('ready');
    if (state.status === 'ready') {
      expect(state.profileCount).toBe(2);
      expect(state.profiles.find((p) => p.directory === 'Profile 2')?.email).toBe('ing.jesusonoro@gmail.com');
    }
  });

  it('listProfiles throws DEBUG_DIR_MISSING with a bootstrap hint on fresh install', async () => {
    const { listProfiles, ChromeLifecycleError } = await import('../chrome-lifecycle.js');
    try {
      listProfiles();
      expect.fail('listProfiles should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ChromeLifecycleError);
      if (err instanceof ChromeLifecycleError) {
        expect(err.code).toBe('DEBUG_DIR_MISSING');
        expect(err.message).toMatch(/ohwow chrome bootstrap/);
      }
    }
  });
});
