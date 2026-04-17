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

## 1. Current System State (as of 2026-04-17T13:24Z, money-telos foundations landed)

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
**Honest read of 2026-04-17T13:24Z (outcome loop live):**

- **Outcome feedback is now wired end-to-end.** Every autonomous patch
  to a revenue-adjacent tier-2 file records a `lift_measurements` row at
  commit time with baseline KPI value + `Expected-Lift:` trailer, gets
  re-measured at 24h / 168h, and closes with `moved_right` / `moved_wrong`
  / `flat` / `unmeasured`. The strategist reads the 7d rolling
  distribution and demotes `patch-author` when the net signed ratio
  falls below -0.2 (with a 5-sample floor). The loop can finally see
  whether its commits produce value, not just whether they pass gates.
- **Revenue ingest is real.** `ohwow revenue add` writes to
  `agent_workforce_revenue_entries`; Stripe webhook already did the
  automated lane. `kpi-registry.ts` is the single reader for all 11
  outcome KPIs (revenue 24h/7d/mtd, reply_ratio, qualified events,
  active leads/customers, burn, signal_spend_ratio, ...).
- **Sales-loop tier-2 widening has started.** `outreach-policy.ts` is
  now tier-2 whole-file with an `outreach-policy-fuzz` probe emitting
  `affected_files` on invariant regressions (cooldown range, resolver
  positivity, event-kind set). Paired with existing `outreach-thermostat`
  (string-literal copy), the revenue bucket now has two live targets.

**Why the gap closed:** before this session, the autonomous author
landed ~50 commits/day and every one was presumed "held" based on
absence of regression. The `Expected-Lift` + `lift_measurements` pipeline
makes outcome the actual loss signal — the strategist can now tell
`patch-author` to back off when commits are hurting KPIs, not just
when they're failing tests.

**What this still does NOT do (yet):**

- The strategist's 7d lift window is empty today; the first real
  `moved_right` / `moved_wrong` closure fires 24-168h after the first
  autonomous `outreach-policy.ts` or `outreach-thermostat.ts` patch
  lands. Until then, the lift branch is dormant (logged but doesn't
  demote).
- The value-ranker's weights are still hand-tuned constants. Learning
  them from the observed lift distribution is the next step
  (`Phase 5d`).
- No A/B `Trial` primitive yet — a patch is still a single variant
  landed without a counterfactual. A proper experimentation primitive
  (split, outcome, winner) is the biggest remaining structural gap
  (`Phase 2`).
- x-authors-to-crm classifier + CRM handoff stay tier-3.
- **Live state note:** 69 experiments are missing from the roadmap
  (e.g., `content-cadence-tuner`, `daily-surprise-digest`,
  `dashboard-copy`, `deepseek-deepseek-v3-2-latency`,
  `deliverable-action-sentinel`, `device-audit`,
  `error-classification-fuzz`, `experiment-proposal-generator`,
  `findings-gc`, `format-duration-fuzz`, `git-velocity`,
  `google-gemini-2-5-flash-latency`,
  `google-gemini-3-1-pro-preview-latency`, `handler-schema-drift`,
  `intervention-audit`, `ledger-health`, `list-completeness-summary`,
  `list-handlers-fuzz`, `loop-cadence-probe`, `mig-smoke-1776324117308`,
  `mig-smoke-1776428209741`, `migration-drift-sentinel`,
  `migration-schema-probe`, `model-health`, `next-step-dispatcher`,
  `observation-probe`, `ops-pulse`, `outreach-copy-fuzz`,
  `patch-loop-health`, `prose-invariant-drift`, `provider-availability`,
  `pseudo-rgb-d-slam-observation-drift`, `qwen-qwen3-5-35b-a3b-latency`,
  `reasoning-alignment-drift-under-rl-fine-tuning`, `revenue-pulse`,
  `rl-fine-tuning-reasoning-drift`, `roadmap-observer`,
  `roadmap-shape-probe`, `scrape-diff-probe`, `sitemap-drift`,
  `source-copy-lint`, `stagnation-fuzz`, `stale-task-cleanup`,
  `stale-threshold-tuner`, `string-literal-patch`,
  `subprocess-smoke-1776373235416`, `subprocess-smoke-1776389032972`,
  `test-coverage-probe`, `throughput-daily`,
  `tmpl-smoke-1776361920501`, `token-similarity-fuzz`,
  `toolchain-lint`, `toolchain-test-probe`, `toolchain-tests`,
  `toolchain-typecheck`, `trigger-stability`,
  `unforgettable-generalization-drift-probe`,
  `unforgettable-generalization-signal`,
  `unforgettable-generalization-signal-probe`, `unknown-latency`,
  `vitest-health-probe`, `x-autonomy-ramp`,
  `x-dm-dispatch-config-fuzz`, `x-dm-signals-rollup`,
  `x-engagement-observer`, `x-ops-observer`, `x-shape-tuner`,
  `xiaomi-mimo-v2-flash-latency`, `xiaomi-mimo-v2-pro-latency`).
  These need to be integrated into the roadmap for full coverage.

## 3. Next Steps
### Phase 5d — ranker learns weights from lift distribution

The strategist now *uses* lift data to demote patch-author on systemic
regression. The next layer is the value-ranker: instead of hand-tuned
weights on `revenue_proximity` / `evidence_strength` / `blast_radius` /
`recency`, update the coefficients from the observed
`moved_right` / `moved_wrong` split per score component. Start with a
simple multiplicative adjustment (each component's weight × recent
moved_right share for candidates where that component was dominant)
before committing to anything more elaborate.

### Phase 2 — A/B Trial primitive

Biggest remaining structural gap. Today every "experiment" is
`probe + judge`. Build `Trial { variants, splitKey, metricId,
minSamples, decisionRule }` plus `trials` table + `TrialAssigner` +
`TrialEvaluator`. Retrofit outreach-thermostat templates and x-reply
as the first two trials, each splitting by `contact_id` or
`thread_id` and measuring `reply_ratio_24h` / `qualified_events_24h`.

### Phase 1 continuation — widen tier-2 further

`outreach-policy.ts` landed. Next targets, each paired with a fuzz probe:
- x-authors-to-crm prompt templates (string-literal mode; .mjs, so
  the L4 AST gate is a no-op — tier-2 path + fuzz still protects)
- classifier thresholds + exported constants
- outreach dispatch cadence config

### Phase 3 — operator visibility

TUI/web widget that reads the latest `lift-measurement` finding and
shows `moved_right` / `moved_wrong` / `flat` per recent autonomous
commit. Right now the data lands in `self_findings`; operators need
to grep. A small evolution-cockpit addition fixes that.

### Long-term (do not rush)

- Deterministic patch replay / pre-commit simulation (roadmap P3).
- Multi-file patch coordination across the sales loop.
- Ops-knob mutator experiment (reads OpsPulse warnings → proposes
  knob-delta patches with Fixes-Finding-Id receipts).

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
revenue-keyword proposals