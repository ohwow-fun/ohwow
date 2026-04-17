# Brand Kit System

Each OHWOW.FUN series has a distinct visual identity encoded in a JSON file
under `packages/video/brand-kits/<slug>.json`. The kit overlays the
Remotion renderer's default brand tokens at compose time — colors, fonts,
glass, ambient mood, motion style, palette hue + harmony, and the allowed
scene-kind / primitive vocabulary.

## Why JSON (not TS)

The compose pipeline runs from `.mjs` scripts in `scripts/yt-experiments/`
and the renderer runs from compiled TS in `packages/video/`. JSON is the
lingua franca both sides can load without build steps. The TypeScript type
(`packages/video/src/brand-kits/types.ts → BrandKit`) is declarative only —
it documents the shape and lets the renderer type-check kit usage. Changes
to a kit hot-reload on the next compose without rebuilding the package.

## Files

| Path | Purpose |
|---|---|
| `packages/video/src/brand-kits/types.ts` | `BrandKit` type + enums |
| `packages/video/src/brand-kits/index.ts` | `loadBrandKit(slug)`, `listBrandKitSlugs()` |
| `packages/video/brand-kits/<slug>.json` | One kit per series (5 total) |
| `packages/video/src/fonts.ts` | Loads all fonts referenced by kits |

## Shape

```ts
interface BrandKit {
  slug: string;                 // must match filename
  displayName: string;          // human-readable show name

  // extends BrandTokens — merged into VideoSpec.brand at compose time
  colors: Record<string, string>;
  fonts: { sans: string; mono: string; display: string };
  glass: { background; border; borderRadius; backdropFilter };

  ambientMoodDefault:           // picks ambient track when draft doesn't
    | "contemplative" | "electric" | "warm" | "cosmic"
    | "ethereal" | "noir" | "dawn";

  sceneKindAllowlist?: string[]; // restrict visual vocab (undefined = any)

  primitivePalette: string[];    // preferred visual layers for composable scenes
                                 //   seeded into the LLM prompt

  motionStyle:                   // transition/pacing hint
    | "crisp" | "slow-burn" | "measured" | "punchy" | "chaotic";

  paletteHue: number;            // 0-360, base hue for palette generator
  paletteHarmony:                // color-harmony rule
    | "analogous" | "complementary" | "triadic" | "split";

  headlineFont?: string;         // optional third font for editorial headers
}
```

## Merge semantics

At compose time, `yt-compose-core` calls `loadBrandKit(series.brandKitFile)`
and merges into the VideoSpec like this:

```ts
spec.brand = {
  colors: { ...hardcodedDefaults, ...kit.colors },
  fonts:  { ...hardcodedFonts,    ...kit.fonts  },
  glass:  kit.glass,  // replace — kit is authoritative
};
spec.palette ??= {
  seedHue: kit.paletteHue,
  harmony: kit.paletteHarmony,
  mood: kit.ambientMoodDefault,
};
```

Individual scene params can still override palette + mood — the kit is the
floor, not the ceiling. If the LLM picks a `noir` mood for a scene in a
Briefing episode, that scene still renders as `noir`; the kit's default
only kicks in when the draft doesn't specify.

## Authoring a new kit

1. Copy an existing kit (e.g. `briefing.json`) as a scaffold.
2. Set `slug` and `displayName` to the new series.
3. Design the color palette around a single accent hue. Keep ≥4 colors:
   `bg`, `surface`, `accent`, `text`. Add `textMuted` + `textDim` for
   layering.
4. Pick fonts from `FONT_FAMILIES` in `packages/video/src/fonts.ts`. Load a
   new font there first if needed.
5. Choose `ambientMoodDefault` from the 7 registered moods — this
   determines the fallback ambient track at render.
6. List 4–6 `primitivePalette` layers the LLM can lean on (e.g., `aurora`,
   `bokeh`, `film-grain`). Narrow = more consistent; wide = more variety.
7. Optionally set `sceneKindAllowlist` to restrict scene kinds (Briefing
   uses `text-typewriter`, `quote-card`, `composable`, `stats-counter` —
   skips narrative-heavy ones).
8. Add an entry in `packages/video/src/brand-kits/__tests__/brand-kits.test.ts`
   `EXPECTED_SLUGS` so the test suite catches accidental removals.
9. Run `node scripts/yt-experiments/yt-brand-kit-audit.mjs` to render a
   sample scene and eyeball the result next to the other series.

## Auditing drift

The `yt-brand-kit-audit` CLI renders one sample scene per enabled series
using each kit. Eyeball the five outputs side-by-side — if any two look
the same, the kits aren't pulling their weight. Run after any kit edit
and after any font / primitive change.
