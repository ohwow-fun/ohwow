# Autonomy

The autonomy stack is the runtime's "what should I do next, and how do I
do it" loop. It sits next to ImprovementScheduler (it does not replace
it). The full design contract lives in
`docs/autonomy-architecture.md`. This README is the operator's
quick-start: where each tier lives, how to inspect live state, and how
to add a scenario.

## The five tiers

| Tier | Purpose | File | How to read its state |
|------|---------|------|------------------------|
| Conductor | One process-wide loop picking the next phase from pulse + ledger. | `src/autonomy/conductor.ts` | `ohwow_autonomy_status` (MCP) or `GET /api/autonomy/status` (HTTP). Shows flag, open arcs, recent arcs. |
| Director | Runs one arc (1 to 6 phases) under a budget envelope. | `src/autonomy/director.ts` + `director-persistence.ts` | `director_arcs` rows; `director_phase_reports` rows. Surfaced via the conductor status snapshot. |
| Phase | One coherent scope (1 to 3 trios). | `src/autonomy/phase-orchestrator.ts` | `director_phase_reports` rows; full report in `raw_report`. |
| Trio | One plan + impl + qa sequence. | `src/autonomy/trio.ts` | `phase_trios` rows + child `phase_rounds`. |
| Round | One spawned subagent (plan / impl / qa). | `src/autonomy/round-runner.ts` (wraps `src/orchestrator/sub-orchestrator.ts`) | `phase_rounds` rows; raw return in `raw_return`. |

Pulse + ranker live alongside the tiers:

- `src/autonomy/pulse.ts` aggregates the per-mode signals the ranker
  scores against (approvals pending, rotting deals, qualified contacts
  with no outreach, dashboard smoke red, failing triggers, finding
  classes, tooling friction).
- `src/autonomy/ranker.ts` turns a pulse + ledger into a sorted list of
  `RankedPhase` candidates. Crude on purpose; sharpened only by
  evaluation harness feedback.

## Dark-launch flag

The conductor is dark-launched behind `OHWOW_AUTONOMY_CONDUCTOR=1`.
With the flag off (default) the daemon's wiring registers the loop but
every tick exits with `reason='flag-off'`. Production behavior does not
change.

To flip it:

1. Set `OHWOW_AUTONOMY_CONDUCTOR=1` in the daemon env (e.g. via
   `~/.ohwow/config.json` or the launchd plist).
2. Rebuild the daemon: `npx tsup && npm run copy-assets`.
3. Restart: `ohwow restart`.
4. Verify the flag is on: `ohwow_autonomy_status` (MCP) — the snapshot
   includes `flag_on: true` when the env var is set in the daemon
   process.
5. Verify the ranker would do something sensible: `ohwow_autonomy_dry_run`
   to preview the next pick.

The flag does NOT need to be flipped to run the eval suite — the
harness sets the env internally for each scenario.

Dark-launch checklist (flip only after every step passes):

1. Deterministic eval green: `npx tsx scripts/autonomy-eval.ts` → 16/16 ok.
2. `ohwow_autonomy_dry_run` returns a sensible next pick for your workspace.
3. Open MCP `ohwow_autonomy_status`; confirm `flag_on: false` and no open arcs.
4. Set `OHWOW_AUTONOMY_CONDUCTOR=1` in the daemon env and restart.
5. Watch `ohwow_autonomy_status` for the first arc — a dry-run-predicted mode should open.
6. After Phase 6.9, run `--real` once against live pulse samples and confirm
   plan rounds return a valid RoundReturn with cost_llm_cents > 0 under $0.10
   per scenario. Rollback path: unset the env var and restart.

## Real-LLM eval

Phase 6.9 lands a real-LLM executor for the PLAN round only. Impl and QA
stay stubbed — impl intersects `safeSelfCommit` (Phase 7 work) and QA
needs a test-runner sandbox. The executor routes through the project's
`ModelRouter` (no direct Anthropic SDK import) and targets
`claude-haiku-4-5-20251001` by default.

Run:

```bash
OHWOW_AUTONOMY_EVAL_REAL=1 npx tsx scripts/autonomy-eval.ts --real
# fast iteration — skip deterministic suite:
OHWOW_AUTONOMY_EVAL_REAL=1 npx tsx scripts/autonomy-eval.ts --real-only
```

Double opt-in: `--real` alone errors out; `OHWOW_AUTONOMY_EVAL_REAL=1`
alone is ignored. The vitest wrapper (`eval.test.ts`) never runs LLM
scenarios — CI stays cheap.

Cost caveat: each LLM scenario caps at $0.10 (~10c). Real-LLM output
varies run-to-run, so LLM scenarios assert STRUCTURAL shape
(status='continue', non-empty next_round_brief, summary mentions the
seeded subject, cost_llm_cents > 0) rather than byte-stable goldens.
Never enable on CI.

Adding a new real-LLM scenario:

1. Copy `src/autonomy/eval/scenarios-llm/00-revenue-approval-plan-real.ts`.
2. Keep assertions SHAPE-based, not text-based.
3. Re-use `ctx.captured_plan_return`, `ctx.meter`, and `ctx.phase_reports`.
4. Run with `--real-only` and confirm cost is well under the cap before
   committing.

What's NOT yet tested against a real LLM:

- Impl rounds (they write code / run tools; Phase 7 extends
  `safeSelfCommit` + path trust tiers before this is safe).
- QA rounds (need a sandboxed test-runner shape).
- Multi-phase arcs (needs a real re-plan path across trios).

## Operating

Three commands cover day-to-day operator work:

- `npx tsx scripts/autonomy-eval.ts` — run the full scenario suite
  against in-memory SQLite. Diff a scenario against its golden,
  surface any drift. Add `OHWOW_AUTONOMY_EVAL_UPDATE=1` to regenerate
  goldens after a deliberate behavior change.
- `ohwow_autonomy_status` (MCP) or `curl localhost:7700/api/autonomy/status`
  (HTTP, with the daemon's session token) — live snapshot of the
  conductor: flag state, any open arc, recent arcs, recent phase
  reports, inbox counts.
- `ohwow_autonomy_dry_run` (MCP) or `curl localhost:7700/api/autonomy/dry-run` —
  what the ranker would emit RIGHT NOW. Read-only; never opens an
  arc. Use this to debug "why did the conductor pick X" or to preview
  behavior before flipping the flag.

## File mirror (per-arc forensics)

After every arc closes, the Director writes a markdown mirror at:

```
~/.ohwow/workspaces/<slug>/autonomy/arcs/<arc_id>/
  arc.md
  phase-NN-<mode>.md
  phase-NN/round-NN-{plan,impl,qa}.md
```

Use `cat`, `git grep`, or `rg` over that tree for forensic spelunking
without opening the SQLite DB. The DB remains the source of truth for
queries; the mirror is regenerated from DB rows on every arc close and
is safe to delete. To rebuild it for a historical closed arc, run:

```bash
npx tsx scripts/autonomy-tick.ts --mirror-only=<arc_id>
```

Writes are atomic (`writeFile(.tmp)` + `rename`); a filesystem hiccup
during arc close logs a `pino.warn` and the arc still closes cleanly.

## How to add a scenario

Scenarios live in `src/autonomy/eval/scenarios/`. They are numbered
`NN-name.ts`. The harness discovers them automatically and diffs each
run against `src/autonomy/eval/golden/NN-name.txt`.

Start from `00-empty-quiet.ts` — it is the smallest possible scenario
(an empty pulse must still tick cleanly). Steps go through
`SeedSpec` for declarative pre-state and `ScenarioStep` for what
happens on each tick. Available step kinds: `tick`, `advance`, `seed`,
`answer-founder`, `restart-pick-once`. Available seed helpers:
`approvals`, `deals`, `contacts_qualified`, `failing_triggers`,
`findings`, `business_vitals`, `founder_inbox`, `prior_phase_reports`.

For mid-arc DB mutations (e.g. dropping MRR mid-run to trigger pulse-ko)
register a `MidArcHook` from the scenario file via
`setMidArcHook(scenario.name, hook)`. The hook fires after every phase
completes inside the harness's deterministic `runArc` mirror.

After adding a scenario, run with `OHWOW_AUTONOMY_EVAL_UPDATE=1` once
to write the golden, then commit both files together.

## Idempotency contract

Two safety properties the conductor guarantees:

- **Within-arc dedupe via picked_keys + restart-safe via phase_id parse.**
  Inside one arc, every distinct `(mode, source, source_id)` candidate
  runs at most once. Pre-Phase-6.5 the same approval would pick to the
  budget cap; the picker now keys off a per-arc `picked_keys` set. To
  survive a daemon crash mid-arc, Phase 6.7 encodes the source provenance
  into the phase_id (format `p<ver>_<stamp>_<mode>_<source>_<source_id>_<seq>`)
  and rebuilds the dedupe set on first picker call via
  `reconstructPickedKeys(arc_id)`. Format-version mismatches are
  silently skipped, so legacy rows do not crash a restart.

- **Cross-arc seed: answered+unresolved inbox rows resolve only after
  the phase reaches in-flight.** When the founder answers an inbox
  question whose originating arc has CLOSED, the next conductor tick's
  workspace-wide pre-fetch surfaces the row and the picker emits a
  founder-answer candidate at score 200+. Phase 6.7 moves the
  `resolveFounderQuestion` call out of the picker (where it fired
  immediately on merge) into the Director, after the phase report row
  transitions to `status='in-flight'`. Net effect: if pulse-ko or
  budget aborts the arc BEFORE the picked phase actually starts, the
  inbox row stays `answered` and the next tick's pre-fetch picks it up
  again. Within-arc answered polls keep their post-hoc resolve-on-detect
  behavior because they only fire AFTER a phase has already returned.

## Future phases

- Phase 7 — cautious self-modification expansion. Extend
  `safeSelfCommit` allowlist + path trust tiers so tooling-phase rounds
  can land daemon code under tighter audit, not just
  `src/self-bench/experiments/`. The kill switch
  (`~/.ohwow/self-commit-enabled`) stays.
- Deferred: the harness's deterministic `runArc` mirror duplicates
  production control flow with a "keep in lockstep" comment. A future
  phase folds them into a shared core. Tracked in the Phase 6.5 and
  6.7 commit bodies.
- Cloud rendering of inbox rows + arc state alongside `approvals`.
  Local-only this phase; cloud needs a sync path through
  `control-plane/client.ts` that does not exist for these tables yet.
- Mode-lens source of truth. The skill ships lens prose under
  `.claude/skills/be-ohwow/briefs/`. Today the runtime duplicates them
  as TS string constants under `src/autonomy/lenses/`. Open question
  in `docs/autonomy-architecture.md`.
