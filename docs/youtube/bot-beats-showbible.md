# Show Bible — Bot Beats

> **Status:** DEFERRED to v2. Series is registered with `enabled: false`
> in `src/integrations/youtube/series/registry.ts`. This skeleton exists
> so the doc slot is not forgotten — do NOT fill it in until the Lyria-
> in-render work is scoped.

## One-liner

AI-made songs, remixes, parody anthems. Viral trend-reactive musical
content around startups, work, tech, society. Absurd, catchy, polished
chaos.

## Why deferred

Bot Beats needs render-time music generation, which requires:

1. Extracting the Lyria client out of
   `scripts/x-experiments/_gen-ambient-library.mjs` into
   `src/integrations/music/lyria.ts`.
2. Extending `AudioRef` in `packages/video/src/spec/types.ts` with a
   `musicGen?: { prompt: string; durationSeconds: number }` variant.
3. Adding a Remotion-side resolver that calls Lyria at render time and
   caches generated clips by content hash under
   `~/.ohwow/media/audio/music-gen/`.
4. Building a prompt-for-song library (genre × tempo × vibe combinators).
5. A separate approval surface — music has a different fail mode from
   narration (bad beat ≠ bad prompt).

Ship this series ONLY after the other four are live and the lift loop is
producing real signal. Music generation at scale is expensive and
without feedback data we're throwing darts.

## When picked up again

1. Run `yt-series-brief.mjs bot-beats` for a deep-research pass on AI-
   music Shorts formats that work (parody, remix, mood-anthem, trend-
   reactive).
2. Flip the registry `enabled: true` for `bot-beats`.
3. Write this show bible properly — voice, format, source rules, banned,
   success metric.
4. Ship first 5 posts at `VISIBILITY=private` so humans can listen
   before anything goes unlisted / public.
