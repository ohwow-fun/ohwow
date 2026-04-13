import { describe, it, expect } from 'vitest';
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
