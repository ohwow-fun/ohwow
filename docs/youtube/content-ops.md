# Content Ops — YouTube

Daily operating doc for the OHWOW.FUN YouTube engine. Future be-ohwow
sessions read this to know what series exist, how the compose pipeline
fits together, and how to ship today's episode per series. It's the
operator-facing sibling of `briefing-showbible.md` (the editorial
"why" for The Briefing) and `episodes-log.md` (the chronological
ledger of what's actually shipped). The series-playbook and
ops-runbook in this folder stay as the strategic + incident-response
references; this doc is the shortest path from "it's morning" to
"today's episode is live."

---

## Series roster

Source of truth: `src/integrations/youtube/series/registry.ts`. Show
bibles, prompt modules, and seed adapters per series below.

| Series | Cadence | Format | Show-bible | Script-prompt | Seed adapter | Compose wrapper | Publish script | Status |
|---|---|---|---|---|---|---|---|---|
| The Briefing | daily (morning) | Horizontal 90–180s, 2–3 stories | `docs/youtube/briefing-showbible.md` | `src/integrations/youtube/series/script-prompts/briefing-prompt.ts` | `scripts/yt-experiments/seed-adapters/briefing-seed.mjs` | `scripts/yt-experiments/yt-compose-briefing.mjs` | `scripts/yt-experiments/_publish-briefing.mjs` | live |
| Tomorrow Broke | daily (evening) | Vertical Short 30–60s | `docs/youtube/tomorrow-broke-showbible.md` | `src/integrations/youtube/series/script-prompts/tomorrow-broke-prompt.ts` | `scripts/yt-experiments/seed-adapters/tomorrow-broke-seed.mjs` | `scripts/yt-experiments/yt-compose-tomorrow-broke.mjs` | none yet (compose-only) | in-progress |
| Mind Wars | daily clips (afternoon) | Vertical Short 45–75s | `docs/youtube/mind-wars-showbible.md` | `src/integrations/youtube/series/script-prompts/mind-wars-prompt.ts` | `scripts/yt-experiments/seed-adapters/mind-wars-seed.mjs` | `scripts/yt-experiments/yt-compose-mind-wars.mjs` | none yet (compose-only) | in-progress |
| Operator Mode | daily (late-morning) | Vertical Short 45–75s | `docs/youtube/operator-mode-showbible.md` | `src/integrations/youtube/series/script-prompts/operator-mode-prompt.ts` | `scripts/yt-experiments/seed-adapters/operator-mode-seed.mjs` | `scripts/yt-experiments/yt-compose-operator-mode.mjs` | none yet (compose-only) | in-progress |
| Bot Beats | deferred (night, v2) | Vertical Short 15–60s | `docs/youtube/bot-beats-showbible.md` | none (deferred) | none (deferred) | none (deferred) | planned |

"live" = at least one real episode has been staged through Studio CDP.
"in-progress" = compose pipeline runs end-to-end but no episode has
been published yet. "planned" = registered with `enabled: false`
and waiting on prerequisite work.

---

## Pipeline anatomy

Every episode runs through the same shape. The mechanics live in
`scripts/yt-experiments/yt-compose-core.mjs`; per-series wrappers are
thin adapters that call `composeEpisode({ slug, env })`.

**Seed → script → voice → spec.** The seed adapter for the series
picks a row from `x-intel-history.jsonl` (Briefing uses
`bucket='advancements'`; Tomorrow Broke uses `predictions`; Mind
Wars/Operator Mode have their own sources with HN and deep-research
fallbacks in `seed-adapters/_hn-fallback.mjs` and
`_researcher-fallback.mjs`). That seed feeds the series' script
prompt module, which emits a structured draft with scene-level
narrations. Global + per-series banned phrases get checked. Narration
goes to TTS (OpenRouter `openai/gpt-audio-mini` primary, Kokoro local
fallback) with the series' `voice.voiceName` and a `prosodyPrompt`
layered onto a strict verbatim system prompt.

**Spec → render → review → publish.** The voiced draft gets lowered
into a `VideoSpec` (see `packages/video`), merged with the series'
brand kit from `packages/video/src/brand-kits/`. Remotion renders it
through the R3F primitives + motion-beats compiler (signature intro is
a 2s `r3f.logo-reveal` cold-open injected at position 0; outro uses
kinetic type + tuning rings). Gemini 2.5 Flash Lite does a visual
self-review off extracted keyframes. A `brief.json` plus a proposal
row (`kind: yt_short_draft_<series>`, bucketed by series) lands in the
approval queue under `~/.ohwow/workspaces/<ws>/yt-approvals.jsonl`.
Publish is a separate step (Studio CDP via the wizard in
`src/integrations/youtube/index.ts`): stage leaves a draft in Studio
Content → Drafts, a human inspects, then `--publish-draft=<id>`
commits at the saved visibility. The `_render-briefing-dryrun.mjs`
path exists as a compose-bypass so the visual treatment can be
inspected with realistic voice when no fresh seed is worth burning.

Shared helpers worth knowing: `scripts/yt-experiments/_thumbnail.mjs`
(ffmpeg frame-grab cached by mp4 sha256); `_custom-scene-codegen.mjs`
(LLM-authored Remotion scenes, capped at 1 per episode);
`seed-adapters/_common.mjs` (shared dedupe + seen-set ledger); and
`_publish-briefing.mjs` (the stage / publish-draft / delete-draft
subcommand trio other series will clone when they get their own
publish scripts).

---

## Ship today's episode — runbook (per series)

### The Briefing (only live series as of 2026-04-18)

Pre-flight: daemon up (`ohwow daemon status`); debug Chrome running on
:9222 with the channel profile already signed into Studio; kill switch
`OHWOW_YT_BRIEFING_ENABLED=true`; `OPENROUTER_API_KEY` available (env
or `~/.ohwow/config.json`).

1. **Dry-run compose** to inspect the seed + draft without staging:

   ```
   DRY=1 node --import tsx scripts/yt-experiments/yt-compose-briefing.mjs
   ```

   Reads the last 48h of `x-intel-history.jsonl` advancements rows,
   writes `brief.json` to the tmp dir, no approval row written, no
   Studio touch. Re-run until the draft reads clean.

2. **Render the signature treatment** (needed if today uses the
   hand-authored dryrun spec rather than the compose-core output):

   ```
   node --import tsx scripts/yt-experiments/_render-briefing-dryrun.mjs
   ```

   Voices each scene narration from
   `packages/video/specs/briefing-dryrun.json` via OpenRouter TTS
   (alloy, briefing prosody), writes the compiled spec alongside, and
   renders to `packages/video/out/briefing-dryrun-v4.mp4`.

3. **Stage as a Studio draft** (uploads mp4 + ffmpeg-generated
   thumbnail, walks the wizard to visibility=unlisted, closes the
   dialog, leaves a real draft in Content → Drafts, prints the
   videoId + edit URL):

   ```
   node --import tsx scripts/yt-experiments/_publish-briefing.mjs
   ```

   Optional flags: `--mp4=<path>` (default
   `packages/video/out/briefing-dryrun-v4.mp4`), `--spec=<path>`
   (default `packages/video/specs/briefing-dryrun.compiled.json`),
   `--title=<str>` (override derived title), `--visibility=unlisted`,
   `--playlist="Daily AI News"` (registry default), `--identity=<handle>`
   to pin channel. Derives the title from the intro scene's
   `floating-title.subtitle`; derives the description from the
   story-scene narrations + outro watch-list.

4. **Human inspect** in Studio: open the edit URL, watch the draft,
   confirm title / description / thumbnail / playlist binding.

5. **Publish-draft** once approved:

   ```
   node --import tsx scripts/yt-experiments/_publish-briefing.mjs --publish-draft=<videoId> --yes
   ```

   Re-opens the wizard on the existing draft, advances to Visibility,
   clicks Save at the saved visibility (unlisted by default;
   `--visibility=public` requires ≥5 prior applied unlisted rows in
   the approval queue). Marks the approval row `applied` with the
   channel URL.

6. **Reject-draft** (if the inspect step fails): same script with
   `--delete-draft=<videoId> --yes`. Approval row goes to `rejected`.

7. **Log the episode** in `docs/youtube/episodes-log.md` using the
   template at the top of that file. That commit closes the loop.

### Tomorrow Broke / Mind Wars / Operator Mode

Compose scripts exist (`yt-compose-tomorrow-broke.mjs`,
`yt-compose-mind-wars.mjs`, `yt-compose-operator-mode.mjs`) and run
end-to-end, but there's no series-specific `_publish-*.mjs` yet. Do
NOT ship one of these through the Briefing publish script — the
title/description derivation is Briefing-shaped (intro subtitle,
story-scene bullets, watch-list). When the first of these is ready to
go live, fork `_publish-briefing.mjs` into `_publish-<slug>.mjs`,
replace the derivation with something that matches the series' spec
shape, and add a row to the Series roster above.

### Bot Beats

Planned. Don't ship until the Lyria-in-render work in the show bible
is scoped.

---

## Title conventions

| Series | Current title template | Notes |
|---|---|---|
| The Briefing | `Daily AI News - <Month Day, Year>` | Renaming on 2026-04-18 as of day 2. Previous template was `The Briefing · <Mon Day> · <Hook>` (see `_publish-briefing.mjs#deriveTitle`). Founder drives the new format; default assumption "April 18, 2026" full month. When the rename lands, update the derivation in `_publish-briefing.mjs` and mirror the decision here. |
| Tomorrow Broke | TBD when first publish script lands | Expect `<Year> - <Hook>` style to match datestamp-opener voice. |
| Mind Wars | TBD when first publish script lands | Expect `<Question> | Mind Wars` style. |
| Operator Mode | TBD when first publish script lands | Expect `<Workflow> - Operator Mode` style. |

Title changes live here. When a title template shifts, update this
section in the same commit as the derivation change.

---

## KPI tracking

No automation yet. YouTube Studio is the manual source for retention
(APV), saves, impressions, CTR, and sub-conversion — open the
episode's Analytics tab. The registry has `goalKpiIds` per series
(`yt_briefing_7d_avg_watch_time` etc.) but nothing reads them yet;
`scripts/yt-experiments/yt-series-digest.mjs` is the stand-in for a
daily rollup but it reports on `agent_workforce_goals` + approval-
queue state, not actual YouTube numbers. Until a metrics poller lands,
per-episode retention goes into `episodes-log.md` by hand from
Studio, typically 24–72h after publish when the number stabilizes.

---

## Enhancement backlog

Specific improvements surfaced by reading the current pipeline. Cap at
six; prune as items land.

- **Auto-append to `episodes-log.md` on publish-draft success.**
  `_publish-briefing.mjs#cmdPublishDraft` already knows the videoId,
  URL, title, visibility, and approval row when it finishes. Have it
  emit an entry block matching the log template so QA just reviews +
  commits rather than hand-writes.
- **Fork `_publish-briefing.mjs` into a shared `_publish-series.mjs`
  core** with Briefing-shaped derivation moved to an adapter. The
  stage / publish-draft / delete-draft dispatch and the approval-queue
  integration are the same for every series; only `deriveTitle` /
  `deriveDescription` differ. Tomorrow Broke going live first is what
  forces this.
- **Surface the compose-core `brief.json` path** in the final line of
  `yt-compose-<series>.mjs` output. Right now a reviewer has to hunt
  for the tmp dir when debugging a draft that didn't pass banned-
  phrase check.
- **Promote the briefing title template to the registry.** It lives
  inline in `_publish-briefing.mjs#deriveTitle` today. Once two series
  have publish scripts, the template belongs on `SeriesConfig` so each
  rename is a registry edit + one derivation swap.
- **Gate `--visibility=public` behind the ops-runbook rule across all
  series.** The "≥5 prior applied unlisted rows" check is hardcoded
  in `_publish-briefing.mjs` (`UNLISTED_BEFORE_PUBLIC = 5`). Move it
  to a shared helper so every series' publish script reuses the same
  gate.
- **Persist Studio Analytics pulls.** The `yt_episode_metrics`
  migration (140) added the table; nothing writes to it yet. A small
  CDP poller that reads APV + saves + sub-conversion for every
  `applied` approval row older than 24h would unlock the strategist's
  lift loop.

---

## Related

- `docs/youtube/briefing-showbible.md` — The Briefing editorial bible.
- `docs/youtube/tomorrow-broke-showbible.md` — Tomorrow Broke bible (skeleton).
- `docs/youtube/mind-wars-showbible.md` — Mind Wars bible (skeleton).
- `docs/youtube/operator-mode-showbible.md` — Operator Mode bible (skeleton).
- `docs/youtube/bot-beats-showbible.md` — Bot Beats bible (deferred).
- `docs/youtube/series-playbook.md` — Five-series strategy + positioning.
- `docs/youtube/brand-kit-system.md` — Visual identity system.
- `docs/youtube/ops-runbook.md` — Incident response, kill switches, backfill policy.
- `docs/youtube/episodes-log.md` — Chronological published-episode ledger.
