# X search throttle

The ohwow runtime talks to X's authenticated search RPC (not the public
search endpoint) through the X account's own session. That RPC enforces a
per-account rolling window: roughly 60 minutes of search traffic before
the account starts getting "Something went wrong" payloads instead of
results. When that happens, every process in ohwow needs to stop hammering
the endpoint until the window clears, otherwise we dig ourselves deeper.

This doc covers the shared throttle state, how it's detected, how backoff
works, how to inspect and clear it, and which log events to watch.

## What the throttle is

- Applies per X account, not per IP or device.
- Rolling window, not a hard quota reset on the hour.
- Driven by authenticated search-RPC call volume (pain-finder, x-intel,
  x-reply's search step, any ad-hoc experiment script).
- Not the same as X API v2 rate limits or the public search rate limits;
  the user's logged-in session carries its own budget.

## How detection works

The in-flight HTTP response for a throttled search-RPC call comes back
2xx but the JSON body carries the signature string `Something went wrong`
with no `data.search_by_raw_query` payload. The x-search integration
detects that signature and calls `markThrottled(url)` on
`src/lib/x-search-throttle.ts`.

State lives in a single file: `~/.ohwow/x-search-throttle.json`.

```json
{
  "throttled_until": "2026-04-18T19:42:17.931Z",
  "consecutive_hits": 2,
  "last_hit_at": "2026-04-18T18:12:17.931Z",
  "last_hit_url": "https://x.com/i/api/graphql/.../SearchTimeline",
  "last_recovery_at": "2026-04-17T22:05:03.114Z"
}
```

Every process that runs search queries reads this file before firing, and
writes to it on a hit or a recovery. That makes the state cross-process:
parallel schedulers, the daemon, and experiment scripts all see the same
throttle.

## Backoff schedule

Consecutive hits within a 24-hour window escalate:

| Hit # | Backoff (base)  | With +/- 10% jitter |
| ----- | --------------- | ------------------- |
| 1st   | 30 min          | 27 - 33 min         |
| 2nd   | 90 min          | 81 - 99 min         |
| 3rd+  | 4 h             | 3h36m - 4h24m       |

`consecutive_hits` resets to 0 after 24 hours of quiet (no new hits).
Jitter prevents every paused process from retrying in lockstep, which
would otherwise look like a mini burst to X.

## Pacing recommendations

Even when not throttled, pace authenticated search queries. Safe defaults:

- 60 to 90 seconds between queries per account for background work
  (pain-finder, x-intel sweeps, scheduled comps).
- Burst up to 10-15 queries only when a human is driving (x-reply tool
  calls during a live operator session), then cool down.
- Don't run two search-heavy experiments in parallel against the same
  account. Use `ohwow workspace list` to confirm what's running.

## Inspecting the state

The operator-facing surfaces, in order of preference:

```bash
# One-liner inside the default status readout.
ohwow status
# Daemon running (PID 12345) on port 7700 — focused workspace "default"
# X search: throttled (clears in 18m)

# Full readout with last hit url and recovery timestamp.
ohwow x-throttle-status

# Machine-readable for scripts / monitoring.
ohwow x-throttle-status --json
```

Or go to the source of truth directly:

```bash
cat ~/.ohwow/x-search-throttle.json
```

## Manually clearing the throttle

Useful only for testing. Removing the file or zeroing the `throttled_until`
field will not extend your real X search budget — it just lets ohwow try
again immediately, which will either succeed (if the real window has
elapsed) or hit another throttle and re-create the state with a longer
backoff (since `consecutive_hits` doesn't reset on a manual clear).

```bash
# Clear everything (next hit starts fresh at 30min).
rm ~/.ohwow/x-search-throttle.json

# Clear the lockout but keep history (next hit escalates).
jq '.throttled_until = null' ~/.ohwow/x-search-throttle.json \
  | sponge ~/.ohwow/x-search-throttle.json
```

For test isolation, set `OHWOW_X_SEARCH_THROTTLE_FILE` to a throwaway
path — the module honors the env var at import time.

## Expected log events

All events are pino records on the runtime's structured logger. Fields
are stable; operators can grep them with `ohwow logs | grep x_search_`.

| Event                      | Level | Where                                     | Fields                                              |
| -------------------------- | ----- | ----------------------------------------- | --------------------------------------------------- |
| `x_search_rate_limited`    | warn  | `markThrottled`                           | `consecutive_hits`, `backoff_ms`, `throttled_until`, `url` |
| `x_search_resumed`         | info  | `markRecovered`                           | `consecutive_hits`, `at`                            |
| `x_search_deferred`        | info  | `assertNotThrottled` (before throwing)    | `caller`, `until`, `remainingMs`                    |
| `x_search_waiting`         | info  | `waitForThrottleClear` (per poll tick)    | `remainingMs`, `pollIntervalMs`, `elapsedMs`        |
| `x_search_throttle_state_unreadable` | warn | `readThrottleState` (on parse error) | `err`, `path`                                    |

Read them as a story:
- `x_search_rate_limited` = we just hit a throttle; backoff starts.
- `x_search_deferred` = a call was skipped because the throttle is still
  active. One of these per deferred call; if you see thousands in a loop,
  a consumer is spinning instead of waiting.
- `x_search_waiting` = a consumer is sleeping cooperatively via
  `waitForThrottleClear`. One per 30 seconds by default.
- `x_search_resumed` = someone called `markRecovered` (usually after a
  successful search succeeded post-backoff).

## Calling contract for consumers

- Fail fast: call `assertNotThrottled()` before each search query. On a
  throw, surface the error to the caller — don't swallow it.
- Block and wait: call `await waitForThrottleClear()` when a scheduler
  can afford to sleep. It re-reads state every tick, so a sibling
  process's `markRecovered()` wakes you up on the next poll.
- On a detected throttle response: call `markThrottled(url)`. The
  backoff escalation is handled for you.
- On a successful query after a backoff: call `markRecovered()`. This
  clears `throttled_until` without wiping the `consecutive_hits`
  counter (which still resets on its own after 24h of quiet).
