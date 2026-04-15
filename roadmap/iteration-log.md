# Iteration Log

Chronological record of loop iterations. Newest first. Referenced from
[../AUTONOMY_ROADMAP.md](../AUTONOMY_ROADMAP.md). Appended by humans and by
RoadmapUpdaterExperiment.

## Recent Iterations

### 2026-04-15T16:15 — Roadmap awareness + tier-2 expansion

**What was done**:
1. Fixed X posting auth bug in `tool-executor.ts`. Was skipping profile setup when
   browser service already active; now always calls `ensureDebugChrome` + `openProfileWindow`
   from chrome-profile-router and passes `expectedHandle` to `composeTweetViaBrowser`.

2. Fixed `ErrorBoundary.tsx` fallback copy (was "Something went wrong", now "Something broke
   on this page") and promoted the file to tier-2 string-literal mode so future violations
   auto-fix. Also made `PatchLoopHealthExperiment` derive its tier-2 prefix list from the
   authoritative registry instead of a hardcoded copy.

3. Injected AUTONOMY_ROADMAP.md as read-only context into `PatchAuthorExperiment`'s LLM
   prompt (Known Gaps + Active Focus only, not the full log). The model now knows about
   the auto-revert mechanism, the hold_rate target, and the P1 gap before authoring each
   patch.

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

**Decision**: Keep. Watch PatchLoopHealth hold_rate over the next 30-60min.
If hold_rate drops below 0.5 (loop thrashing), revert cadence changes.

---

### 2026-04-15 — Initial Audit

**What was attempted**: Full codebase audit of last 3 days of commits + key file reads.

**What we learned**:

The system is active and running with real autonomous patch cycles. Key findings:

1. **Oscillation was the primary instability signal**. All 8 reverts trace to
   Agents.tsx patches from source-copy-lint findings. Root cause: Layer 5's refire
   detection was keyed on `(experiment_id, subject)` pairs only. A patch that fixed
   one of N violations in a file would cause the experiment to re-fire (correctly,
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
