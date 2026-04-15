# Known Gaps

Prioritized backlog for the ohwow autonomous self-improvement loop. Referenced
from [../AUTONOMY_ROADMAP.md](../AUTONOMY_ROADMAP.md). Updated by humans and
by RoadmapUpdaterExperiment.

## Known Gaps

### P0 — Loop Convergence is Unobservable
The system is generating patches and reverting them, but there is no aggregate
metric for "is the violation pool shrinking?" or "what % of patches are holding?"
Without this, we cannot tell if the system is making progress or thrashing.

**Symptoms**: 8 revert commits in 3 days; Layer 5 required 4 bugfixes in same window.
**Risk**: The latest Layer 5 fix (`ae52755`, literal-level intersection) may resolve
the oscillation, but we have no way to confirm convergence without a health metric.

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
literal text. They carry `issues[]` with runtime error messages. The
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
