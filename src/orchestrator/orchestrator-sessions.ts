/**
 * Session lifecycle helpers for LocalOrchestrator.
 *
 * `activateBrowserSession` takes the raw config plus the profile request
 * and returns a connected `LocalBrowserService` plus a degradation reason
 * (non-null when the CDP-attached path fell through to isolated Chromium).
 * Keeps the ~80-line Chrome/CDP branching out of LocalOrchestrator while
 * leaving the mutable `browserService` / `browserActivated` fields on the
 * orchestrator so the in-loop activation sites in the three chat loops
 * don't need to route through a controller.
 */

import { LocalBrowserService } from '../execution/browser/local-browser.service.js';
import { logger } from '../lib/logger.js';

export interface BrowserActivationRequest {
  requestedProfile: string | undefined;
  browserHeadless: boolean;
  browserTarget: 'chromium' | 'chrome';
  chromeCdpPort: number;
  chromeProfileAliases: Record<string, string>;
}

export interface BrowserActivationResult {
  service: LocalBrowserService;
  degradedReason: string | null;
}

/**
 * Activate a browser session by resolving the requested Chrome profile,
 * attaching via CDP, and falling back to isolated Chromium with a
 * descriptive `degradedReason` whenever the CDP path can't come up.
 * Pure in the sense that it doesn't touch orchestrator state — callers
 * must assign `service`, clear their `degradedReason`, and flip
 * `browserActivated = true` themselves.
 */
export async function activateBrowserSession(
  opts: BrowserActivationRequest,
): Promise<BrowserActivationResult> {
  const { requestedProfile, browserHeadless, browserTarget, chromeCdpPort, chromeProfileAliases } = opts;

  // "isolated" profile means use Playwright Chromium with no state.
  if (requestedProfile === 'isolated') {
    const service = new LocalBrowserService({ headless: browserHeadless, forceBundled: true });
    logger.info('[orchestrator] Browser activated (isolated Chromium)');
    return { service, degradedReason: null };
  }

  if (browserTarget !== 'chrome') {
    const service = new LocalBrowserService({ headless: browserHeadless, forceBundled: true });
    return { service, degradedReason: null };
  }

  try {
    // Resolve profile identifier (directory, email, alias, display name)
    // to a concrete Chrome profile directory using the same resolver as
    // desktop_focus_app so the two paths stay in sync. This lets
    // ogsus@ohwow.fun land on Profile 1 via the chromeProfileAliases
    // config map instead of falling through to the bare account_info
    // match and ending up on the Default profile.
    let profileDir = requestedProfile;
    if (profileDir) {
      const { resolveChromeProfile, discoverChromeProfiles } = await import(
        '../execution/desktop/chrome-profile-resolver.js'
      );
      const resolved = resolveChromeProfile(profileDir, {
        profiles: discoverChromeProfiles(),
        aliases: chromeProfileAliases,
      });
      if (resolved) {
        profileDir = resolved;
      } else if (profileDir.includes('@')) {
        // Last-resort: try the browser service's own email lookup
        // (covers Google-signed-in accounts that aren't in the alias map).
        profileDir = (await LocalBrowserService.findProfileForEmail(profileDir)) || undefined;
      }
    }

    const cdpUrl = await LocalBrowserService.connectToChrome(chromeCdpPort, profileDir);
    if (cdpUrl) {
      const service = new LocalBrowserService({ headless: false, cdpUrl });
      logger.info(
        `[orchestrator] Browser activated via Chrome CDP${profileDir ? ` (profile: ${profileDir})` : ''}`,
      );
      return { service, degradedReason: null };
    }

    // CDP setup failed. Fall back to bundled Chromium so the orchestrator
    // still has SOME browser capability, but surface the degradation
    // LOUDLY so the LLM stops pretending it's in the user's real logged-in
    // session. Build the reason from a pure filesystem probe so fresh-
    // install users get "run ohwow chrome bootstrap" instead of the
    // misleading "Chrome CDP unavailable".
    const { describeDebugChromeState } = await import('../execution/browser/chrome-lifecycle.js');
    const state = describeDebugChromeState();
    const service = new LocalBrowserService({ headless: browserHeadless, forceBundled: true });
    let degradedReason: string;
    if (state.status === 'missing') {
      degradedReason = `${state.reason} Running in isolated Chromium (no logged-in sessions). ${state.bootstrapHint}`;
    } else if (state.status === 'corrupted') {
      degradedReason = `${state.reason} Running in isolated Chromium. Issues: ${state.detectedIssues.join('; ')}. ${state.bootstrapHint}`;
    } else {
      // Debug dir is fine but CDP still didn't come up. Real transient
      // failure — port busy, Chrome crashed on boot, timeout waiting for
      // devtools, etc.
      degradedReason = `Debug Chrome is installed but CDP did not come up on :${chromeCdpPort}${profileDir ? ` (requested profile: ${profileDir})` : ''}. Running in isolated Chromium. Check daemon.log for spawn errors, or run \`ohwow chrome status\` to inspect the debug dir.`;
    }
    logger.warn(`[orchestrator] ${degradedReason}`);
    return { service, degradedReason };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      '[orchestrator] Chrome activation failed, falling back to Chromium',
    );
    const service = new LocalBrowserService({ headless: browserHeadless, forceBundled: true });
    const degradedReason = `Chrome activation threw: ${err instanceof Error ? err.message : String(err)} — running in isolated Chromium with no real profile`;
    return { service, degradedReason };
  }
}
