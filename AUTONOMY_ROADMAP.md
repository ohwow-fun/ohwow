AUTONOMY_ROADMAP.md

Single source of truth for the ohwow autonomous self-improvement loop.
This is the top-level index. Always read this first.

**Telos**: ohwow must generate revenue. Autonomy is the mechanism, not the goal.
Every experiment ships either to move money directly (outreach, pricing,
conversion, retention) or to make money-moving experiments cheaper and
safer to run. If a change can't be traced to one of those two, it is
cosmetic and should not compete with money work for author-queue slots.

**Companion files** (kept small on purpose):
- [roadmap/gaps.md](roadmap/gaps.md) — prioritized Known Gaps (P0…P4).
- [roadmap/iteration-log.md](roadmap/iteration-log.md) — chronological
  Recent Iterations, newest first.

---

## 1. Current System State (as of 2026-04-16T22:15Z, money-telos foundations landed)

### Architecture Summary

```
┌──────────────────────────────────────────────────────────────┐
│  ExperimentRunner (60s tick)                                 │
│    for each due experiment:                                  │
│      probe() → judge() → intervene() → writeFinding()       │
│                  ↓ if intervention applied:                  │
│              enqueue validation (delay: 5min default)        │
│                  ↓ when validate_at passes:                  │
│              validate() → if failed → rollback()            │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  TWO PULSES (hourly, runOnBoot with same-hour dedupe)        │
│                                                              │
│  RevenuePulse       ─ outcome-side: 24h/7d/MTD revenue,     │
│                       outreach in/out DMs + reply ratio,    │
│                       pipeline counts, burn vs revenue,     │
│                       Next Move naming the highest-leverage  │
│                       revenue lever for the current shape.  │
│                                                              │
│  OpsPulse           ─ process-side: snapshot of every ops    │
│                       knob in OPS_KNOBS (x-compose target,  │
│                       weekly deficit, burn cap), + live      │
│                       dispatch/approval rates, + Next Move  │
│                       naming the highest-leverage ops lever.│
│                                                              │
│  DailySurpriseDigest ─ once/day narrative: top distilled    │
│                        insights + strategy overrides. Both  │
│                        pulses feed into it.                 │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Proposal-Generator Ranker (priority → roadmap → revenue     │
│                             → fifo)                          │
│                                                              │
│  Experiment proposals enter a four-bucket queue:             │
│    priority — strategy.priority_experiments (operator set)   │
│    roadmap  — strategy.roadmap_priorities (observer tokens)  │
│    revenue  — slug/name/template/hypothesis matches any of   │
│               REVENUE_KEYWORDS (money telos auto-boost)      │
│    fifo     — everything else (paper-derived observers etc.) │
│                                                              │
│  Within a bucket: oldest-first. Across buckets: top wins.    │
│  The revenue bucket is always on — no per-workspace wiring.  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Research Loop (paper → code, paper-cited autonomous commit) │
│                                                              │
│  research-ingest-probe   ─ 15min: arXiv abstracts ingested  │
│                            into knowledge_documents          │
│  code-paper-compare-probe─ 30min: grep repo for paper      │
│                            concepts, emit gap findings       │
│  experiment-proposal-   ─ inlines abstracts + gaps into LLM │
│   generator               prompt, emits cites_papers field  │
│  experiment-author       ─ LLM authors new .ts probe, gate  │
│                            chain (typecheck/vitest/AST)     │
│                            passes, safeSelfCommit lands with │
│                            Cites-Research-Paper trailer      │
│                                                              │
│  First close: d875907 on 2026-04-16 — Cites-Research-Paper: │
│  2409.02228v1 (Unforgettable Generalization in LMs).        │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Self-Modification Loop (Tier-2 patches, every 5min)         │
│                                                              │
│  PatchAuthorExperiment.probe()                               │
│    → scan self_findings for warning|fail                     │
│    → filter to tier-2 affected_files                         │
│    → verify violation literals appear in source              │
│       (relaxed to length ≥ 1 for deterministic copy-lint     │
│       rules that carry a ruleId — prior ≥ 3 floor silently   │
│       filtered out every em-dash warning)                    │
│    → skip (finding,file) shapes already reverted in window   │
│                                                              │
│  PatchAuthorExperiment.intervene() [if kill switches open]   │
│    → pick one candidate per tick                             │
│    → LLM call (whole-file or string-literal edits)           │
│    → safeSelfCommit() [9-layer gate]:                        │
│        L1 kill switch · L2 Fixes-Finding-Id trailer ·        │
│        L3 patch-invariants (vitest) · L4 AST bounds ·        │
│        L5 cool-off watcher · L7 daily budget cap ·           │
│        L9 path trust tiers                                   │
│    → git commit --only (atomic scope)                        │
│                                                              │
│  Auto-followup: every patch emits a pre/post verdict row     │
│   after a brief delay, giving the loop immediate signal on   │
│   whether the finding's underlying warning actually cleared. │
└──────────────────────────────────────────────────────────────┘
```

### Trust Boundaries

| Tier | Paths | What autonomous code can do |
|------|-------|----------------------------|
| tier-1 | `src/self-bench/experiments/`, `src/self-bench/__tests__/`, `auto-registry.ts`, migration/toolchain registries | Create NEW files only. Never modify existing. |
| tier-2 (whole-file) | `src/lib/format-duration.ts`, `src/lib/token-similarity.ts`, `src/lib/stagnation.ts`, `src/lib/error-classification.ts`, `src/lib/outreach-policy.ts`, `AUTONOMY_ROADMAP.md`, `roadmap/gaps.md`, `roadmap/iteration-log.md` | Replace entire file. 1 top-level symbol changed (L4 gate). |
| tier-2 (string-literal) | `src/web/src/pages/`, `src/web/src/components/ErrorBoundary.tsx`, `src/self-bench/experiments/outreach-thermostat.ts` | Only string literal / JSX text node values may differ. Structure/imports/identifiers frozen (L4 gate). |
| tier-3 | Everything else — including most of the sales loop (x-authors-to-crm, classifier, templates, scheduler, CRM ops) | Humans only. |

**Note on tier-2 balance**: the tier-2 set now carries two revenue-adjacent
files: `outreach-thermostat.ts` (draft-message copy, string-literal) and
`outreach-policy.ts` (cooldown gate, whole-file, landed 2026-04-16 with the
`outreach-policy-fuzz` invariant probe). Together they give the loop both
copy knobs and policy knobs in the outreach path. Further widening — into
x-authors-to-crm, classifier thresholds, and outreach cadence config — is
still queued as Phase 1 continuation work.

### Key Experiments Running

Inventory is maintained by `roadmap-updater` in Section 5. The experiments
that carry the money telos most directly:

- **RevenuePulseExperiment** — hourly money outcomes + Next Move
- **OpsPulseExperiment** — hourly ops-knob snapshot + Next Move
- **DailySurpriseDigestExperiment** — daily narrative, reads both pulses
- **revenue-pipeline-observer, attribution-observer, burn-rate** — the underlying measurements the pulses aggregate
- **outreach-thermostat** — tier-2 draft-message copy the loop can patch (string-literal)
- **outreach-policy** — tier-2 cross-channel cooldown gate the loop can patch (whole-file), fuzzed by `outreach-policy-fuzz`
- **lift-measurement** — Phase 5 credit-assignment probe (10 min cadence). Closes pending `lift_measurements` rows at their horizon, computes `signed_lift` against the KPI registry, and emits per-commit verdicts (`moved_right` / `moved_wrong` / `flat` / `unmeasured`). Fed by `Expected-Lift:` trailers on any `safeSelfCommit` that declared them; the ranker will read the rolling distribution in Phase 5b.

See [roadmap/gaps.md](roadmap/gaps.md) for the prioritized backlog.

---

## 2. Active Focus
**Honest read of 2026-04-16T22:15Z:**

- 24h autonomous commits: 51. 24h reverts: 1 (hand-done, for a cosmetic
  regression the loop would have left standing).
- Paper-cited autonomous commits in 24h: 6. The research→code loop is
  real and recurrent.
- **24h revenue: $0. 7d revenue: $0. Active customers: 0. Daily LLM burn: ~$34.**

The self-modification loop works. It landed ~50 autonomous commits in a day
and they held. But almost all of that work is cosmetic (em-dash rewrites,
roadmap self-maintenance, new research-cited observer probes that don't
change ohwow's behavior). Meanwhile ohwow made no money. That mismatch is
the thing to fix — not the autonomy machinery, which is sound.

This session landed the first three foundations of the money-telos phase:

1. **RevenuePulseExperiment** (hourly) — one row per hour showing realized
   revenue, outreach volume, pipeline, burn, and a heuristic-picked Next
   Move naming the highest-leverage revenue lever. Verdict is load-bearing
   (fails when revenue = $0 and burn > $0 and outreach is under-dispatching).

2. **Revenue bucket in the proposal ranker** (experiment-author). Proposals
   whose slug/name/template/hypothesis contain any REVENUE_KEYWORDS token
   (revenue, sales, outreach, classifier, thermostat, attribution, …)
   jump ahead of FIFO but still sit behind explicit priority/roadmap
   overrides. Paper-derived observer probes no longer compete on equal
   footing with "why did reply rate drop?".

3. **ops-knobs registry + OpsPulseExperiment** (hourly) — process-side
   complement to RevenuePulse. Declares operational levers as structured
   knobs (x_compose weekly target, weekly deficit, burn cap placeholder)
   so a future mutation experiment has a named, stable contract to target.
   No mutation yet — visibility first.

**What this session did NOT do (yet):**

- The sales loop (x-authors-to-crm classifier, outbound templates, CRM
  handoff) is all tier-3 still. The loop can see it but cannot heal it.
- There is no enforced burn cap. `experiment-cost-observer` ranks spend;
  nothing throttles it. Paper probes can still outspend the revenue loop.
- There is no real-revenue ingest (webhook/manual ledger). RevenuePulse
  reads `agent_workforce_revenue_entries` which is empty, so every row
  currently says "Result: $0.00 in last 24h" and points at outreach
  volume as the first lever. That's correct for where we are, but the
  loop needs to see actual dollars for its Next Move logic to sharpen.

## 3. Next Steps
### Phase 2 (next session) — give the loop something to act on

1. **Widen tier-2 to cover the sales-loop copy surface.**
   Target, one at a time, each paired with a fuzz/invariant probe:
   - x-authors-to-crm prompt templates (string-literal mode)
   - outreach-thermostat.ts message templates (already tier-2; add a
     property fuzz that emits affected_files on regressions)
   - classifier thresholds and their exported constants
   Each expansion adds a named REVENUE_KEYWORDS-matching slug for the
   fuzz probe, so the revenue bucket immediately has fuel.

2. **Budget guard experiment.**
   Wire `burn.daily_cap_cents` as a real knob (env var + runtime-config
   override). OpsPulse already names it as the foundation gap. Route
   experiment-cost-observer's ranked non-revenue spenders into an
   automatic throttle when the cap is breached. Paper probes and other
   high-cost low-revenue-adjacency experiments become opt-in above the cap.

3. **Proposal-generator revenue focus.**
   Extend the proposal generator to consume RevenuePulse's `next_move`
   string as context in its LLM prompt. Today the generator inlines
   arXiv abstracts and code-paper gaps; add the current revenue Next
   Move as a first-class input so new proposals are shaped by "what
   would move the needle" rather than paper concepts alone.

### Phase 3 — close the outcome loop

4. **Real-revenue ingest.** A webhook or a one-keystroke CLI
   (`ohwow revenue add 5000 --contact X --note "..."`) so the system
   can see actual dollars move. Without this, RevenuePulse is
   optimizing proxies. With it, the full outcome feedback closes:
   outreach change → reply-rate shift → qualified event → revenue row
   → next-hour pulse sees the delta → next author tick reasons over it.

5. **Ops-knob mutator experiment.** A Phase-2-depedent step. Once
   tier-2 covers the sales copy and the budget guard is in place,
   add an experiment that reads ops-pulse warnings and proposes knob
   deltas (with a Fixes-Finding-Id receipt against the specific
   warning). Same safety envelope as patch-author; new tier-2
   surface = OPS_KNOBS entries.

### Long-term (do not rush)

6. Deterministic patch replay / pre-commit simulation (P3).
7. Multi-file patch coordination across the sales loop.
8. User-impact metrics (session duration, feature adoption) once
   revenue signal is established.

---

_Iteration history lives in [roadmap/iteration-log.md](roadmap/iteration-log.md)._

## 4. Known Gaps

### P0 — Telos Blindness (NEW, this session)

The loop was optimizing cosmetic surfaces while ohwow earned $0. The
machinery is sound; the targeting was misaligned. **Partially closed
this session** by RevenuePulse + revenue bucket + OpsPulse. Remaining:
sales-loop tier-2 surface, budget guard, real-revenue ingest (see
Phase 2/3 above). Until those land, the loop can see the money problem
but cannot act on it autonomously.

### P0 — No Enforced Budget (NEW)

Daily LLM burn runs ~$34 with $0 revenue. `experiment-cost-observer`
ranks spend; `burn-rate` summarizes it; nothing caps it. A paper-derived
observer probe can outspend the outreach loop with no gate. Phase 2
step #2 wires the cap.

### P1 — Sales-Loop is Tier-3

Every lever that could move conversion (classifier, templates,
scheduler, CRM handoff) is humans-only. The revenue bucket can prefer
revenue-keyword proposals all day; if the one tier-2 revenue file is
outreach-thermostat, the author is still mostly writing new observers.
Phase 2 step #1 fixes this one file at a time.

### P1 — No Post-Patch Immediate Verification (REDUCED)

Originally P1. The auto-followup pre/post verdict rows now land within
~30s of each patch (visible in every patch-author tick), giving immediate
signal on whether the warning cleared. Synchronous in-commit reverify
is still missing; the reduced version of this gap is "the loop sees the
verdict, but can't block a commit on it before Layer 5 cool-off runs".

### P2 — Browser Testing Is Observe-Only (UNCHANGED)

`dashboard-smoke` walks all routes and emits `issues[]` with runtime
error messages. Not `violations[]` with literal text. PatchAuthor's
literal-in-source filter correctly skips them. Browser bugs are logged
but never self-healed.

### P3 — Deterministic Experiment Execution (UNCHANGED)

No way to replay a single experiment run against a specific commit.
Non-determinism from live DB + FS state. Replayability would let us
validate that a patch actually fixes its finding before committing.

### P4 — Real-World Impact Metrics (now = Phase 3 step #4)

Moved up from "intentionally deferred" to Phase 3 as a concrete
work item (real-revenue ingest). Without it, every money-telos
signal above is running on proxies.

## 5. Experiment Inventory

_Maintained by RoadmapUpdaterExperiment from live loop state._

- **adaptive-scheduler** — tier-1: creates new files only
- **agent-cost-watcher** — tier-1: creates new files only
- **agent-coverage-gap** — tier-1: creates new files only
- **agent-lock-contention** — tier-1: creates new files only
- **agent-outcomes** — tier-1: creates new files only
- **agent-state-hygiene-sentinel** — tier-1: creates new files only
- **analogical-reasoning-emergence-signal-v3** — tier-1: creates new files only
- **anthropic-claude-sonnet-4-6-latency** — tier-1: creates new files only
- **autonomous-author-quality** — tier-1: creates new files only
- **autonomous-patch-rollback** — tier-1: creates new files only
- **browser-profile-guardian** — tier-1: creates new files only
- **burn-guard** — tier-1: creates new files only
- **canaries** — tier-1: creates new files only
- **canary-experiment** — tier-1: creates new files only
- **classifier-stability** — tier-1: creates new files only
- **contact-conversation-analyst** — tier-1: creates new files only
- **content-cadence-loop-health** — tier-1: creates new files only
- **content-cadence-tuner** — tier-1: creates new files only
- **daily-surprise-digest** — tier-1: creates new files only
- **dashboard-copy** — tier-1: creates new files only
- **deepseek-deepseek-v3-2-latency** — tier-1: creates new files only