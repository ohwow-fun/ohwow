# YouTube Ops Runbook

Day-to-day operations for the OHWOW.FUN five-series engine. Read this
before enabling any cadence; revisit when onboarding a new series.

## Pre-flight (before any daemon cron is enabled)

1. `OHWOW_YT_SHORTS_ENABLED=false` in the workspace config (master off).
2. For each series, run the compose script manually at least 5× with
   `DRY=1 node scripts/yt-experiments/yt-compose-<series>.mjs`.
   - Inspect `brief.json` in the tmp dir each time.
   - Watch for banned-phrase hits, low-confidence drafts, render errors,
     visual-review fails.
3. Run one `DRY=0 VISIBILITY=unlisted` per series. Visit Studio, watch
   the video end-to-end. Verify:
   - Text is legible at mobile portrait.
   - Voice matches the series voice config (alloy for Briefing, onyx for
     Tomorrow Broke, fable for Mind Wars, sage for Operator Mode).
   - Ambient mood matches the kit's `ambientMoodDefault`.
   - Length is within the format contract (45s / 60s / 90s).
   - Loop lands (if narrative series).
4. Only after ≥5 clean unlisted uploads per series do we flip the
   per-series env flag and enable the daemon automation.

## Daily stand-up

```
node scripts/yt-experiments/yt-series-digest.mjs
```

Prints per-series:

- What shipped in the last 24h (approval status, visibility, URL).
- Current goal progress (from `agent_workforce_goals`).
- Pending approvals (count + oldest age).
- Kill-switch state (env + daemon automation status).

Read this first thing every morning. If any series shows 0 shipped and
≥2 pending approvals older than 36h, clear the backlog before enabling
anything new.

## Human gate policy

Every series stays human-approved for **10–20 episodes minimum** before
auto-approve flips. YT blast radius is much bigger than X — a ToS
strike can terminate the channel.

Auto-approve is allowed only when ALL hold:

- **Lift converging**: strategist shows non-zero weight movement for the
  series based on ≥5 episodes' worth of lift data.
- **Visual review false-negative < 5%**: humans have rejected fewer than
  1 in 20 videos that the visual self-review passed.
- **Zero policy flags**: no copyright takedown, no ToS strike, no YT
  community-guideline warning across approved posts.

Flip is per-series. Briefing can auto-approve while Tomorrow Broke is
still human-gated. Never flip all five at once.

## Kill switches (layered)

1. **Master**: `OHWOW_YT_SHORTS_ENABLED=false`. Restart daemon. All five
   automations paused.
2. **Per-series**: `OHWOW_YT_<SERIES>_ENABLED=false`. That series'
   automation paused; others unaffected.
3. **Account flags preflight**: every compose run calls
   `ensureYTStudio` and reads `health.accountFlags`. If
   `hasUnacknowledgedCopyrightTakedown` or `hasUnacknowledgedTouStrike`
   is true, composer refuses and logs a structured alert.
4. **Per-episode**: `visualReview.pass < 6` blocks the approval row.

## Incident response

### Copyright takedown

1. Do NOT flip per-series flags back on until the strike is acknowledged
   in Studio.
2. Pull the offending post via `uploadShort` history + `videoMetadata`.
3. Audit the source x-intel highlights for the post's seed — if a
   permalink from the highlights led to the strike (quote scraped at too
   high a fidelity), flag the author handle in
   `~/.ohwow/workspaces/<ws>/yt-citation-deny.jsonl` so future drafts
   can't cite that source.
4. Run `ensureYTStudio` manually and confirm `accountFlags` has the
   strike marked acknowledged before any cadence resumes.

### Bad upload landed public

1. `OHWOW_YT_SHORTS_ENABLED=false`. Restart daemon.
2. Delete the video in Studio (not via automation — manual click).
3. Find the approval row in `~/.ohwow/workspaces/<ws>/yt-approvals.jsonl`.
   Mark it `status: rejected_post_upload` with an `incident` payload.
4. Write a finding via `ohwow_list_findings` (or direct insert if no
   MCP tool yet) tagged `yt_incident` describing what made it through.
5. Update the series' show bible banned list.
6. Minimum 48h human-only gate on that series before re-enabling cron.

### Metrics poller stuck

1. Check `ohwow_daemon_status` — confirm daemon is running.
2. Check `ohwow_list_automations` for the `yt-metrics` entry — is it
   paused, erroring, or OK?
3. If CDP lane contention (X and YT both trying to use the browser), the
   lane mutex should serialize; if it's not, check
   `src/execution/browser/cdp-lane.ts` for a deadlock (expired lease,
   leaked lock).
4. Kill the metrics-poller process; restart daemon. It's idempotent.

## Backfill

If a day got skipped (daemon down, network out, all drafts rejected):

- Don't double-post. Better a missed day than two-back-to-back uploads
  that swamp the algorithm's cadence model.
- Catch up with a 90s extended-cut on the next normal slot if the story
  warrants it.
- Skipped days are OK. Streaks measure consistency over time, not
  perfection.
