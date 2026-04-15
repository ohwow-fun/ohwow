/**
 * Chrome Lifecycle — the single place that manages ohwow's debug Chrome.
 *
 * Design principles (derived from a full afternoon of CDP experiments,
 * documented in the session transcript — 2026-04-13):
 *
 *   1. **Never clone, never wipe, never touch profile files.** The debug
 *      Chrome directory at `~/.ohwow/chrome-debug/` is a standalone,
 *      persistent Chrome workspace. Its lifecycle is decoupled from the
 *      user's real Chrome. Runtime code only spawns processes and opens
 *      windows; it never writes, copies, removes, or symlinks profile
 *      data. Bootstrapping (first-time population of the debug dir) is
 *      an explicit, user-initiated CLI action, not something the
 *      daemon ever does on its own.
 *
 *      Before this module, `_ensureDebugProfileDir` in
 *      local-browser.service.ts re-cloned the user's entire real Chrome
 *      data-dir on EVERY `connectToChrome` call. Because real Chrome was
 *      usually still running at clone time, the cloned Preferences +
 *      Local State + Cookies SQLite files captured a mid-write racy
 *      snapshot. When the debug Chrome booted against the clone, its
 *      account reconciler detected the inconsistent state and cleared
 *      Google-sign-in metadata from Preferences (gaia_name, user_name,
 *      account_info) BUT left Cookies SQLite untouched, because cookies
 *      are site data, not Google auth. Result: the profile looked
 *      signed out in the Chrome UI but site sessions (Product Hunt, X,
 *      Reddit, etc) were still live. The exact "signed out but cookies
 *      kept" hybrid state flagged in the field.
 *
 *   2. **Chrome's singleton lock is on `--user-data-dir`.** You cannot
 *      run two Chrome processes against the same data-dir. But you can
 *      ALSO not launch a Chrome with a different `--profile-directory`
 *      argument against an already-running instance to switch profiles:
 *      the args are silently ignored by the running singleton. However,
 *      `open -a "Google Chrome" --args --user-data-dir=<same>
 *      --profile-directory=<OtherProfile>` (without `--remote-debugging
 *      -port`) IS honored — it opens a new window in the other profile
 *      WITHIN the running debug Chrome. That window is visible on the
 *      existing CDP port as a new page target.
 *
 *   3. **CDP aggregates targets from all profile windows.** Playwright's
 *      `browser.contexts()` collapses them into one "default" context
 *      (Chrome profiles are not the same as Playwright BrowserContexts —
 *      the latter are incognito partitions). Identifying which page is
 *      in which profile therefore requires out-of-band correlation.
 *      This module does it two ways:
 *        a) macOS-only: `osascript` window-name list carries a
 *           " - <localProfileName>" suffix per window.
 *        b) Cross-platform: per-page probe via `page.evaluate()`
 *           reading a PH-style avatar or a chrome:// page that reveals
 *           the profile path.
 *      Either suffices; we try (a) first, fall back to (b).
 *
 *   4. **Profile directory → email mapping comes from `Local State`**,
 *      the JSON file at the root of the user-data-dir. Chrome writes
 *      `profile.info_cache` there with one entry per profile, keyed on
 *      the directory name. Reading it is O(1) compared to walking each
 *      profile's Preferences file. This is also the authoritative
 *      source Chrome's own profile picker uses when it populates
 *      `mainView.profilesList_` at chrome://profile-picker/.
 *
 *   5. **Runtime errors loudly on missing debug dir.** If
 *      `~/.ohwow/chrome-debug/` doesn't exist, we do not attempt to
 *      create or populate it — that's bootstrap's job. We throw a
 *      `ChromeLifecycleError` with `code: 'DEBUG_DIR_MISSING'` and an
 *      actionable message pointing at the bootstrap command. This
 *      keeps failure modes explicit instead of silently triggering a
 *      destructive copy.
 *
 * Out of scope (deferred to a separate CLI):
 *
 *   - Bootstrapping the debug dir from real Chrome. A future
 *     `ohwow chrome bootstrap` command will handle that explicitly:
 *     quit real Chrome, copy or symlink selected profiles, reconcile
 *     state, and tell the user what happened. Runtime never runs this.
 *   - Re-seeding individual profiles after Chrome version upgrades.
 *     Also bootstrap-tier.
 *   - Windows / Linux spawning paths (documented but not heavily
 *     tested here; the ohwow daemon's primary target is macOS).
 */

import { exec, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../../lib/logger.js';
import { RawCdpBrowser } from './raw-cdp.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEBUG_DATA_DIR = join(homedir(), '.ohwow', 'chrome-debug');
export const DEFAULT_CDP_PORT = 9222;

const CHROME_BIN_DARWIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_BIN_WIN32 = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CHROME_BIN_LINUX = 'google-chrome';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ChromeLifecycleErrorCode =
  | 'DEBUG_DIR_MISSING'
  | 'DEBUG_DIR_CORRUPTED'
  | 'DEBUG_CHROME_SPAWN_FAILED'
  | 'DEBUG_CHROME_CDP_TIMEOUT'
  | 'DEBUG_CHROME_WRONG_DATA_DIR'
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_WINDOW_TIMEOUT'
  | 'CONSENT_PENDING';

export class ChromeLifecycleError extends Error {
  constructor(
    public readonly code: ChromeLifecycleErrorCode,
    message: string,
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ChromeLifecycleError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProfileInfo {
  /** Profile directory name relative to the data-dir root (e.g. "Profile 2", "Default"). */
  directory: string;
  /** Absolute path to the profile directory. */
  path: string;
  /** Email address of the signed-in Google account, or null if the profile has no Google sign-in. */
  email: string | null;
  /** Full display name from Google account (gaia_given_name + gaia_name), or null. */
  gaiaName: string | null;
  /** Chrome's local profile display name, shown in the profile switcher. */
  localProfileName: string | null;
}

export interface DebugChromeHandle {
  cdpHttpUrl: string;
  cdpWsUrl: string;
  pid: number;
  profileDirAtLaunch: string;
}

/**
 * Diagnostic snapshot of the debug Chrome setup. Returned by
 * `describeDebugChromeState()` for fallback-message generation in the
 * orchestrator and for the bootstrap CLI's pre-flight check. Pure
 * filesystem inspection — does not spawn or query CDP.
 */
export type DebugChromeState =
  | {
      status: 'missing';
      reason: string;
      bootstrapHint: string;
    }
  | {
      status: 'corrupted';
      reason: string;
      bootstrapHint: string;
      detectedIssues: string[];
    }
  | {
      status: 'ready';
      profileCount: number;
      profiles: ProfileInfo[];
    };

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable)
// ---------------------------------------------------------------------------

/**
 * Raw shape of a single profile entry inside Chrome's Local State JSON.
 * Only the fields we care about are declared; Chrome writes many more
 * (avatar_icon, background_apps, hosted_domain, etc) that we don't need.
 */
interface LocalStateProfileEntry {
  user_name?: string;
  gaia_name?: string;
  gaia_given_name?: string;
  name?: string;
}

/**
 * Parse Chrome's Local State JSON into a list of profile info entries.
 * Exported for unit testing with canned inputs.
 */
export function parseLocalState(raw: string, dataDir: string): ProfileInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const profile = (parsed as { profile?: unknown }).profile;
  if (!profile || typeof profile !== 'object') return [];
  const cache = (profile as { info_cache?: unknown }).info_cache;
  if (!cache || typeof cache !== 'object') return [];

  const out: ProfileInfo[] = [];
  for (const [dir, rawEntry] of Object.entries(cache as Record<string, unknown>)) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const entry = rawEntry as LocalStateProfileEntry;
    out.push({
      directory: dir,
      path: join(dataDir, dir),
      email: typeof entry.user_name === 'string' && entry.user_name ? entry.user_name : null,
      gaiaName:
        (typeof entry.gaia_given_name === 'string' && entry.gaia_given_name) ||
        (typeof entry.gaia_name === 'string' && entry.gaia_name) ||
        null,
      localProfileName: typeof entry.name === 'string' ? entry.name : null,
    });
  }
  return out;
}

/**
 * Match window-title-suffix patterns. macOS Chrome appends
 * ` - <localProfileName>` to every window's title when multiple
 * profiles are present in a single Chrome instance. The pattern
 * is reliable enough that we can use it to correlate osascript-
 * reported windows back to profile directories.
 *
 * Input: a title string like "Products - Pinned - Google Chrome - Alice".
 * Output: the profile suffix ("Alice") or null if no suffix detected.
 *
 * Exported for unit testing.
 */
export function parseWindowTitleSuffix(title: string): string | null {
  // Chrome format: "<page title> - Google Chrome - <localProfileName>"
  // Pinned windows insert "- Pinned" before "Google Chrome":
  //   "<page title> - Pinned - Google Chrome - <localProfileName>"
  // Unpinned windows without a profile suffix are ambiguous — Chrome
  // only appends the suffix when multiple profiles are running.
  const match = title.match(/ - Google Chrome - (.+?)$/);
  if (!match) return null;
  const suffix = match[1].trim();
  // Guard against false positives where the page title itself ends
  // with "- Google Chrome - X" (extremely unlikely but possible).
  return suffix.length > 0 && suffix.length < 80 ? suffix : null;
}

/**
 * Extract the `--profile-directory=VALUE` argument from a `ps -o
 * command=` output string, tolerating profile names with spaces
 * (e.g. "Profile 1", "Default"). Returns null if the flag isn't
 * present, in which case Chrome is using its default profile.
 * Exported for unit testing.
 */
export function parseProfileDirectoryArg(psCommand: string): string | null {
  // Profile names can contain spaces, so greedy-match up to the next
  // ` --` flag boundary or end-of-line. The trim strips trailing
  // whitespace that might bleed in from the boundary.
  const match = psCommand.match(/--profile-directory=(.+?)(?:\s--|$)/);
  return match ? match[1].trim() : null;
}

/**
 * Extract the `--user-data-dir=VALUE` argument from a `ps -o command=`
 * output string. Used to identify WHICH Chrome instance we're looking
 * at among the many Chrome helper processes on a Mac.
 */
export function parseUserDataDirArg(psCommand: string): string | null {
  const match = psCommand.match(/--user-data-dir=(.+?)(?:\s--|$)/);
  return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Chrome binary path + platform detection
// ---------------------------------------------------------------------------

function chromeBinaryPath(): string {
  switch (process.platform) {
    case 'darwin': return CHROME_BIN_DARWIN;
    case 'win32': return CHROME_BIN_WIN32;
    default: return CHROME_BIN_LINUX;
  }
}

// ---------------------------------------------------------------------------
// Process helpers (shell out to ps / pgrep)
// ---------------------------------------------------------------------------

function execCapture(cmd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    exec(cmd, (err, stdout, stderr) => {
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      });
    });
  });
}

/**
 * Find the main debug Chrome process (the one running with
 * `--user-data-dir=<DEBUG_DATA_DIR>`). Skips helper/renderer
 * subprocesses by filtering out `--type=...` args. Returns null
 * if no debug Chrome is running.
 */
export async function findDebugChromePid(): Promise<number | null> {
  if (process.platform === 'win32') {
    // Windows path intentionally minimal — ohwow's primary target is
    // macOS. On Windows we just probe the CDP port and trust the
    // process; we don't try to enumerate PIDs.
    return null;
  }
  const pgrepCmd = process.platform === 'darwin'
    ? 'pgrep -f "Google Chrome.app/Contents/MacOS/Google Chrome"'
    : 'pgrep -f "google-chrome|/chrome "';
  const { stdout } = await execCapture(pgrepCmd);
  const pids = stdout.trim().split('\n').map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
  for (const pid of pids) {
    const { stdout: psOut } = await execCapture(`ps -o command= -p ${pid}`);
    const cmd = psOut.trim();
    if (!cmd) continue;
    if (/--type=/.test(cmd)) continue; // renderer/helper, skip
    const dataDir = parseUserDataDirArg(cmd);
    if (dataDir === DEBUG_DATA_DIR) return pid;
  }
  return null;
}

/**
 * Read the `--profile-directory` argument that the running debug
 * Chrome was launched with. This tells us which profile is the
 * "home" / default one for new tabs opened via `target.createTarget`;
 * profile windows opened subsequently via `open -a` each get their
 * own profile independent of this value.
 */
export async function getDebugChromeHomeProfile(): Promise<string | null> {
  const pid = await findDebugChromePid();
  if (!pid) return null;
  const { stdout } = await execCapture(`ps -o command= -p ${pid}`);
  return parseProfileDirectoryArg(stdout.trim()) ?? 'Default';
}

// ---------------------------------------------------------------------------
// CDP probe
// ---------------------------------------------------------------------------

interface CdpVersionResponse {
  webSocketDebuggerUrl?: string;
  Browser?: string;
}

export async function probeCdp(port: number): Promise<{ wsUrl: string; browser: string } | null> {
  try {
    const res = await fetch(`http://localhost:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as CdpVersionResponse;
    if (!data.webSocketDebuggerUrl) return null;
    return { wsUrl: data.webSocketDebuggerUrl, browser: data.Browser ?? 'unknown' };
  } catch {
    return null;
  }
}

interface CdpPageTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/**
 * List every CDP page target on the given port. Returns only entries
 * with `type === 'page'`; drops service workers, iframes, background
 * pages, and extension contexts.
 */
export async function listPageTargets(port: number): Promise<CdpPageTarget[]> {
  try {
    const res = await fetch(`http://localhost:${port}/json`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as CdpPageTarget[];
    return data.filter((t) => t.type === 'page');
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Profile enumeration
// ---------------------------------------------------------------------------

/**
 * Shared actionable hint embedded in every DEBUG_DIR_MISSING /
 * DEBUG_DIR_CORRUPTED error message. Tells the user exactly how to
 * recover without forcing them to search the docs.
 */
const BOOTSTRAP_HINT =
  "Run `ohwow chrome bootstrap` once to import your real Chrome profiles into ohwow's debug Chrome. " +
  'The command quits your real Chrome (with confirmation), clonefile-copies the user-data-dir into ' +
  `${DEBUG_DATA_DIR}, and verifies the result. Until then, browser tools fall back to an isolated bundled ` +
  'Chromium with no logged-in sessions.';

/**
 * Pure filesystem inspection of the debug Chrome dir. Runtime callers
 * use this to build actionable fallback messages without trying to
 * spawn Chrome first. Returns a discriminated union the caller can
 * switch on:
 *
 *   - `missing`: `~/.ohwow/chrome-debug/` doesn't exist at all. Fresh
 *     install. Expected state on first boot.
 *   - `corrupted`: dir exists but at least one critical file is
 *     missing or unreadable (Local State, or zero profile directories
 *     underneath). Needs re-bootstrap.
 *   - `ready`: dir exists, Local State parses, at least one profile
 *     directory is present. Runtime can spawn debug Chrome here.
 */
export function describeDebugChromeState(): DebugChromeState {
  if (!existsSync(DEBUG_DATA_DIR)) {
    return {
      status: 'missing',
      reason: `No debug Chrome dir at ${DEBUG_DATA_DIR} yet (fresh install).`,
      bootstrapHint: BOOTSTRAP_HINT,
    };
  }

  const issues: string[] = [];
  const localStatePath = join(DEBUG_DATA_DIR, 'Local State');
  if (!existsSync(localStatePath)) {
    issues.push(`Missing Local State file at ${localStatePath}.`);
  }

  let profiles: ProfileInfo[] = [];
  if (issues.length === 0) {
    try {
      const raw = readFileSync(localStatePath, 'utf8');
      profiles = parseLocalState(raw, DEBUG_DATA_DIR);
    } catch (err) {
      issues.push(`Local State is unreadable or malformed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Verify at least one profile directory physically exists on disk
  // (Local State can list ghost entries pointing at deleted dirs).
  const livingProfiles = profiles.filter((p) => existsSync(p.path));
  if (profiles.length > 0 && livingProfiles.length === 0) {
    issues.push('Local State lists profiles but none of the referenced directories exist on disk.');
  }

  if (livingProfiles.length === 0 && issues.length === 0) {
    issues.push(`No profile directories found under ${DEBUG_DATA_DIR}.`);
  }

  if (issues.length > 0) {
    return {
      status: 'corrupted',
      reason: `Debug Chrome dir at ${DEBUG_DATA_DIR} is present but broken.`,
      bootstrapHint: BOOTSTRAP_HINT,
      detectedIssues: issues,
    };
  }

  return { status: 'ready', profileCount: livingProfiles.length, profiles: livingProfiles };
}

/**
 * List every profile in the debug Chrome data dir, from the Local
 * State `profile.info_cache` map. This is the authoritative source
 * Chrome's own profile picker uses. Throws DEBUG_DIR_MISSING if the
 * debug dir doesn't exist, or DEBUG_DIR_CORRUPTED if it exists but
 * is broken — runtime never auto-creates it.
 */
export function listProfiles(): ProfileInfo[] {
  const state = describeDebugChromeState();
  if (state.status === 'missing') {
    throw new ChromeLifecycleError(
      'DEBUG_DIR_MISSING',
      `${state.reason} ${state.bootstrapHint}`,
      { debugDataDir: DEBUG_DATA_DIR },
    );
  }
  if (state.status === 'corrupted') {
    throw new ChromeLifecycleError(
      'DEBUG_DIR_CORRUPTED',
      `${state.reason} Issues: ${state.detectedIssues.join('; ')}. ${state.bootstrapHint}`,
      { debugDataDir: DEBUG_DATA_DIR, issues: state.detectedIssues },
    );
  }
  return state.profiles;
}

/**
 * Resolve an email, gaia name, or localProfileName to a concrete profile
 * directory name in the debug Chrome. Returns null if no match. Case-
 * insensitive on email comparison. Tries exact email first, then exact
 * local name, then substring on either.
 */
export function findProfileByIdentity(
  profiles: ProfileInfo[],
  identity: string,
): ProfileInfo | null {
  const needle = identity.trim().toLowerCase();
  if (!needle) return null;

  // Exact email match
  const emailExact = profiles.find((p) => p.email?.toLowerCase() === needle);
  if (emailExact) return emailExact;

  // Exact directory match
  const dirExact = profiles.find((p) => p.directory.toLowerCase() === needle);
  if (dirExact) return dirExact;

  // Exact localProfileName match
  const localExact = profiles.find((p) => p.localProfileName?.toLowerCase() === needle);
  if (localExact) return localExact;

  // Substring match on email / gaia / local
  const substr = profiles.find((p) =>
    p.email?.toLowerCase().includes(needle) ||
    p.gaiaName?.toLowerCase().includes(needle) ||
    p.localProfileName?.toLowerCase().includes(needle),
  );
  return substr ?? null;
}

/**
 * Best-effort correlate an X handle to a debug Chrome profile when
 * the operator hasn't pinned one via runtime_settings.x_posting_profile.
 * Heuristics, tried in order:
 *   - handle ↔ email domain: `example_com` → domain `example.com` → profile
 *     with email `*@example.com`. Underscores map to dots.
 *   - handle ↔ localProfileName substring (punctuation stripped).
 *   - handle ↔ email substring.
 * Returns null when no signal is strong enough — caller falls back to
 * the generic "first profile with an email" default.
 *
 * Lives here because it's shared by both the deliverable-executor
 * post_tweet path and the orchestrator tool-executor x_* tools — both
 * need the same "guess the right profile from an X handle" behavior so
 * operators don't have to explicitly set x_posting_profile.
 */
export function profileByHandleHint(
  profiles: ProfileInfo[],
  handle: string,
): ProfileInfo | null {
  const h = handle.replace(/^@/, '').toLowerCase();
  if (!h) return null;
  const normalized = h.replace(/[_.-]/g, '');
  const domainCandidate = h.replace(/_/g, '.');
  const byDomain = profiles.find((p) => p.email?.toLowerCase().endsWith(`@${domainCandidate}`));
  if (byDomain) return byDomain;
  const byLocal = profiles.find((p) => {
    const local = (p.localProfileName || '').toLowerCase().replace(/[_.\s-]/g, '');
    return local && (local.includes(normalized) || normalized.includes(local));
  });
  if (byLocal) return byLocal;
  const byEmail = profiles.find((p) => p.email?.toLowerCase().includes(normalized));
  return byEmail ?? null;
}

// ---------------------------------------------------------------------------
// macOS window-title-to-profile mapping (for target-to-profile correlation)
// ---------------------------------------------------------------------------

/**
 * Ask macOS for the title of every Chrome window via osascript.
 * Returns the raw title list; callers parse profile suffixes with
 * `parseWindowTitleSuffix`. Returns empty array on non-macOS or
 * on any osascript failure.
 */
export async function listChromeWindowTitlesMac(): Promise<string[]> {
  if (process.platform !== 'darwin') return [];
  const cmd = 'osascript -e \'tell application "System Events" to tell process "Google Chrome" to get name of every window\'';
  const { stdout, code } = await execCapture(cmd);
  if (code !== 0) return [];
  // osascript outputs a comma-separated list. Titles themselves can
  // contain commas, so this is lossy — but Chrome window suffixes are
  // always at the END of a title, and the comma delimiter is followed
  // by a space, so split on ", " is good enough in practice.
  return stdout
    .trim()
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Lifecycle operations
// ---------------------------------------------------------------------------

/**
 * Spawn the debug Chrome process against the existing
 * `~/.ohwow/chrome-debug/` directory. Throws DEBUG_DIR_MISSING if
 * the directory doesn't exist (we never auto-create it — bootstrap
 * is a separate user-driven action). Returns after the CDP port is
 * responding or the timeout expires.
 */
async function spawnDebugChrome(opts: {
  port: number;
  preferredProfile: string;
}): Promise<DebugChromeHandle> {
  const state = describeDebugChromeState();
  if (state.status === 'missing') {
    throw new ChromeLifecycleError(
      'DEBUG_DIR_MISSING',
      `${state.reason} ${state.bootstrapHint}`,
      { debugDataDir: DEBUG_DATA_DIR },
    );
  }
  if (state.status === 'corrupted') {
    throw new ChromeLifecycleError(
      'DEBUG_DIR_CORRUPTED',
      `${state.reason} Issues: ${state.detectedIssues.join('; ')}. ${state.bootstrapHint}`,
      { debugDataDir: DEBUG_DATA_DIR, issues: state.detectedIssues },
    );
  }

  const args = [
    `--user-data-dir=${DEBUG_DATA_DIR}`,
    `--profile-directory=${opts.preferredProfile}`,
    `--remote-debugging-port=${opts.port}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  logger.info(
    { port: opts.port, profile: opts.preferredProfile },
    '[chrome-lifecycle] spawning debug Chrome',
  );

  try {
    const child = spawn(chromeBinaryPath(), args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    throw new ChromeLifecycleError(
      'DEBUG_CHROME_SPAWN_FAILED',
      `Failed to spawn Chrome: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Poll CDP for up to 10s. Process alive != port bound.
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const ver = await probeCdp(opts.port);
    if (ver) {
      // Wait a beat for Chrome to finish rendering first-run dialogs.
      await sleep(1000);
      const pid = (await findDebugChromePid()) ?? 0;
      logger.info(
        { port: opts.port, pid, browser: ver.browser },
        '[chrome-lifecycle] debug Chrome ready',
      );
      return {
        cdpHttpUrl: `http://localhost:${opts.port}`,
        cdpWsUrl: ver.wsUrl,
        pid,
        profileDirAtLaunch: opts.preferredProfile,
      };
    }
  }

  throw new ChromeLifecycleError(
    'DEBUG_CHROME_CDP_TIMEOUT',
    `Debug Chrome launched but CDP did not become ready within 10s on port ${opts.port}`,
  );
}

/**
 * Ensure a debug Chrome is running with CDP enabled. If one is
 * already up, return its handle. Otherwise spawn it. Never wipes,
 * clones, or touches profile files. Never quits real Chrome (which
 * runs in its own data-dir and is none of our business).
 */
export async function ensureDebugChrome(opts: {
  port?: number;
  preferredProfile?: string;
} = {}): Promise<DebugChromeHandle> {
  const port = opts.port ?? DEFAULT_CDP_PORT;
  // Spawn-profile resolution order: explicit arg > OHWOW_CHROME_PROFILE
  // env (daemon-wide default, set from config at boot) > 'Default'.
  // Restarts used to land on 'Default' (which on most machines is a
  // different Google account than the one logged into the workspace's
  // target sites), so the x-intel + dm-to-code scripts would attach to
  // a Chrome that wasn't signed in to x.com. The env knob fixes that
  // without forcing every call site to thread a profile through.
  const preferredProfile = opts.preferredProfile
    ?? (process.env.OHWOW_CHROME_PROFILE || 'Default');

  // Fast path: debug Chrome already on port.
  const existing = await probeCdp(port);
  if (existing) {
    const pid = (await findDebugChromePid()) ?? 0;
    // Verify the running Chrome is actually OUR debug Chrome, not some
    // other random Chrome that happened to be on this port. We check
    // by comparing its --user-data-dir arg.
    if (pid > 0) {
      const { stdout: psOut } = await execCapture(`ps -o command= -p ${pid}`);
      const dataDir = parseUserDataDirArg(psOut.trim());
      if (dataDir && dataDir !== DEBUG_DATA_DIR) {
        throw new ChromeLifecycleError(
          'DEBUG_CHROME_WRONG_DATA_DIR',
          `Something is running on CDP port ${port} with --user-data-dir=${dataDir}, but ohwow expects ${DEBUG_DATA_DIR}. Refusing to attach.`,
          { port, foundDataDir: dataDir, expectedDataDir: DEBUG_DATA_DIR },
        );
      }
    }
    const homeProfile = await getDebugChromeHomeProfile();
    logger.info(
      { port, pid, homeProfile },
      '[chrome-lifecycle] attaching to existing debug Chrome',
    );
    return {
      cdpHttpUrl: `http://localhost:${port}`,
      cdpWsUrl: existing.wsUrl,
      pid,
      profileDirAtLaunch: homeProfile ?? 'Default',
    };
  }

  // No Chrome on the port. Spawn one.
  return spawnDebugChrome({ port, preferredProfile });
}

/**
 * Open a new window in the given profile directory WITHIN the running
 * debug Chrome. Uses `open -a "Google Chrome" --args ...` which Chrome's
 * singleton handler interprets as "open a new window in that profile"
 * (the --user-data-dir must match the running instance; if it does,
 * Chrome honors the --profile-directory arg without respawning).
 *
 * This is the experimentally-verified path — confirmed on 2026-04-13
 * via `osascript` listing two windows with different profile suffixes
 * (`- Alice` and `- example.com`) after a single `open -a` call against
 * a running debug Chrome on port 9222.
 *
 * Waits for a new page target to appear in the CDP target list before
 * returning, so callers can immediately reach for it.
 */
export interface OpenProfileWindowResult {
  /** The new page target's id (same shape listPageTargets returns). */
  targetId: string;
  /**
   * CDP `browserContextId` of the new target. In a multi-profile debug
   * Chrome each profile maps to its own browserContextId, so this value
   * is the only reliable per-profile handle — URL heuristics break when
   * two profiles both have x.com / twitter.com / etc. open. Null when
   * the raw-CDP probe failed (rare; callers must fall back to URL-only
   * routing in that case).
   */
  browserContextId: string | null;
}

export async function openProfileWindow(opts: {
  profileDir: string;
  port?: number;
  timeoutMs?: number;
  /**
   * Optional URL to open as a new tab in the target profile. Without
   * a URL the invocation just focuses the profile's existing window
   * (if any) and no new CDP page target appears, so the "poll for a
   * new target" step times out. Passing a URL makes the invocation
   * always create a fresh tab — we get a detectable new target and
   * we get one whose URL we chose (useful for routing to x.com/home
   * in the right profile in one shot).
   */
  url?: string;
}): Promise<OpenProfileWindowResult> {
  const port = opts.port ?? DEFAULT_CDP_PORT;
  const timeoutMs = opts.timeoutMs ?? 8000;

  if (process.platform !== 'darwin') {
    throw new ChromeLifecycleError(
      'PROFILE_WINDOW_TIMEOUT',
      'openProfileWindow is macOS-only today (Windows/Linux support is a follow-up).',
    );
  }

  // Snapshot the CURRENT page targets so we can detect the new one.
  const beforeIds = new Set((await listPageTargets(port)).map((t) => t.id));
  logger.debug(
    { profileDir: opts.profileDir, beforeCount: beforeIds.size, url: opts.url },
    '[chrome-lifecycle] opening profile window',
  );

  // IMPORTANT: invoke the Chrome binary DIRECTLY rather than via
  // `open -a "Google Chrome" --args ...`. With two Chrome instances
  // running on the host (the user's real Chrome + ohwow's debug
  // Chrome under DEBUG_DATA_DIR), `open -a` routes to whichever
  // Chrome app is frontmost — almost always the real one — so the
  // `--profile-directory` flag never reaches debug Chrome and no new
  // CDP target appears on :9222. Direct-binary invocation uses
  // Chromium's SingletonLock protocol: the freshly-spawned Chrome
  // sees that DEBUG_DATA_DIR is already in use by the debug process,
  // signals that process to open the requested profile + URL, and
  // exits immediately (stdout: "Opening in existing browser session.").
  // Verified 2026-04-15: this produces a new page target in a
  // distinct browserContextId (= the target profile's identity).
  const bin = chromeBinaryPath();
  const args = [
    `--user-data-dir=${DEBUG_DATA_DIR}`,
    `--profile-directory=${opts.profileDir}`,
  ];
  if (opts.url) args.push(opts.url);
  const cmd = [bin, ...args].map((a) => JSON.stringify(a)).join(' ');
  const { code, stderr } = await execCapture(cmd);
  if (code !== 0) {
    throw new ChromeLifecycleError(
      'PROFILE_WINDOW_TIMEOUT',
      `Chrome profile open failed: ${stderr.slice(0, 200) || 'unknown error'}`,
    );
  }

  // Poll for a new page target to appear. Chrome often opens a blank
  // `chrome://newtab/` page in the new window; that's enough to
  // confirm the window exists.
  const startedAt = Date.now();
  let newOne: { id: string; url: string } | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(300);
    const now = await listPageTargets(port);
    newOne = now.find((t) => !beforeIds.has(t.id));
    if (newOne) break;
  }

  if (!newOne) {
    throw new ChromeLifecycleError(
      'PROFILE_WINDOW_TIMEOUT',
      `Opened profile window for "${opts.profileDir}" but no new CDP target appeared within ${timeoutMs}ms. The window may be in a profile that Chrome refuses to open (e.g., managed profile without consent), or open -a silently failed.`,
    );
  }

  // Resolve the new target's browserContextId via raw CDP. The HTTP
  // /json endpoint doesn't expose browserContextId — we need the
  // Target.getTargets RPC. One-shot connection, closed immediately.
  // Failure here is soft: callers still get a usable targetId and can
  // fall back to URL-based routing.
  let browserContextId: string | null = null;
  try {
    const browser = await RawCdpBrowser.connect(`http://localhost:${port}`, 5000);
    try {
      const targets = await browser.getTargets();
      const match = targets.find((t) => t.targetId === newOne!.id);
      browserContextId = match?.browserContextId ?? null;
    } finally {
      browser.close();
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, targetId: newOne.id.slice(0, 8) },
      '[chrome-lifecycle] could not resolve browserContextId for new profile window',
    );
  }

  logger.info(
    { profileDir: opts.profileDir, targetId: newOne.id.slice(0, 8), ctx: browserContextId?.slice(0, 8), url: newOne.url },
    '[chrome-lifecycle] profile window opened',
  );
  return { targetId: newOne.id, browserContextId };
}

/**
 * Quit the debug Chrome we launched. Uses the PID so we can be
 * certain we're not touching the user's real Chrome. This is an
 * explicit action — runtime code should rarely call this. Used by
 * CLI reset commands and tests.
 */
export async function quitDebugChrome(): Promise<void> {
  const pid = await findDebugChromePid();
  if (!pid) {
    logger.debug('[chrome-lifecycle] quitDebugChrome: no debug Chrome running');
    return;
  }
  await execCapture(`kill -TERM ${pid}`);
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const stillRunning = await findDebugChromePid();
    if (!stillRunning) {
      logger.info({ pid }, '[chrome-lifecycle] debug Chrome quit');
      return;
    }
  }
  // Force kill if graceful didn't work.
  const remaining = await findDebugChromePid();
  if (remaining) {
    await execCapture(`kill -KILL ${remaining}`);
    await sleep(500);
  }
}

// ---------------------------------------------------------------------------
// Consent detection
// ---------------------------------------------------------------------------

/**
 * Chrome 147 shows a "managed user profile notice" when a Google-
 * signed-in profile is launched from a non-default user-data-dir.
 * Until the user clicks "Continue", Chrome refuses to load auth
 * cookies from the profile. Throw actionable CONSENT_PENDING if we
 * detect that dialog in the target list.
 *
 * Unchanged from the old LocalBrowserService version — this is
 * orthogonal to the clone bug and still a valid guard.
 */
export async function assertNoConsentPending(port: number): Promise<void> {
  try {
    const res = await fetch(`http://localhost:${port}/json/list`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return;
    const tabs = (await res.json()) as Array<{ url?: string; type?: string }>;
    const hasNotice = tabs.some(
      (t) => typeof t.url === 'string' && t.url.startsWith('chrome://managed-user-profile-notice'),
    );
    if (hasNotice) {
      throw new ChromeLifecycleError(
        'CONSENT_PENDING',
        'Chrome is showing a managed-profile consent dialog. Switch to the Chrome window with "Your organization will be able to view some information" and click Continue, then retry.',
      );
    }
  } catch (err) {
    if (err instanceof ChromeLifecycleError) throw err;
    // Unrelated fetch failure: swallow.
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
