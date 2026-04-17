# Generated scenes (ephemeral)

This directory is **not tracked**. Phase 3 of the motion-graphics plan
lets the compose pipeline generate bespoke TSX scene components for
novel visuals the DSL can't express.

- One file per `custom-<sceneId>` scene (e.g. `briefing-2026-04-17-story-2a.tsx`).
- `index.ts` is the auto-managed barrel that side-effect-imports every
  generated scene so webpack picks them up.
- Files are rewritten on every compose pass by
  `scripts/yt-experiments/_custom-scene-codegen.mjs`.
- The codegen script enforces an import allowlist + AST validation;
  bad outputs are rejected and the scene falls back to beats.

Do **not** hand-edit anything here — it gets blown away on the next
render. If a generated scene is worth keeping, promote it to a real
scene component under `packages/video/src/scenes/`.
