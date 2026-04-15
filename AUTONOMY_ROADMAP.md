# AUTONOMY_ROADMAP.md

Single source of truth for the ohwow autonomous self-improvement loop.
This is the top-level index. Always read this first.

**Companion files** (kept small on purpose):
- [roadmap/gaps.md](roadmap/gaps.md) — prioritized Known Gaps (P0…P4).
- [roadmap/iteration-log.md](roadmap/iteration-log.md) — chronological
  Recent Iterations, newest first.

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
| tier-2 (whole-file) | `src/lib/format-duration.ts`, `src/lib/token-similarity.ts`, `src/lib/stagnation.ts`, `src/lib/error-classification.ts`, `AUTONOMY_ROADMAP.md`, `roadmap/gaps.md`, `roadmap/iteration-log.md` | Replace entire file. 1 top-level symbol changed (L4 gate). |
| tier-2 (string-literal) | `src/web/src/pages/`, `src/web/src/components/ErrorBoundary.tsx` | Only string literal / JSX text node values may differ. Structure/imports/identifiers frozen (L4 gate). |
| tier-3 | Everything else | Humans only. |

### Key Experiments Running

- **PatchAuthorExperiment** — LLM patch authoring from findings (every 5min). Reads AUTONOMY_ROADMAP.md + roadmap/gaps.md as context.
- **AutonomousPatchRollbackExperiment** — Layer 5 cool-off watcher (every 5min, 10min cool-off window)
- **PatchLoopHealthExperiment** — hold_rate + pool delta convergence monitor (every 5min)
- **RoadmapUpdaterExperiment** — keeps Active Focus + Next Steps in sync with live loop state (every 15min, fingerprint-gated no-op short-circuit)
- **DashboardSmokeExperiment** — headless browser walk of all routes (every 5min)
- **DashboardCopyExperiment / SourceCopyLintExperiment** — copy rules violation detection (every 5min)
- **AdaptiveSchedulerExperiment** — dynamic cadence adjustment
- **MigrationSchemaProbeExperiment** — per-migration schema validation
- **ToolchainTestProbeExperiment** — per-tool test execution
- Multiple latency monitors (Anthropic, DeepSeek, Google, Qwen, Xiaomi)

See [roadmap/gaps.md](roadmap/gaps.md) for the prioritized backlog.

---

## 2. Active Focus
**Loop is converging. Watching hold_rate recover as old reverts age out.**

As of 2026-04-15T16:15Z:
- 6 patches landed in the 24h window, 4 reverted (hold_rate=33%), but the 4
  reverts are ALL pre-session (oscillation era). The 2 patches from this session
  (Agents.tsx, Dashboard.tsx) have both held. A third patch (FlowBuilder.tsx) is
  expected on the next cycle.
- The old 4 reverts will age out of the 24h window by ~2026-04-16T09-13. After
  that, hold_rate should jump to 100% (all current-era patches holding).
- Violation pool: 3 remaining open violations (FlowBuilder.tsx "Something went
  wrong", ErrorBoundary.tsx was fixed manually and promoted to tier-2).
- PatchAuthorExperiment now reads this roadmap as LLM context; the model is
  strategically aware of the loop goal.

**Roadmap in the loop — phased design:**

Layer A (done): Read-only roadmap context injected into PatchAuthor LLM prompt.
  The model sees Known Gaps + Active Focus before generating each patch.
  Makes patches more likely to hold because the model understands the
  auto-revert mechanism and the convergence goal.

Layer B (next): RoadmapObserverExperiment (tier-1). Reads PatchLoopHealth
  findings + recent interventions, writes a proposed iteration log entry to
  AUTONOMY_LOOP_NOTES.md (a new tier-1 file). The system accumulates its own
  loop observations in its own voice. A human or future upgrade merges them
  into this roadmap.

Layer C (now in progress): Promote the roadmap suite to tier-2 whole-file mode
  (done for AUTONOMY_ROADMAP.md, roadmap/gaps.md, roadmap/iteration-log.md)
  with a roadmap-shape-probe guarding structural invariants and auto-reverting
  any RoadmapUpdaterExperiment patch that breaks the shape.

## 3. Next Steps
### Immediate (next session)

1. **Implement RoadmapObserverExperiment** (Layer B, tier-1)
   - probe(): read PatchLoopHealth findings + recent autonomous commits
   - Generate proposed iteration log entry for AUTONOMY_LOOP_NOTES.md
   - No intervene; human decides what to merge into the roadmap
   - This is the system's first "own voice" contribution to its goals

2. **Observe hold_rate recovery overnight**
   - The 4 old reverts age out of the 24h window by ~09:00-13:00 on 2026-04-16
   - Expected jump: hold_rate goes from 33% to ~100% as new-era patches all hold
   - If hold_rate does NOT recover, diagnose: is FlowBuilder.tsx patch oscillating?

3. **Add P1 post-patch verification gate**
   - After safeSelfCommit returns ok, immediately run copy-lint on the patched file
   - If violations remain that WERE in the original finding, log a warning finding
   - This is a pure observability addition; no blocking behavior yet

### Medium-term

4. **Close the browser→patch gap (P2)**
   - DashboardSmokeExperiment currently emits `issues[]` not `violations[]`
   - Add a step that maps console errors / ErrorBoundary triggers to their source
     file + a synthetic violation literal
   - This lets PatchAuthorExperiment pick up browser-discovered issues and
     attempt string-literal fixes on the matching page component

5. **Widen tier-2 surface carefully**
   - The current tier-2 includes 4 lib files (whole-file mode), the roadmap suite, and all pages/ (string-literal)
   - Next candidates: `src/lib/` utility files with full test coverage
   - Each expansion should be preceded by a fuzz experiment under
     `src/self-bench/experiments/` that property-tests the target file

### Long-term (do not rush)

6. Deterministic patch replay / pre-commit simulation (P3)
7. Business metric integration; UX impact measurement (P4)
8. Multi-file patch coordination; patches that span > 1 tier-2 file atomically

---

_Iteration history lives in [roadmap/iteration-log.md](roadmap/iteration-log.md)._
