# Video Generation Scripts

One-command utilities for the ohwow text-to-video pipeline. Deterministic, dependency-light, and wired through the OSS `video-clip-provider` layer.

## Current state (2026-04-16)

Two providers wired:

| Provider | Model | Cost / 5s | Notes |
|---|---|---|---|
| `fal` | Seedance 1.0 Pro (default) | ~$0.50 | SOTA-class. Active when `falKey` is set. |
| `generic-http` | LTX-Video on a private Modal A10 | ~$0.01 | Self-hosted. Active when `OHWOW_VIDEO_HTTP_URL` is set. Lower quality, produces abstract output below 480p. |

The router auto-selects based on available credentials + `--clips-provider` / `--clips-max-cost` flags.

### Credential resolution

First match wins, per provider:

1. **fal:** `FAL_KEY` + `FAL_VIDEO_MODEL` env vars (dev override) → `~/.ohwow/config.json` `falKey` / `falVideoModel` fields (persistent)
2. **generic-http:** `OHWOW_VIDEO_HTTP_URL` + `OHWOW_VIDEO_HTTP_AUTH` env vars

The key is never written to the repo and never logged.

## Scripts

| Script | Purpose |
|---|---|
| [`status.sh`](./status.sh) | Print current video-gen config (keys masked). Which provider the router would pick right now. |
| [`gen-one.mts`](./gen-one.mts) | Generate one clip via the fal adapter. Takes prompt + duration/aspect/seed. |
| [`lint-prompt.sh`](./lint-prompt.sh) | Static prompt check. Flags missing motion cues, style overload, word count, tense. |
| [`swap-model.sh`](./swap-model.sh) | Change the active fal model slug in `~/.ohwow/config.json`. |

Run each with no args to see its usage banner.

## Prompt pattern (validated 2026-04-15 on LTX-Video and Seedance 1.0 Pro)

A prompt that reliably produces good motion has **five load-bearing elements**, in roughly this order:

1. **Camera-motion cue** — `slow dolly-in`, `aerial drone shot flying forward`, `low-angle tracking shot`, `handheld glide`, `static locked-off`. Pick one.
2. **Subject-motion cue** — `steam rising`, `mist drifting`, `hands pouring`, `grass parting as it runs`. Pick one.
3. **Lighting description** — the single biggest quality lever. `soft window light from the left`, `golden hour god-rays through pine trees`, `ominous chiaroscuro`, `neon signs reflecting on wet pavement`.
4. **Style anchor** — one choice:
   - For realism: `shot on iPhone`, `Sony FX3`, `35mm film`, `documentary`, `photorealistic`
   - For movie-look: `cinematic anamorphic 35mm`, `shallow depth of field`, `film grain`
5. **Subject specificity** — `a red Arabian horse` > `a horse`; `vintage 1960s black muscle car` > `a car`. Verbs matter too: `stalks` > `walks` > `gallops`.

### Constraints

- Single flowing paragraph, **60-200 words**, **present tense**, start with the action.
- **Stack at most 3 stylistic modifiers** (anamorphic, lens flare, film grain, vignette, color grade, volumetric, chiaroscuro). Stacking more than 3 turns smaller models like LTX into abstract mush at 480p.
- Avoid internal emotional states ("she feels sad" → use "her jaw tightens").
- Avoid hard physics: liquids, reflections, many small moving parts. Seedance handles these; LTX does not.

### Pre-flight

```bash
./scripts/video/lint-prompt.sh "your prompt here"
```

Flags missing cues and gives concrete suggestions. Prompts that pass the linter generate meaningfully better output on first try.

## Provider-quality cheat-sheet

| Scenario | Use | Why |
|---|---|---|
| Iterating on a prompt | `generic-http` (LTX, Modal) | ~$0.01/clip, fast turnaround |
| Final hero clip / viral-grade | `fal` + Seedance 1.0 Pro | SOTA, $0.50/clip |
| Hero clip with premium budget | `fal` + Seedance 2.0 Standard | ~$1.52/clip, Apr-2026 SOTA |
| Hands, liquids, faces, reflections | `fal` only | LTX physically cannot render these well |
| Nature / atmospheric b-roll | Either | LTX handles animal + landscape motion reasonably |

## Integration with the video-clip-provider layer

These scripts exercise the same `falProvider` / `genericHttpProvider` that `src/execution/skills/video_workspace_author.ts` invokes at render time via `resolveClipLayers()`. Any improvement to the adapter automatically benefits every downstream consumer (storyboard render, MCP tools, CLI, etc.).

If you change the adapter contract, re-test with `scripts/video/gen-one.mts` before shipping.
