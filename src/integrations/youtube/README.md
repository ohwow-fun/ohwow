# youtube — Studio CDP integration

Typed YouTube Studio automation. Covers: session health, challenge
detection (2FA / captcha / consent / account-chooser), upload wizard
with dry-run mode, and read-only scrapers for channel summary,
analytics overview, video list, and per-video metadata.

**Not covered:** video generation (see `@ohwow/video` + `yt-compose.mjs`
for rendering), write operations on existing videos (thumbnail upload,
metadata edit, comment replies), orchestrator tool registration (kept
library-only on purpose — see below).

## Identity model

All calls run against ohwow's debug Chrome on `:9222`. Profile
targeting is by CDP `browserContextId` — one context per Chrome
profile. Options in order of specificity:

1. **Pass `browserContextId`** — pins the exact profile. Best when the
   caller already knows which profile to hit (got it from a prior
   `CdpTargetInfo`).
2. **Pass `identity`** (channel ID or handle) — verified against
   `window.ytcfg.data_.CHANNEL_ID` after load. Mismatch throws
   `YTSessionError` and closes the tab.
3. **No hint** — reuses any existing `studio.youtube.com` tab; otherwise
   opens one in a context borrowed from a YT or X tab.

Handle probing is best-effort; Studio doesn't always render `/@handle`
anchors. Prefer channel-ID matching.

## Lane model

Every upload + scrape should run inside `withCdpLane(workspaceId, …)`
from `src/execution/browser/cdp-lane.ts`. Multiple schedulers share
the same debug Chrome — the lane mutex prevents a YT upload from
colliding with an X DM poll on a different tab.

This module doesn't wrap the lane itself — the caller controls the
lane boundary. When using the library from a scheduler, do:

```ts
await withCdpLane(workspaceId, async () => {
  const session = await ensureYTStudio({ identity });
  try {
    return await uploadShort(session.page, { ... });
  } finally {
    if (session.ownsBrowser) session.browser.close();
  }
}, { label: 'yt:upload' });
```

## Dry-run contract

`uploadShort(page, { dryRun: true })` runs every wizard stage up to
and including visibility selection + URL extraction, then closes the
dialog. Nothing is committed to the channel. The returned
`UploadResult` has `dryRun: true` and the `wouldBeUrl` the visibility
pane surfaced.

This is the ONLY mode used by `yt-dry-run.mjs`. It's safe to run on a
real channel — we verified end-to-end that the channel video list
stays empty across three consecutive dry-runs.

## CLIs

All CLIs live under `scripts/x-experiments/` and run via
`node --import tsx`:

- `yt-health.mjs` — session preflight + login/challenge report. Run
  this first when anything is misbehaving.
- `yt-selector-audit.mjs` — audits every `SEL.*` constant against live
  Studio. `FLOW=upload` to include upload-wizard selectors. Use to
  pinpoint DOM drift.
- `yt-dry-run.mjs` — generates a test MP4 via ffmpeg and exercises the
  full upload wizard with `dryRun: true`. Safe to repeat.
- `yt-read-analytics.mjs` — channel dashboard summary + 28-day
  analytics window (configurable via `WINDOW`).
- `yt-list-videos.mjs` — enumerate uploaded videos (handles empty
  channel).
- `yt-read-metadata.mjs <videoId>` — read one video's title /
  description / visibility / metrics.

## Extending selectors

Every selector lives in `selectors.ts`. Add a new constant with:

1. A short why-comment (what it targets, when it mounts).
2. A category prefix (`UPLOAD_`, `META_`, `WIZARD_`, `DIALOG_`,
   `VISIBILITY_`, `VIDEO_`, `ANALYTICS_`, `CHANNEL_`, `AUTH_`,
   `CHALLENGE_`).
3. A run of `yt-selector-audit.mjs` to verify it mounts in the flow
   you expect.

Aliases (two constants pointing at the same string) are allowed but
must be whitelisted in `__tests__/selectors.test.ts` with a reason —
otherwise the dupe test fails.

## Why not orchestrator tools yet

This library is deliberately CLI + function-call only. Registering
`uploadShort` as a tool callable by agents would let the autonomous
loop post to YouTube without human review. That's the wrong default
until we have:

- A Studio rate-limit model (Google's undocumented) in the tool
  pre-flight.
- Quota telemetry in the daemon so we can see before burning through.
- Explicit approval-queue wiring — every real upload should go through
  a human approve step, not an inline tool call.

Read-only tools (metadata, analytics) could be safely registered
sooner, but no downstream agent is asking for them yet.
