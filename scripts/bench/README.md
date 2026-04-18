# ohwow bench harness — slice 1

This is the first slice of the gap 09 runtime benchmark work (see
[`../../../research/gaps-to-close/09-benchmark-post.md`](../../../research/gaps-to-close/09-benchmark-post.md)).
Today it wraps **one** benchmarked task (`research-to-commit`), dispatches it
through the normal `POST /api/tasks` path of a running local daemon, and
records a structured `BenchRun` JSON with the token / cost / call-count delta
observed via `/api/pulse`.

The harness is a black box around the runtime on purpose — no source under
`src/` is modified in this slice. Future slices will layer in a
`bench_run_id` column on `llm_calls` and a `since` filter on `/api/approvals`
so attribution can be exact instead of window-relative.

## What it measures

For each run:

- **Metrics** (from `/api/pulse.llm.h24` diff): token total, cost cents, LLM
  call count. `prompt` and `completion` token splits stay at 0 until pulse
  exposes them separately.
- **Models observed**: union of `pulse.llm.topModels` (1h slice) before and
  after. Dropped models fall off the top-6 window; use a longer-lived run
  or a dedicated workspace if attribution matters.
- **Approvals delta**: row-count change on `/api/approvals` across the run.
- **Pending tasks delta**: row-count change on `/api/tasks?status=pending`.
- **Task terminal status**: `completed`, `failed`, `needs_approval`,
  `cancelled`, or `bench_error` if the harness itself crashed.
- **Wall-clock duration**: `endedAt - startedAt` of the harness, not the
  daemon-side execution window.

## CLI

```
node scripts/bench/run.mjs <task-id> [flags]
```

Positional `<task-id>` (required). Currently one of: `research-to-commit`.

| Flag | Default | Purpose |
| ---- | ------- | ------- |
| `--dry-run` | off | Only probe `/api/pulse` for readiness; emit a BenchRun with zeroed metrics. No `/api/tasks` dispatch. |
| `--port=<n>` | `OHWOW_DAEMON_PORT` or `7700` | Daemon port to probe. |
| `--timeout-ms=<n>` | `600000` | Max poll budget for the task to reach a terminal status. |
| `--agent-id=<id>` | (unset) | Skip task-module agent discovery and dispatch to this agent id directly. |
| `--help` | — | Print usage and exit. |

Output lands in `scripts/bench/results/`:

- `scripts/bench/results/<iso-startedAt>-<task-id>.json` — full BenchRun.
- `scripts/bench/results/index.jsonl` — one-line summary per run.

Both `*.json` and `index.jsonl` are gitignored — the `.gitignore` in the
`results/` folder is the source of truth.

## Honest limitations (read before you draw conclusions)

1. **No bench-id attribution in the runtime yet.** `/api/pulse` reports the
   whole 24h window. If background schedulers fire during the bench, their
   calls show up in `metrics.llm_calls` and `metrics.cost_cents`. Run this
   against a quiet workspace or stop schedulers first.
2. **`metadata.bench_run_id` is dropped.** `POST /api/tasks` does not
   persist `metadata` as of slice 1. The bench_run_id is preserved only in
   the harness's own BenchRun JSON. A future slice will add a column.
3. **Approvals diff is a count.** We don't filter by
   `created_at >= startedAt`. A backlog approval resolved mid-bench would
   show as `-1` even if the bench itself produced nothing.
4. **`tokens.prompt` and `tokens.completion` are always 0.** Pulse only
   exposes the sum today. The shape is stable so consumers don't have to
   re-wire once pulse surfaces the split.
5. **Model list is top-6 by cost.** Cheap or rarely-used models that ran
   during the bench but fell outside the 1h top-6 window are dropped from
   `model_used`.
6. **Single-task scope.** This slice runs one task end-to-end. There is no
   suite runner, no warm-up, no repeat-and-average, and no cross-run
   comparison. QA round owns those follow-ups.
7. **Dry-run is a daemon smoke test.** It only verifies `/api/pulse` is
   reachable. It does not exercise `POST /api/tasks`, `/api/agents`, or
   any polling code path, so a successful dry-run is not proof the live
   run will complete.
8. **`needs_approval` is treated as a terminal `ok` status.** The poller
   stops as soon as the task reaches `completed`, `failed`, `cancelled`,
   **or `needs_approval`**, and the BenchRun is emitted with whichever
   of those the daemon returned. A run that parked on approval is not
   failed — but it is also not "quality complete". Treat `needs_approval`
   separately when summarizing suites.
9. **No runtime patches applied.** The harness is black-box only. The
   deferred follow-ons (per-call `bench_run_id` on `llm_calls`,
   `since=<iso>` filter on `/api/approvals`) would give exact
   per-run attribution instead of window-relative deltas. Until those
   land, this slice's numbers are best-effort.
10. **Daemon bearer token required.** The harness resolves the token
    from `OHWOW_TOKEN` env then
    `~/.ohwow/workspaces/<active>/daemon.token`. If neither is set the
    readiness probe fails with a `401` and the BenchRun is emitted with
    `status=bench_error`.

## Tasks

- `scripts/bench/tasks/research-to-commit.mjs` — asks a coding-class agent
  to add a four-line JSDoc header to `scripts/bench/lib/collectors.mjs`.
  The file already has a header; the task is intentionally low-variance so
  the bench measures orchestration overhead rather than generation spread.

Each task module exports `{ id, label, async run(ctx) }`. The context hands
the module `port`, `benchRunId`, `agentIdOverride`, and a minimal
`logger = { log, warn }`. The module returns
`{ daemonTaskId, agentId, agentSource }` and the harness does the rest.

## Adding a new task

1. Drop a file in `scripts/bench/tasks/<your-id>.mjs`.
2. Export `id`, `label`, and `async run(ctx)`.
3. Inside `run`, dispatch exactly one task via `POST /api/tasks` and return
   its daemon id.
4. Update the `<task-id>` list in this README.
