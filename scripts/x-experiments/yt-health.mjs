#!/usr/bin/env node
/**
 * yt-health — Studio session health report.
 *
 * Connects to the running debug Chrome on :9222, locates (or opens) a
 * studio.youtube.com tab, and prints a JSON report of:
 *   - health: loggedIn, channelId, channelHandle, dialogs, URL
 *   - challenge: null, or { kind, detail, url, remediation }
 *   - target: { targetId, browserContextId }
 *
 * Exit 0 when healthy + logged-in + no challenge. Non-zero otherwise.
 * This is the first thing to run when debugging any other YouTube
 * automation — if it fails, nothing downstream can succeed.
 *
 * Flags (positional env vars):
 *   IDENTITY=@handle        verify the logged-in channel matches
 *   CONTEXT=<browserContextId>  pin a specific Chrome profile
 *   CDP_BASE=http://localhost:9222  override CDP endpoint
 *   OPEN=1                  open a Studio tab if none exists
 *
 * Run: node --import tsx scripts/x-experiments/yt-health.mjs
 */
import { ensureYTStudio } from '../../src/integrations/youtube/index.ts';
import { RawCdpBrowser } from '../../src/execution/browser/raw-cdp.ts';

const CDP_BASE = process.env.CDP_BASE || 'http://localhost:9222';
const IDENTITY = process.env.IDENTITY || undefined;
const CONTEXT = process.env.CONTEXT || undefined;
const OPEN = process.env.OPEN === '1';

async function run() {
  // Pre-flight: just list targets so we can tell callers what exists
  // without mutating state yet.
  const browser = await RawCdpBrowser.connect(CDP_BASE, 5_000);
  const targets = await browser.getTargets();
  const pages = targets.filter((t) => t.type === 'page');
  const studioTabs = pages.filter((t) => /studio\.youtube\.com/.test(t.url));
  const contexts = new Set(pages.map((t) => t.browserContextId).filter(Boolean));

  const report = {
    preflight: {
      cdpBase: CDP_BASE,
      totalPages: pages.length,
      studioTabs: studioTabs.map((t) => ({
        targetId: t.targetId.slice(0, 8),
        contextId: t.browserContextId?.slice(0, 8) ?? null,
        url: t.url,
        title: t.title,
      })),
      uniqueContexts: Array.from(contexts).map((c) => c?.slice(0, 8)),
    },
    session: null,
    health: null,
    challenge: null,
    ok: false,
    exitReason: null,
  };

  // If no Studio tab and OPEN not set, don't create one — just report state.
  if (studioTabs.length === 0 && !OPEN) {
    report.exitReason = 'no_studio_tab';
    browser.close();
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  try {
    const session = await ensureYTStudio({
      browser,
      browserContextId: CONTEXT,
      identity: IDENTITY,
      throwOnChallenge: false,
    });
    report.session = {
      targetId: session.targetId.slice(0, 8),
      browserContextId: session.browserContextId?.slice(0, 8) ?? null,
    };
    report.health = session.health;
    report.challenge = session.challenge;
    report.ok = !session.challenge && session.health.loggedIn;
    if (!session.health.loggedIn) report.exitReason = 'not_logged_in';
    else if (session.challenge) report.exitReason = `challenge:${session.challenge.kind}`;
  } catch (err) {
    report.exitReason = err?.name ? `${err.name}:${err.message}` : String(err);
  }

  browser.close();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

run().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err?.message ?? String(err), stack: err?.stack }, null, 2));
  process.exit(3);
});
