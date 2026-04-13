/**
 * Canonical copywriting rules for ohwow-generated user-facing copy.
 *
 * The root orchestrator's prompt-builder already injects the repo's
 * CLAUDE.md via `projectInstructions`, so the root model sees these
 * rules indirectly. Sub-agents spawned through `run_agent`/
 * `delegate_subtask` go through `RuntimeEngine.buildSystemPrompt`,
 * which has no project_instructions plumbing. When launch-eve copy
 * was delegated to a sub-agent for rewriting, the sub-agent produced
 * em-dashes and duration claims because it never saw the rules.
 *
 * This module is the single source of truth. It is injected into:
 *   - src/orchestrator/system-prompt.ts (root orchestrator)
 *   - src/execution/engine.ts (sub-agent RuntimeEngine)
 *
 * If the CLAUDE.md copywriting section changes, update this file in
 * lockstep — grep for COPYWRITING_RULES to find the call sites.
 */

export const COPYWRITING_RULES = `## Copywriting Rules (non-negotiable for any user-facing copy)

When you generate launch copy, marketing copy, product descriptions, tweets,
maker comments, emails, blog posts, tooltips, empty states, or any text a
customer or Product Hunt visitor will read, obey every rule below. These
override any style you might have picked up from training data.

- No dashes as sentence connectors. Use periods, commas, semicolons, or
  line breaks instead. This ban covers the em-dash (Unicode U+2014), the
  en-dash (Unicode U+2013), and the ASCII hyphen used as a pause between
  clauses. Rewrite any "X [dash] Y" construction as "X. Y" or "X, Y"
  depending on cadence. Hyphens inside compound words (e.g. "builder-to-
  builder", "open-source", "launch-eve") are fine.
- No development-time claims. Do not write "[X] months", "after X months
  of research", "X years building", "the past N months", or any phrasing
  that quantifies how long ohwow has been in development. Launch copy is
  architecture-forward, not timeline-forward. Lead with what it does and
  why it is different, never with when it was started.
- No corporate language. Prefer warm, direct, builder-to-builder phrasing.
  Write the way a founder talks to another founder, not the way a
  marketing team writes to a persona.
- No "please" in validation errors. Be direct: "Give it a title first"
  not "Please enter a title".
- No "Failed to X". Write "Couldn't X. Try again?" or
  "Couldn't X. Try refreshing."
- No "(s)" pluralization. Write proper conditional plurals.
- No passive empty states. Give them personality and suggest a next step.
- Consistent product language. Say "your AI team" or "your agents",
  never switch between terms inside the same piece.

If a draft you are editing contains any of the banned forms, rewrite them
before returning the result. If you are writing from scratch, never emit
them in the first place. The rules apply to the final output, not your
reasoning.`;

/**
 * Terse variant for the compact prompt path (sub-2B models on narrow
 * context windows). Same spirit, a fraction of the tokens. Keeps just
 * the two rules that caused the launch-eve regression.
 */
export const COPYWRITING_RULES_COMPACT = `## Copywriting
No dashes as sentence connectors (no em-dash, en-dash, or ASCII hyphen
pause). No development-time claims ("X months building", etc.).
Warm, direct, builder-to-builder.`;
