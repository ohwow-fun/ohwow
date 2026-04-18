# Autonomy architecture

Phase 1 design spec for retrofitting ohwow's runtime autonomy onto the
five-tier shape the `be-ohwow` Claude Code skill describes
(`/Users/jesus/Documents/ohwow/.claude/skills/be-ohwow/SKILL.md`). This
doc is the fixed point the next six phases reference. Concepts that map
onto live code name the file. Concepts that don't are tagged GREENFIELD.

## Thesis

After this arc lands, the daemon stops being a flat bag of 99
experiments + a 24h gate + a per-agent heartbeat. It becomes a
**conductor** that reads the live business pulse, picks the next phase
that shortens distance to a paying customer, spawns a phase
orchestrator that runs one to three trios (plan / impl / qa) under a
mode lens (revenue / polish / plumbing / tooling), and records the arc
as durable DB state the founder can inspect. Existing experiments stay;
they become probes the conductor consults, not the top of the loop.
Destination: ohwow conducts itself toward the next paying customer,
with the founder intervening only on real forks.

## The five tiers

| Tier | Purpose | Runtime construct | State unit | Lifetime | Does NOT |
|------|---------|-------------------|------------|----------|----------|
| **Conductor** | One process-wide loop picking the next phase from pulse + ledger | GREENFIELD `src/autonomy/conductor.ts`, wired in `src/daemon/start.ts`. Augments `ImprovementScheduler` (`src/scheduling/improvement-scheduler.ts`); does not replace `LocalScheduler` (cron) or `HeartbeatCoordinator` | `director_arcs` row (one open per workspace), in-memory tick lock | Process-long; one tick per `IMPROVEMENT_INTERVAL_MS` or on `proactive-engine.ts` event | Pick what to do *inside* a phase. Touch git. Talk to LLMs except for ranking summarisation. |
| **Director** | Runs one arc (1-6 phases), holds budget caps and inbox state | GREENFIELD `src/autonomy/director.ts`, called per Conductor tick. Mirrors `briefs/director.md` tick sequence | `director_arcs.budget_*`, `.thesis`, `.status`; `founder_inbox` rows | Per-arc; opens when Conductor decides to begin a multi-phase run, closes on exit condition | Spawn rounds. Read trio return blocks. Edit code. Write to mode sub-files. |
| **Phase** | One coherent scope (1-3 trios) in fresh subagent context | GREENFIELD `src/autonomy/phase-orchestrator.ts`. In-process async task; reuses `src/orchestrator/sub-orchestrator.ts` for spawn | `director_phase_reports` row, `phase_trios` children | Per-phase; until the 5-line report returns | Run more than `max_trios`. Queue more than 2 founder questions. Touch `director_arcs.thesis`. |
| **Trio** | One work unit = plan + impl + qa rounds in sequence | GREENFIELD `src/autonomy/trio.ts` | `phase_trios` row, three child `phase_rounds` rows | Per-trio; minutes to ~1 hour | Span multiple modes. Skip the QA round even on revenue work. |
| **Round** | One spawned subagent (plan, impl, or qa) returning a structured block | `src/orchestrator/sub-orchestrator.ts` (existing) wrapped by GREENFIELD `src/autonomy/round-runner.ts` (injects brief, parses return) | `phase_rounds` row plus optional `self_findings` rows | Per-round; seconds to ~30 min | Bleed scope. Spawn other rounds. Update `director_arcs` directly. |

The bleeds were the old failure mode: `improvement-scheduler.ts` mixes
"decide what to run", "run it", and "consolidate reflections" because
nothing forced the layers apart.

## Round-return contract

Every round returns exactly this. Drift triggers a re-prompt with the
same brief plus *"Return only this block."* (Mirrors the markdown
return blocks in `briefs/phase-loop.md` Section "Return-format
contracts".)

```ts
// src/autonomy/types.ts (GREENFIELD)
export type RoundStatus = 'continue' | 'needs-input' | 'blocked' | 'done';

export interface RoundReturn {
  status: RoundStatus;
  /** <=5 lines; logged to phase_rounds.summary */
  summary: string;
  /** Brief for the next round when status==='continue'; required on plan and impl */
  next_round_brief?: string;
  /** self_findings.id rows the round wrote */
  findings_written: string[];
  /** Short SHAs the round committed; empty for plan rounds and code-less revenue rounds */
  commits: string[];
  /** qa rounds only */
  evaluation?: {
    verdict: 'passed' | 'failed-fixed' | 'failed-escalate';
    criteria: Array<{ criterion: string; outcome: 'passed' | 'failed' | 'untestable'; note?: string }>;
    test_commits: string[];
    fix_commits: string[];
  };
}
```

The round-runner parses the brief's structured block, validates, then
surfaces this typed shape to the trio coordinator. The raw block stays
in `phase_rounds.raw_return` for forensics.

## The Trio shape

Composition: trio runner spawns plan, reads return, decides:

- `plan.status='continue'` -> spawn impl with `next_round_brief`.
- `plan.status='needs-input'` -> write `founder_inbox` row, mark trio
  `awaiting-founder`, return to phase orchestrator.
- `plan.status='blocked'` or `'done'` -> close trio with that status.
- `impl.status='continue'` -> spawn qa.
- `impl.status='blocked'` -> trio `regressed`; phase decides re-plan
  (tighter bounds) vs close-as-partial.
- `qa.evaluation.verdict='passed'` or `'failed-fixed'` -> trio
  `successful`.
- `qa.evaluation.verdict='failed-escalate'` -> trio `regressed`; phase
  MUST re-plan before another trio in the same scope.

Abort-early signals (any round can raise `status='blocked'`):
- Pulse regression mid-trio: `business_vitals` shows MRR or pipeline
  dropping vs arc entry. Conductor polls each tick and signals at the
  next round boundary.
- `self_findings` row with `verdict='error'` for the experiment family
  the trio is touching.
- Trio wall-clock exceeds 90 min.

QA verdict feeds `phase_trios.outcome` (`successful` / `regressed` /
`blocked`). Phase orchestrator reads only the outcome and qa
`evaluation.criteria`; it never re-reads earlier round returns.

## The Phase contract

Opens when Director picks the phase and writes a
`director_phase_reports` row with `status='in-flight'`. Closes when the
phase orchestrator returns its 5-line report (mirrors
`briefs/director.md` Section "Phase report contract"):

```
PHASE: <id> - <mode> - <one-sentence goal>
STATUS: phase-closed | phase-partial | phase-blocked-on-founder | phase-aborted
TRIOS: <n> (e.g., "2 - polish+polish")
SHAS: runtime <a..b>; cloud <c..d>  (or "none")
DELTA: pulse <one-line>; ledger <sections>; inbox +<n>
NEXT: <mode> - <goal>  (or "arc-stop")
```

Director writes only this row plus a `director_arc_events` audit row.
Director never reads round returns or commit diffs. The phase report is
the contract; everything else is forensic.

## Mode lenses

| Lens | Tables / surfaces | API routes | MCP verbs | Existing experiment families |
|------|-------------------|------------|-----------|------------------------------|
| **revenue** | `deals`, `deal_stages` (mig 136), `agent_workforce_contacts`, `x_post_drafts` (135), `x_reply_drafts` (142), `x_dm_drafts` (124-127), cloud `approvals` | `approvals.ts`, `deals.ts`, `revenue.ts`, `x-drafts.ts`, `x-reply-drafts.ts`, `x-dm-drafts.ts`, `contacts.ts` | `ohwow_list_approvals`, `ohwow_preview_approval`, `ohwow_approve_x_draft`, `ohwow_draft_x_dm`, `ohwow_update_deal`, `ohwow_pipeline_summary`, `ohwow_revenue_summary` | `attribution-observer`, `contact-conversation-analyst`, `agent-outcomes`, `next-step-dispatcher`, `burn-rate`, `burn-guard` |
| **polish** | Cloud dashboard pages (`ohwow.fun/src/app/`), embedded onboarding (`src/web/src/pages/onboarding/`). Runtime is read-only here | (cloud) | (none in runtime) | `dashboard-smoke`, `dashboard-copy`, `list-completeness-summary`, `handler-schema-drift` |
| **plumbing** | `agent_workforce_tasks`, `agent_workforce_task_state` (045/110), `state_changelog` (046), `local_triggers`, `outbound_queue` (047), `experiment_validations` (117/118) | `failing-triggers.ts`, `health.ts`, `tasks.ts`, `data-locality.ts`, `cloud-proxy.ts` | `ohwow_list_failing_triggers`, `ohwow_daemon_status`, `ohwow_workspace_status` | `migration-drift-sentinel`, `migration-schema-probe`, `agent-state-hygiene-sentinel`, `loop-cadence-probe`, `agent-lock-contention`, `intervention-audit`, `device-audit` |
| **tooling** | `src/mcp-server/tools.ts` (registry), `src/mcp-server/tools/*.ts`, `src/api/routes/*.ts`, `code_skills` (107) | (all) | (creates new ones) | `experiment-author`, `experiment-proposal-generator`, `autonomous-author-quality`, `autonomous-patch-rollback`, `findings-gc`, `ledger-health` |

The existing self-author loop already produces tooling-shaped artifacts;
the trio wraps that loop in plan / qa discipline. Polish work almost
always lands in the cloud repo, not here; the runtime side is read-only
for that lens.

## Conductor ranking

Runs once per `IMPROVEMENT_INTERVAL_MS` (default 1h) and on
`proactive-engine.ts` nudge events. Reads pulse + ledger, emits ranked
candidates. Director (called synchronously from the same tick) is the
only writer of `director_arcs`.

```ts
// src/autonomy/ranker.ts (GREENFIELD)
function rankNextPhase(ws: WorkspaceCtx): RankedPhase[] {
  const pulse  = readPulse(ws);  // approvals, failing triggers, idle agents,
                                 // funnel, MRR, revenue 7d/30d, daily LLM cost
  const ledger = readLedger(ws); // recent director_phase_reports, recent
                                 // self_findings by category, last-touched cadence
  const c: RankedPhase[] = [];

  // Tier 1: REVENUE (be-ohwow goal hierarchy step 1)
  for (const a of pulse.approvals_pending) c.push({ mode: 'revenue', goal: `fire approval ${a.id}`, score: 100 + a.age_hours });
  for (const d of pulse.deals_rotting)     c.push({ mode: 'revenue', goal: `move deal ${d.id}`,     score: 80 + d.idle_days * 2 });
  for (const q of pulse.qualified_no_outreach) c.push({ mode: 'revenue', goal: `outreach ${q.id}`, score: 60 });

  // Tier 2: POLISH (next surface a customer touches)
  if (pulse.dashboard_smoke_red) c.push({ mode: 'polish', goal: pulse.dashboard_smoke_red.surface, score: 50 });

  // Tier 3: PLUMBING
  for (const t of pulse.failing_triggers) c.push({ mode: 'plumbing', goal: `unstick ${t.class}`, score: 40 + t.failure_count });
  if (ledger.has_recent_finding({ category: 'migration-drift', verdict: 'fail' })) c.push({ mode: 'plumbing', goal: 'reconcile schema', score: 35 });

  // Tier 4: TOOLING (only when friction tripped >=2 times)
  for (const v of ledger.tooling_friction_count_ge_2()) c.push({ mode: 'tooling', goal: `forge ${v.name}`, score: 20 });

  for (const x of c) {
    x.score += noveltyBonus(ledger, x);            // unseen scope: +10
    x.score -= recentRegressionPenalty(ledger, x); // last attempt regressed: -30
    x.score -= cadencePenalty(ledger, x);          // touched <4h ago: -50
  }
  return c.sort((a, b) => b.score - a.score);
}
```

Crude on purpose; Phase 5 sharpens it against real
`director_phase_reports` data.

## Director arc state

Two new migrations: `147-director-arcs.sql` (arcs + phase reports +
trios + rounds) and `148-founder-inbox.sql`. Numbering picks up after
`142-x-reply-drafts.sql`.

```sql
CREATE TABLE IF NOT EXISTS director_arcs (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL,
  opened_at                TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at                TEXT,
  mode_of_invocation       TEXT NOT NULL,                 -- 'autonomous' | 'founder-initiated' | 'loop-tick'
  thesis                   TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','aborted')),
  budget_max_phases        INTEGER NOT NULL DEFAULT 6,
  budget_max_minutes       INTEGER NOT NULL DEFAULT 240,
  budget_max_inbox_qs      INTEGER NOT NULL DEFAULT 3,
  kill_on_pulse_regression INTEGER NOT NULL DEFAULT 1,
  pulse_at_entry           TEXT NOT NULL,                 -- JSON snapshot at open
  pulse_at_close           TEXT,
  exit_reason              TEXT                           -- 'budget' | 'nothing-queued' | 'pulse-ko' | 'founder-returned'
);
CREATE INDEX idx_director_arcs_open ON director_arcs(workspace_id, status, opened_at DESC);

CREATE TABLE IF NOT EXISTS director_phase_reports (
  id                   TEXT PRIMARY KEY,
  arc_id               TEXT NOT NULL REFERENCES director_arcs(id),
  workspace_id         TEXT NOT NULL,
  phase_id             TEXT NOT NULL,                     -- e.g. "2026-04-18-revenue-3"
  mode                 TEXT NOT NULL CHECK (mode IN ('revenue','polish','plumbing','tooling')),
  goal                 TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('queued','in-flight','phase-closed','phase-partial','phase-blocked-on-founder','phase-aborted','rolled-back')),
  trios_run            INTEGER NOT NULL DEFAULT 0,
  runtime_sha_start    TEXT, runtime_sha_end TEXT,
  cloud_sha_start      TEXT, cloud_sha_end   TEXT,
  delta_pulse_json     TEXT, delta_ledger TEXT, inbox_added TEXT,
  remaining_scope      TEXT, next_phase_recommendation TEXT,
  cost_trios           INTEGER, cost_minutes INTEGER, cost_llm_cents INTEGER,
  raw_report           TEXT,                              -- forensic
  started_at           TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at             TEXT
);
CREATE INDEX idx_phase_reports_arc       ON director_phase_reports(arc_id, started_at DESC);
CREATE INDEX idx_phase_reports_ws_status ON director_phase_reports(workspace_id, status, started_at DESC);

CREATE TABLE IF NOT EXISTS phase_trios (
  id TEXT PRIMARY KEY, phase_id TEXT NOT NULL REFERENCES director_phase_reports(id),
  workspace_id TEXT NOT NULL, mode TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('successful','regressed','blocked','awaiting-founder','in-flight')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT
);
CREATE TABLE IF NOT EXISTS phase_rounds (
  id TEXT PRIMARY KEY, trio_id TEXT NOT NULL REFERENCES phase_trios(id),
  kind TEXT NOT NULL CHECK (kind IN ('plan','impl','qa')),
  status TEXT NOT NULL, summary TEXT NOT NULL,
  findings_written TEXT, commits TEXT, evaluation_json TEXT, raw_return TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT
);
CREATE INDEX idx_phase_rounds_trio ON phase_rounds(trio_id, started_at);
```

Why DB instead of `progress/director.md`: parallel daemons (one per
workspace) need single-writer-per-workspace SQLite. The markdown ledger
remains the human story; the DB is the machine record.

## Founder inbox semantics

GREENFIELD `founder_inbox` table in `148-founder-inbox.sql`, plus MCP
verbs `ohwow_list_founder_inbox` and `ohwow_answer_founder_inbox` under
`src/mcp-server/tools/founder-inbox.ts` and a daemon route at
`src/api/routes/founder-inbox.ts`.

```sql
CREATE TABLE IF NOT EXISTS founder_inbox (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  arc_id          TEXT REFERENCES director_arcs(id),
  phase_id        TEXT REFERENCES director_phase_reports(id),
  mode            TEXT NOT NULL,
  blocker         TEXT NOT NULL,                          -- one sentence
  context         TEXT NOT NULL,
  options_json    TEXT NOT NULL,                          -- [{label:"A",text:"..."}, ...]
  recommended     TEXT,
  screenshot_path TEXT,
  asked_at        TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at     TEXT, answer TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','resolved','expired'))
);
CREATE INDEX idx_inbox_workspace_open ON founder_inbox(workspace_id, status, asked_at DESC);
```

Detection: each Conductor tick polls `WHERE status='answered'`,
flips to `resolved`, looks up the originating `phase_id`, re-queues
that phase as `queued` with the answer spliced into its next plan
brief. Distinction from cloud `approvals` (`src/api/routes/approvals.ts`):
**approvals** are product/copy items the founder signs off on; **inbox**
is **process** decisions ("should this phase keep going", "is this
scope reasonable"). If an inbox question reduces to "approve this
draft", Director uses the existing approval flow instead.

## Migration / coexistence plan

| New tier | Replaces / augments | A/B safety |
|----------|--------------------|------------|
| Conductor | Augments `ImprovementScheduler.execute()` decision logic. Replaces nothing. | Ships behind `OHWOW_AUTONOMY_CONDUCTOR=1`, off by default. When off, the 24h gate stays. |
| Director | New layer; nothing fills this role today. | New tables only; old paths unaffected. |
| Phase orchestrator | New layer. Closest analog: `src/orchestrator/sequential/sequence-decomposer.ts` (decomposes *one user prompt* into agent steps; does not span multiple trios). | Each phase is one async task under the daemon; writes only new tables + standard mode sub-files. |
| Trio | New layer composing `sub-orchestrator.ts` calls. | Pure code; no schema dependency to break. |
| Round | Reuses `src/orchestrator/sub-orchestrator.ts`. Tooling rounds that self-commit go through `safeSelfCommit` (`src/self-bench/self-commit.ts`). | Existing experiment-author already exercises this path. |

Phase order is fixed: (1) this doc, (2) trio + round-runner, (3) phase
orchestrator + `phase_trios`/`phase_rounds`, (4) Director +
`director_arcs`/`director_phase_reports`/`founder_inbox`, (5) Conductor
+ ranker behind flag, (6) evaluation harness, (7) cautious
self-modification expansion (extend `safeSelfCommit` allowlist + path
trust tiers so tooling-phase rounds can land daemon code under tighter
audit, not just `src/self-bench/experiments/`). The flag flips only
after Phase 6 passes.

## What this arc deliberately does NOT change in Phase 1-7

- `safeSelfCommit` kill switch (`~/.ohwow/self-commit-enabled`), path
  allowlist, new-file-only constraint, audit log shape. Phase 7
  *expands* the allowlist; the kill switch stays.
- `diary-hook` (the `diary.jsonl` writer that
  `reflection-consolidator.ts` reads).
- `LocalScheduler` cron evaluation and `HeartbeatCoordinator` per-agent
  ticks. Conductor sits alongside, not in front of, them.
- X intelligence automations and their seeding (`src/scheduling/x-*`).
  Revenue lens consumes their drafts; it does not touch their schedules.
- `self_findings`, `experiment_validations`, `business_vitals` schema.
  Conductor reads these; nothing in the arc writes there except via
  existing experiment paths.
- `ImprovementScheduler` consolidation pass during deep_sleep. Phase 5
  wires Conductor as a consumer of `improvement_cycle_*` events, not a
  replacement.

## Open questions for the founder

1. **Conductor process placement.** In-process inside the daemon
   (simple, shares the SQLite handle, dies with the daemon) or as a
   separate worker (isolated crashes, restartable independently)? This
   doc assumes in-process; switching to a worker doubles the migration
   surface in Phase 5.
2. **Cloud rendering of `founder_inbox`.** Render inbox rows in the
   cloud dashboard alongside `approvals`, or stay local-only and
   surface only in the TUI? Local-only ships sooner; cloud needs a sync
   path through `control-plane/client.ts` that does not exist for these
   tables yet.
3. **Mode lens source of truth.** The skill ships lens prose as
   markdown under `.claude/skills/be-ohwow/briefs/`. Should the runtime
   (a) duplicate them as TS string constants under
   `src/autonomy/lenses/`, (b) read them at boot from the skill
   directory, or (c) push a copy into the runtime repo and accept
   drift? Option (b) keeps skill and runtime in lockstep but breaks
   every fresh install that lacks the skill on disk.
