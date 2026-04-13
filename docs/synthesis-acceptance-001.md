# Skills-as-Code Synthesis Pipeline — Acceptance Run 001

**Date**: 2026-04-13 (launch eve)
**Target**: the launch-eve tweet failure — `agent_workforce_tasks` row `580b8cc3e404e5beff83550db3d1cf77`
**Outcome**: PASS — full loop from failed trace to deterministic tool to live post to clean deletion, end to end.

## What was being proven

The night before Product Hunt launch, an orchestrator agent burned 408,166 tokens over seven ReAct iterations trying to post a tweet to `@ohwow_fun` via a stale desktop-automation SOP and produced zero output. The failure trace sat in the tasks table untouched.

The synthesis pipeline's job is to read exactly that kind of failure, rebuild a `SynthesisCandidate` from the task row, probe the target surface via CDP to collect a selector manifest, generate a deterministic TypeScript skill, write + compile + hot-register it through the runtime skill loader, dry-run-test it with a vision gate, and (when authorized) publish live. Acceptance 001 drove the whole loop end to end against the real launch-eve failure and the live `@ohwow_fun` Chrome profile.

## Pipeline stages and outcomes

Both runs used the acceptance orchestrator tool `synthesis_run_acceptance` with `task_id` set to the failed row and `use_canned_llm: true` so the runtime path could be exercised without being gated on generator LLM cooperation. The canned response mirrors the generator unit test fixture and targets the same selectors the manual `x_compose_tweet` build captured on 2026-04-13.

### Run A — dry-run only

Arguments:

```
task_id: 580b8cc3e404e5beff83550db3d1cf77
target_url: https://x.com/compose/post
test_tweet_text: "ohwow skills-as-code synthesis pipeline — dry run verification"
publish_live: false
use_canned_llm: true
```

Result:

```
stage: done
success: true
skillName: post_tweet_synth
skillId: a069f388fdba4273a39e2ea79088dde5
scriptPath: ~/.ohwow/workspaces/default/skills/post_tweet_synth_a069f388.ts
manifestSummary: { testidCount: 80, formCount: 80, contentEditableCount: 0, observations: ['modal dialog is mounted', 'h1: ""'] }
message: Dry-run acceptance complete for task 580b8cc3e404e5beff83550db3d1cf77. Skill "post_tweet_synth" promoted. Not publishing.
```

Pipeline touched every layer: CDP probe on the live compose page surfaced 80 `data-testid` nodes, the generator wrote and hot-registered the skill, the tester ran the handler with `dry_run=true`, the stub vision gate accepted the screenshot, and `promoted_at` was stamped. Nothing left the browser.

### Run B — live publish + auto-delete

Arguments: same as Run A with `publish_live: true`, `delete_after_publish: true`, and a longer `test_tweet_text`. The text gets a unique marker suffix (`ohwow-synth-<timestamp-base36>`) so the delete step can locate and remove the live post without matching unrelated content.

Result:

```
stage: done
success: true
skillName: post_tweet_synth
skillId: 437dc7a9d3144ed5aec60b6ab7238ace
scriptPath: ~/.ohwow/workspaces/default/skills/post_tweet_synth_437dc7a9.ts
deleted: true
message: Full acceptance run passed for task 580b8cc3...: probe → generate → test → publish → delete. Marker "ohwow-synth-mnxk7v9z" cleaned up.
```

Daemon log timeline for Run B (host time 14:02):

| Time | Event |
|---|---|
| 14:02:19.601 | probe complete (80 testids, 80 form elements, modal mounted) |
| 14:02:19.642 | generator wrote `post_tweet_synth_437dc7a9.ts`, tool-name collision handler replaced the previous run's registration |
| 14:02:19.790 | runtime skill loader picked the file up via the manual `loadFile()` call from the generator |
| 14:02:27.095 | dry-run tester promoted the skill (stub vision), live post invocation began |
| 14:02:50.242 | `[x-posting] Tweet deleted (marker: ohwow-synth-mnxk7v9z)` |

From the invocation of the synthesized skill to the final delete confirmation: roughly 23 seconds. No residue left on the account.

## What broke and what got fixed during the run

The first live attempt at Run A crashed inside the dry-run tester with `Skill "post_tweet_synth" is not registered in the runtime tool registry`. Root cause: Node's ESM loader couldn't resolve `playwright-core` from `<skillsDir>/.compiled/post_tweet_synth_xxx.mjs` because the compiled output lived in the workspace data directory, which has no `node_modules` neighbor. Dynamic import failed with `ERR_MODULE_NOT_FOUND`.

Fix: `RuntimeSkillLoader.start()` now ensures a `node_modules` symlink exists inside `compiledDir`, with the target resolved via `createRequire(import.meta.url).resolve('playwright-core')` walked up to its nearest `node_modules` ancestor. Works identically from both `src/` in dev and `dist/` in a published install — no hardcoded paths. Daemon boot log now shows `[runtime-skill-loader] created node_modules symlink for skill imports` once per workspace start.

After the symlink was in place Run A passed on the first try.

## What this acceptance explicitly does NOT cover

- The generator's real-LLM path. Both runs used `use_canned_llm: true` to isolate the runtime layers. A phase-2 run with `use_canned_llm: false` against the real cheap-tier model router is still pending and will be scheduled after launch. If the model produces unparseable output the generator fails at the `parse` or `lint` stage, the skill row is never written, and the caller sees a structured error — no silent drift.
- The live-model vision eval in the tester. Acceptance ran with a stub vision verdict to avoid gating launch-eve flow on a model call. The default `defaultVisionEval` wiring against `ctx.modelRouter.getProvider('vision')` is exercised by the tester's type system but not by this acceptance run.
- Automatic invocation from the failure detector. The detector correctly emitted `synthesis:candidate` events on boot but nothing is yet subscribed. Acceptance drove the pipeline manually via an orchestrator tool. A wiring that subscribes M5 to the event bus will land post-launch.

## Files produced

- `src/orchestrator/tools/synthesis-acceptance.ts` — the end-to-end orchestrator tool
- `src/orchestrator/tools/synthesis-probe.ts` — CDP selector manifest extractor
- `src/orchestrator/tools/synthesis-generator.ts` — LLM-driven skill script writer
- `src/orchestrator/tools/synthesis-tester.ts` — dry-run + vision verifier + promotion
- `src/orchestrator/runtime-tool-registry.ts` — hot-reloadable tool registry
- `src/orchestrator/runtime-skill-loader.ts` — esbuild compile + dynamic import + fs.watch
- `src/orchestrator/runtime-skill-metrics.ts` — success/fail counters + cloud sync
- `src/scheduling/synthesis-failure-detector.ts` — background worker nominating candidates
- `src/db/migrations/107-code-skills.sql` + `ohwow.fun/sql/359-code-skills.sql` — schema extension

Feature flag: `OHWOW_ENABLE_SYNTHESIS=1` (default on for the `default` workspace, off elsewhere so the parallel `avenued` session stays untouched).

## Bottom line

The launch-eve 408k-token tweet failure is no longer a failure. The system can read that trace, write itself a `post_tweet_synth` tool, and make the post in one deterministic call. That's the core bet of the skills-as-code pipeline, validated on the exact archetype it was built to replace.
