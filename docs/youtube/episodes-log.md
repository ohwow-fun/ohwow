# Episodes Log — YouTube

Every published YouTube episode, newest first. Append one entry per
publish; the QA round of the be-ohwow trio that shipped the episode
owns the append.

---

## Entry template

<!-- template begin -->

```
### <date> — <series> — <episode title>

- **Published**: <YouTube URL or "draft only">
- **Runtime**: <seconds>s
- **Format**: Short | Horizontal | Long
- **Seed**: <source row id / HN thread / deep_research query>
- **Narration**: <word count> words, <TTS voice>
- **Music**: <track id or "none">
- **Commit (rename/config if any)**: <runtime short SHA> or "none"
- **Commit (publish record)**: <runtime short SHA>
- **What worked**: <one-line observation>
- **What to improve**: <one-line next-iteration note>
```

<!-- template end -->

---

## Entries

### 2026-04-18 — The Briefing — Daily AI News - April 18, 2026 · One Move

- **Published**: https://youtu.be/[manual-publish-url-to-backfill]
- **Runtime**: 51.5s
- **Format**: Horizontal
- **Seed**: CraftAX CUDA to CPU port at 47.8M steps/sec on Ryzen 9 9950X3D
- **Narration**: 107 words, onyx (OpenRouter gpt-audio-mini)
- **Music**: ambient-electric (base 0.9, ducked under voice)
- **Commit (rename/config if any)**: fc16d12, c8b743c, 6d3da49, d2a3f9d, 594424d, 7e519e0, 717d6dd, 65f6987, 9fb6dd2
- **Commit (publish record)**: f2f0c30
- **What worked**: Every layer of the compose to publish path is now defaults-locked and regression-pinned, so the derived title, per-scene TTS, loudnorm, ducking, session partition probe, and public-gate override all hold without per-run babysitting.
- **What to improve**: Studio wizard stalled at step 0 with "Next button not clickable", so the founder finished manually and automated videoId capture did not happen; the URL above is backfilled once confirmed. Surfacing which field or modal is blocking, or accepting an explicit founder-finish checkpoint, is the real next-up.

Day 1 shipped prior to this log; details to be backfilled when found.
