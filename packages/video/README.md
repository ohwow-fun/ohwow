# @ohwow/video

Deterministic, spec-driven video engine. Takes a JSON `VideoSpec`, renders an MP4 via Remotion.

## Status

- **Phase 0**: scaffold (this commit) — empty `SpecDriven` composition builds.
- **Phase 1**: parity with `ohwow-video/OhwowDemo.tsx` driven from `specs/ohwow-demo.json`.
- **Phases 2–4**: asset cache, composed skill in the ohwow runtime, DB + CLI.

See `/Users/jesus/.claude/plans/stateful-riding-oasis.md` for the full port plan.

## Usage

```bash
npm install
npm run studio                         # Remotion Studio
npm run render:demo                    # Render the ohwow demo from specs/ohwow-demo.json
npx remotion render src/index.ts SpecDriven out.mp4 --props=./specs/my-spec.json
```

## Authoring a new scene kind

1. Add the kind to `SceneKind` in `src/spec/types.ts` and its param shape to `src/spec/kinds.ts`.
2. Write the React component under `src/scenes/`. It must accept `{ params, brand, durationInFrames }`. No `staticFile` hardcoding, no direct `design.ts` imports — pull brand tokens from `BrandContext`.
3. Register it in `src/scenes/registry.tsx`.
4. Write a parity test if porting from an existing scene.

## Why a separate package

Remotion requires React 19 + CJS. The ohwow runtime is ESM-only. Keeping this in its own package with its own `node_modules` prevents cross-contamination. The daemon shells out to `remotion render` via child process — no direct imports of React scenes from the runtime.
