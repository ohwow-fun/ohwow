/**
 * Chrome profile resolver.
 *
 * Takes a user-facing profile identifier — directory name, email,
 * display name, or config alias — and resolves it to a concrete
 * Chrome profile directory name (e.g. "Profile 1") that
 * `desktop_focus_app` can pass as `--profile-directory`.
 *
 * Resolution order:
 *   1. Exact directory name match (e.g. "Profile 1", "Default")
 *   2. Config alias lookup (e.g. `ogsus@ohwow.fun` → "Profile 1")
 *   3. account_info email exact match (Chrome-signed-in Google accounts)
 *   4. account_info email domain match
 *   5. profile.name or gaia_name case-insensitive substring match
 *
 * Step 2 is how we handle custom-domain emails like `ogsus@ohwow.fun`
 * that aren't Google accounts and therefore never land in Chrome's
 * account_info. The user tells the daemon once "this email lives in
 * Profile 1" and the tool works forever.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface ChromeProfileInfo {
  directory: string;
  name: string;
  email: string;
  emails: string[];
}

/**
 * Walk ~/Library/Application Support/Google/Chrome and enumerate every
 * profile's identifying metadata. Reads Preferences JSON only — no
 * Cookies DB, no lock contention with a running Chrome.
 */
export function discoverChromeProfiles(): ChromeProfileInfo[] {
  const chromeDir = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  if (!existsSync(chromeDir)) return [];
  const profiles: ChromeProfileInfo[] = [];
  for (const entry of readdirSync(chromeDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== 'Default' && !entry.name.startsWith('Profile ')) continue;
    const prefsPath = join(chromeDir, entry.name, 'Preferences');
    if (!existsSync(prefsPath)) continue;
    try {
      const prefs = JSON.parse(readFileSync(prefsPath, 'utf-8')) as {
        profile?: { name?: string; gaia_name?: string };
        account_info?: Array<{ email?: string }>;
      };
      const name = prefs.profile?.name || entry.name;
      const accounts = prefs.account_info ?? [];
      const emails = accounts.map((a) => a.email ?? '').filter(Boolean);
      profiles.push({
        directory: entry.name,
        name,
        email: emails[0] ?? '',
        emails,
      });
    } catch {
      // skip corrupt profiles
    }
  }
  return profiles;
}

/**
 * Resolve a user-facing identifier to a concrete Chrome profile
 * directory. Returns null when no profile matches — callers should
 * surface a clear error listing available options rather than guessing.
 */
export function resolveChromeProfile(
  identifier: string,
  opts: {
    profiles?: ChromeProfileInfo[];
    aliases?: Record<string, string>;
  } = {},
): string | null {
  if (!identifier) return null;
  const profiles = opts.profiles ?? discoverChromeProfiles();
  const aliases = opts.aliases ?? {};

  // 1. Exact directory match
  const directMatch = profiles.find((p) => p.directory === identifier);
  if (directMatch) return directMatch.directory;

  // 2. Config alias lookup (case-insensitive)
  const lower = identifier.toLowerCase();
  for (const [key, value] of Object.entries(aliases)) {
    if (key.toLowerCase() === lower) {
      // Verify the aliased directory actually exists
      if (profiles.some((p) => p.directory === value)) return value;
    }
  }

  // 3. account_info exact email match (covers all linked accounts, not
  // just the primary)
  const emailExact = profiles.find((p) => p.emails.some((e) => e.toLowerCase() === lower));
  if (emailExact) return emailExact.directory;

  // 4. Email domain match (e.g. "ogsus@ohwow.fun" matches any profile
  // linked to @ohwow.fun). Only if the identifier looks like an email.
  if (identifier.includes('@')) {
    const [, domain] = lower.split('@');
    if (domain) {
      const domainMatch = profiles.find((p) =>
        p.emails.some((e) => e.toLowerCase().endsWith(`@${domain}`)),
      );
      if (domainMatch) return domainMatch.directory;
    }
  }

  // 5. profile.name substring match (covers "O'GSUS" type display names)
  const nameMatch = profiles.find((p) => p.name.toLowerCase().includes(lower));
  if (nameMatch) return nameMatch.directory;

  return null;
}
