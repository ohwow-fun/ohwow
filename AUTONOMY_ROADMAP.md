# AUTONOMY_ROADMAP.md

Single source of truth for the ohwow autonomous self-improvement loop.
Updated by agents and humans who pick up this work. Always read this first.

---

## 1. Current System State (as of 2026-04-15T16:15Z, loop active + roadmap-aware)

### Architecture Summary

```
┌──────────────────────────────────────────────────────────────┐
│  ExperimentRunner (60s tick)                                 │
│                                                              │
│  for each due experiment:                                    │
│    probe() → judge() → intervene() → writeFinding()         │
│                ↓ if intervention applied:                    │
│            enqueue validation (delay: 5min default)          │
│                ↓ when validate_at passes:                    │
│            validate() → if failed → rollback()              │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Self-Modification Loop (Tier-2 patches, every 5min)         │
│                                                              │
│  PatchAuthorExperiment.probe()                               │
│    → scan self_findings for warning|fail                     │
│    → filter to tier-2 affected_files                         │
│    → verify violation literals appear in source              │
│    → surface candidates                                      │
│                                                              │
│  PatchAuthorExperiment.intervene() [if kill switches open]   │
│    → pick one candidate per tick                             │
│    → LLM call (whole-file or string-literal edits)           │
│    → safeSelfCommit() [9-layer gate]:                        │
│        L1: kill switch (~/.ohwow/self-commit-enabled)        │
│        L2: Fixes-Finding-Id trailer required for tier-2      │
│        L3: patch-invariants (vitest passes)                  │
│        L4: AST bounds (1 symbol for whole-file;              │
│               only string literals changed for string-lit)   │
│        L5: cool-off watcher (see below)                      │
│        L7: daily budget cap (1440/day)                       │
│        L9: path trust tiers                                  │
│    → git commit --only (atomic scope)                        │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Layer 5 Rollback Watcher (every 5min)                       │
│                                                              │
│  scan git log for patches within 10min cool-off window       │
│  for each patch: check if finding re-fired AFTER commit      │
│    → same experiment_id + same subject                       │
│    → same violation LITERALS present in refire evidence      │
│    → if matched: git revert + push                           │
└──────────────────────────────────────────────────────────────┘
```

### Trust Boundaries

| Tier | Paths | What autonomous code can do |
|------|-------|----------------------------|
| tier-1 | `src/self-bench/experiments/`, `src/self-bench/__tests__/`, `auto-registry.ts`, migration/toolchain registries | Create NEW files only. Never modify existing. |
| tier-2 (whole-file) | `src/lib/format-duration.ts`, `src/lib/token-similarity.ts`, `src/lib/stagnation.ts`, `src/lib/error-classification.ts` | Replace entire file. 1 top-level symbol changed (L4 gate). |
| tier-2 (string-literal) | `src/web/src/pages/`, `src/web/src/components/ErrorBoundary.tsx` | Only string literal / JSX text node values may differ. Structure/imports/identifiers frozen (L4 gate). |
| tier-3 | Everything else | Humans only. |

### Key Experiments Running

- **PatchAuthorExperiment** — LLM patch authoring from findings (every 5min). Now reads AUTONOMY_ROADMAP.md as context.
- **AutonomousPatchRollbackExperiment** — Layer 5 cool-off watcher (every 5min, 10min cool-off window)
- **PatchLoopHealthExperiment** — hold_rate + pool delta convergence monitor (every 5min)
- **DashboardSmokeExperiment** — headless browser walk of all routes (every 5min)
- **DashboardCopyExperiment / SourceCopyLintExperiment** — copy rules violation detection (every 5min)
- **AdaptiveSchedulerExperiment** — dynamic cadence adjustment
- **MigrationSchemaProbeExperiment** — per-migration schema validation
- **ToolchainTestProbeExperiment** — per-tool test execution
- Multiple latency monitors (Anthropic, DeepSeek, Google, Qwen, Xiaomi)

---

## 2. Known Gaps (Prioritized)

### P0 — Loop Convergence is Unobservable
The system is generating patches and reverting them, but there is no aggregate
metric for "is the violation pool shrinking?" or "what % of patches are holding?"
Without this, we cannot tell if the system is making progress or thrashing.

**Symptoms**: 8 revert commits in 3 days; Layer 5 required 4 bugfixes in same window.
**Risk**: The latest Layer 5 fix (`ae52755`, literal-level intersection) may resolve
the oscillation — but we have no way to confirm convergence without a health metric.

### P1 — No Post-Patch Immediate Verification
After landing a string-literal patch on a `pages/` file, the system waits up to
10min for the next copy-lint run to tell it whether the violation is gone. This
creates a lag window where Layer 5 could fire on a partially-effective patch
even though most violations were fixed. A synchronous post-patch re-scan of the
patched file would give immediate signal and prevent unnecessary reverts.

### P2 — Browser Testing Is Observe-Only
DashboardSmokeExperiment exists and walks all routes, but its findings never
flow into the patch pipeline. Tier-2 pages/ promotion was intended to bridge
this, but the DashboardSmoke findings don't carry `violations[]` arrays with
literal text — they carry `issues[]` with runtime error messages. The
PatchAuthorExperiment's literal-in-source filter correctly skips these.
Result: browser bugs are logged but never self-healed.

### P3 — Deterministic Experiment Execution (Replayability)
There is no way to replay a single experiment run against a specific commit and
get deterministic output. Non-determinism comes from: (a) LLM temperature > 0
(currently 0, so OK), (b) live DB state at probe time, (c) file system state.
Replayability would enable: validating that a patch actually fixes its finding
before committing it, regression testing the patch pipeline.

### P4 — Business Metric Integration
The system can fix copy violations and tool reliability issues. It has no
visibility into: user-facing conversion rates, session durations, feature
adoption, or any real-world impact metric. This is intentionally deferred.

---

## 3. Active Focus

**Loop is converging. Watching hold_rate recover as old reverts age out.**

As of 2026-04-15T16:15Z:
- 6 patches landed in the 24h window, 4 reverted (hold_rate=33%) — but the 4
  reverts are ALL pre-session (oscillation era). The 2 patches from this session
  (Agents.tsx, Dashboard.tsx) have both held. A third patch (FlowBuilder.tsx) is
  expected on the next cycle.
- The old 4 reverts will age out of the 24h window by ~2026-04-16T09-13. After
  that, hold_rate should jump to 100% (all current-era patches holding).
- Violation pool: 3 remaining open violations (FlowBuilder.tsx "Something went
  wrong", ErrorBoundary.tsx was fixed manually and promoted to tier-2).
- PatchAuthorExperiment now reads this roadmap as LLM context — the model is
  strategically aware of the loop goal.

**Roadmap in the loop — phased design:**

Layer A (done): Read-only roadmap context injected into PatchAuthor LLM prompt.
  The model sees sections 2 (Known Gaps) + 3 (Active Focus) before generating
  each patch. Makes patches more likely to hold because the model understands
  the auto-revert mechanism and the convergence goal.

Layer B (next): RoadmapObserverExperiment (tier-1). Reads PatchLoopHealth
  findings + recent interventions, writes a proposed iteration log entry to
  AUTONOMY_LOOP_NOTES.md (a new tier-1 file). The system accumulates its own
  loop observations in its own voice. A human or future upgrade merges them
  into this roadmap.

Layer C (later): Promote AUTONOMY_ROADMAP.md to tier-2 whole-file mode once
  hold_rate is consistently >0.8 for 48h. The system earns write access to
  its own goal document.

---

**P0 (completed): Loop Convergence Health Monitor**

Add a new experiment (`PatchLoopHealthExperiment`) that measures:
1. Patches landed in last 24h (autonomous commits with Fixes-Finding-Id)
2. Reverts in last 24h (revert commits with Auto-Reverts)
3. Hold rate = (landed - reverted) / landed
4. Violation pool trend: count of distinct `(experiment_id, subject)` pairs with
   active warning|fail findings today vs. yesterday

Verdict logic:
- hold_rate < 0.5 → fail (more than half of patches are being reverted — loop is thrashing)
- hold_rate 0.5–0.8 → warning (learning, acceptable)
- hold_rate > 0.8 → pass (converging)

This experiment is tier-1 (new file only), observe-only, no intervene. It gives
us the signal to know if the latest Layer 5 fix resolved the oscillation, and
will be the early-warning system for future regressions in the patch loop.

---

## 4. Iteration Log

### 2026-04-15T16:15 — Roadmap awareness + tier-2 expansion

**What was done**:
1. Fixed X posting auth bug in `tool-executor.ts` — was skipping profile setup when
   browser service already active; now always calls `ensureDebugChrome` + `openProfileWindow`
   from chrome-profile-router and passes `expectedHandle` to `composeTweetViaBrowser`.

2. Fixed `ErrorBoundary.tsx` fallback copy (was "Something went wrong", now "Something broke
   on this page") and promoted the file to tier-2 string-literal mode so future violations
   auto-fix. Also made `PatchLoopHealthExperiment` derive its tier-2 prefix list from the
   authoritative registry instead of a hardcoded copy.

3. Injected AUTONOMY_ROADMAP.md as read-only context into `PatchAuthorExperiment`'s LLM
   prompt (sections 2+3 only — gaps + active focus, not the full log). The model now
   knows about the auto-revert mechanism, the hold_rate target, and the P1 gap before
   authoring each patch.

4. Answered the "roadmap in the loop" question with a 3-layer design (A=done, B+C=next).

**Observed loop behavior**:
- Agents.tsx "Couldn't create agent. Try again?" patch held (commit `6612c78`).
- Dashboard.tsx em dash → ". " patch held (commit `6cf7a93`).
- hold_rate=33% is temporarily dragged down by 4 pre-session reverts; will recover as
  they age out of the 24h window overnight.
- FlowBuilder.tsx "Something went wrong" still pending the next patch cycle.

**Decision**: Continue at 5min cadences. Observe hold_rate recovery overnight.
If hold_rate reaches >0.8 by 2026-04-16 morning, begin Layer B (RoadmapObserverExperiment).

---

### 2026-04-15T10:40 — Accelerated cadences

**What was attempted**: Sped up all key experiment cadences from 10–30min to 5min,
tightened validation delay from 15min → 5min, tightened Layer 5 cool-off from
30min → 10min. Restarted daemon. Now in live observation mode.

**Why**: Operator wants to compress the feedback loop to minutes, not hours, to
observe convergence (or thrashing) in real time rather than waiting 24–48h.

**Changes made**:
| Experiment | Before | After |
|---|---|---|
| SourceCopyLintExperiment | 30min | 5min |
| DashboardCopyExperiment | 15min | 5min |
| PatchAuthorExperiment | 10min | 5min |
| DashboardSmokeExperiment | 10min | 5min |
| PatchLoopHealthExperiment | 30min, no boot | 5min, runOnBoot |
| DEFAULT_VALIDATION_DELAY_MS | 15min | 5min |
| COOLOFF_WINDOW_MS (Layer 5) | 30min | 10min |

**Expected cycle at steady state** (all 5min):
```
T+0:  SourceCopyLint fires → finds violations in pages/ → emits warning findings
T+5:  PatchAuthor picks up findings → LLM call → safeSelfCommit → patch lands
T+10: SourceCopyLint re-fires → violations gone? → pass (held) or refire (bad patch)
      Layer 5 watcher fires → if refire with same literal → revert
T+15: PatchLoopHealth fires → hold_rate updated
```

**Risks at 5min cadence**:
- LLM call + typecheck + vitest in PatchAuthor takes 30–90s per run; the 5min
  cadence gives it enough runway without double-firing (inFlight guard handles this).
- If DashboardCopy (browser-based) is slow, it could overlap with its next tick.
  The inFlight guard prevents double-fire. Monitor for `browser_error` findings.
- The 10min cool-off window is exactly 2 probe cycles. If SourceCopyLint is slow
  to boot, a legitimate re-fire might land at T+11 and miss the window. Monitor
  for "patch held but violation still present" patterns.

**Decision**: Keep — watch PatchLoopHealth hold_rate over the next 30–60min.
If hold_rate drops below 0.5 (loop thrashing), revert cadence changes.

---

### 2026-04-15 — Initial Audit

**What was attempted**: Full codebase audit of last 3 days of commits + key file reads.

**What we learned**:

The system is active and running with real autonomous patch cycles. Key findings:

1. **Oscillation was the primary instability signal**. All 8 reverts trace to
   Agents.tsx patches from source-copy-lint findings. Root cause: Layer 5's refire
   detection was keyed on `(experiment_id, subject)` pairs only. A patch that fixed
   one of N violations in a file would cause the experiment to re-fire (correctly —
   there were still N-1 violations), and Layer 5 would see "same subject re-fired"
   as "patch failed" and revert it, even though the patch DID fix something.

2. **`ae52755` appears to be the correct fix**. The new logic intersects on
   violation LITERALS: a refire only triggers rollback if the SPECIFIC LITERAL
   the patch addressed is still present in the refire's evidence.violations[].
   This means a patch that fixes violation A in a file with violations [A, B, C]
   will NOT be reverted when the experiment re-fires about [B, C].

3. **Layer 5 itself needed 4 bugfixes in 3 days**. The safety mechanism was
   being debugged while live. This is the expected growing pain for a new system,
   but it means we had a period where auto-reverts were misfiring.

4. **Browser testing exists but is isolated from the patch pipeline**. The
   DashboardSmokeExperiment is technically capable but emits finding shapes
   (runtime errors) that PatchAuthorExperiment's literal filter correctly rejects.
   The copy-lint pipeline (DashboardCopyExperiment → SourceCopyLintExperiment)
   is the actual source of patchable findings today.

5. **The string-literal patch mode is architecturally sound**. Limiting LLM
   output to only changing string content in TSX files while freezing AST structure
   is the right safety design for UI copy healing. The Layer 4 gate (`patch-string-
   literal-bounds.ts`) enforces this at the TypeScript AST level.

**Decision**: Write AUTONOMY_ROADMAP.md (this file) and proceed with P0:
PatchLoopHealthExperiment as next implementation step.

**Result**: Roadmap written. No code changed.

---

## 5. Next Steps

### Immediate (next session)

1. **Implement RoadmapObserverExperiment** (Layer B — tier-1)
   - probe(): read PatchLoopHealth findings + recent autonomous commits
   - Generate proposed iteration log entry for AUTONOMY_LOOP_NOTES.md
   - No intervene — human decides what to merge into the roadmap
   - This is the system's first "own voice" contribution to its goals

2. **Observe hold_rate recovery overnight**
   - The 4 old reverts age out of the 24h window by ~09:00-13:00 on 2026-04-16
   - Expected jump: hold_rate goes from 33% to ~100% as new-era patches all hold
   - If hold_rate does NOT recover → diagnose: is FlowBuilder.tsx patch oscillating?

3. **Add P1 post-patch verification gate**
   - After safeSelfCommit returns ok, immediately run copy-lint on the patched file
   - If violations remain that WERE in the original finding → log a warning finding
   - This is a pure observability addition — no blocking behavior yet

### Medium-term

4. **Close the browser→patch gap (P2)**
   - DashboardSmokeExperiment currently emits `issues[]` not `violations[]`
   - Add a step that maps console errors / ErrorBoundary triggers to their source
     file + a synthetic violation literal
   - This lets PatchAuthorExperiment pick up browser-discovered issues and
     attempt string-literal fixes on the matching page component

5. **Widen tier-2 surface carefully**
   - The current tier-2 includes 4 lib files (whole-file mode) and all pages/ (string-literal)
   - Next candidates: `src/lib/` utility files with full test coverage
   - Each expansion should be preceded by a fuzz experiment under
     `src/self-bench/experiments/` that property-tests the target file

### Long-term (do not rush)

6. Deterministic patch replay / pre-commit simulation (P3)
7. Business metric integration — UX impact measurement (P4)
8. Multi-file patch coordination — patches that span > 1 tier-2 file atomically
