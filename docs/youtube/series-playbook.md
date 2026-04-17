# OHWOW.FUN — Five-Series Foundation Pack

Purpose: the recurring YouTube-native franchises that together build growth,
authority, trust, and SaaS demand for OHWOW.FUN.

This doc is the master playbook. Each series has its own show-bible
(`<slug>-showbible.md` in this directory) filled in by a deep-research pass;
each also has a TS prompt module under
`src/integrations/youtube/series/script-prompts/` that the compose pipeline
imports at runtime. The playbook drives the show bibles; the show bibles
drive the prompts; the prompts drive the episodes.

---

## Design Rules

- Every series must feel like a show, not random content.
- Every episode must be recognizable within 3 seconds.
- Daily production must be template-driven.
- Strong hooks, strong titles, clear identity.
- Entertainment first, value second, subtle monetization third.
- Keep visual branding distinct per series.

---

## Master Channel Positioning

**Channel Name:** OHWOW.FUN

**Core Identity:** The future of AI, business, culture, and humanity.

**Brand Tone:** Smart, surprising, cinematic, internet-native, never corporate.

**Audience:**
- Founders
- Operators
- AI-curious professionals
- Tech enthusiasts
- Younger ambitious viewers
- Future-focused mainstream audience

---

## Series 01 — The Briefing

- **Primary Role:** Authority + trust + relevance
- **Concept:** Daily rapid update show covering the most important AI
  developments and what they mean in practical terms.
- **Audience Need:** "Tell me what matters without wasting my time."
- **Content Pillars:** AI launches, major company moves, industry
  disruption, business implications, trends to watch, tactical takeaways.
- **Format Feel:** Modern newsroom + sharp operator commentary.
- **Cadence:** Daily
- **Episode Length:** 45s / 90s / 3 min variants
- **Hook Style:** "This changes business today" / "Everyone missed this AI
  update" / "Why this matters more than it seems" / "Quiet launch, massive
  implications"
- **Success Metric:** Repeat daily viewers

## Series 02 — Tomorrow Broke

- **Primary Role:** Virality + emotional reach
- **Concept:** Cinematic short stories showing futures transformed by AI —
  utopia, dystopia, unintended consequences.
- **Audience Need:** "Show me what the future might actually feel like."
- **Content Pillars:** Jobs replaced, AI abundance, AI loneliness,
  governments + control, human purpose crisis, unexpected paradise
  scenarios, strange new lifestyles.
- **Format Feel:** Black Mirror + mini documentary + trailer energy.
- **Cadence:** Daily
- **Episode Length:** 30s / 60s / 2 min
- **Hook Style:** "In 2034 nobody saw it coming" / "The last human worker
  clocked out today" / "This city let AI run everything" / "Nobody thought
  paradise would feel this empty"
- **Success Metric:** Shares + comments

## Series 03 — Mind Wars

- **Primary Role:** Prestige + retention + intellectual brand
- **Concept:** High-interest debates between AI, philosophers, founders,
  economists, historical figures, or opposing futures.
- **Audience Need:** "Make me think."
- **Content Pillars:** Meaning of work, consciousness, AGI rights, wealth
  concentration, human identity, ethics of automation, progress vs risk.
- **Format Feel:** Premium debate show + provocative podcast clips.
- **Cadence:** Daily clips / regular longform
- **Episode Length:** 60s clips / 8–20 min full episodes
- **Hook Style:** "ChatGPT just challenged this belief" / "Nietzsche debates
  AGI" / "Should AI own property?" / "The strongest argument against human
  labor"
- **Success Metric:** Watch time + saves + deep comments

## Series 04 — Operator Mode

- **Primary Role:** Conversion + buyer intent
- **Concept:** Practical AI systems for real businesses. Less theory, more
  execution.
- **Audience Need:** "How do I use AI to save time, grow revenue, reduce
  chaos?"
- **Content Pillars:** Sales automation, customer support AI, lead gen
  systems, hiring workflows, ops automation, agency systems, SMB wins, case
  studies.
- **Format Feel:** Sharp founder/operator advice.
- **Cadence:** Daily
- **Episode Length:** 60s / 3 min / 8 min
- **Hook Style:** "If I ran a small business today I'd do this" / "This AI
  workflow replaces 10 hours/week" / "Most teams use AI completely wrong" /
  "The easiest AI win nobody is using"
- **Success Metric:** Inbound leads + clicks + qualified viewers

## Series 05 — Bot Beats  *(DEFERRED — v2)*

> This series is registered with `enabled: false` and is NOT in the v1
> launch. It ships once Lyria-in-render is cleanly scoped.

- **Primary Role:** Memes + broad reach + cultural identity
- **Concept:** AI-generated songs, remixes, parody anthems, trend-reactive
  musical content around startups, work, tech, society.
- **Audience Need:** "Entertain me with future culture."
- **Content Pillars:** Founder songs, AI employee anthem, burnout remix,
  prompt engineer trap, robot heartbreak, startup parody, viral trend
  remixes.
- **Format Feel:** Absurd, catchy, polished chaos.
- **Cadence:** Daily (future)
- **Episode Length:** 15s / 30s / 60s
- **Hook Style:** "AI made the startup anthem" / "This robot song goes too
  hard" / "Every founder needs this track" / "Burnout but make it future
  bass"
- **Success Metric:** Shares + rewatches + followers
- **Prereqs before enabling:**
  - Extract Lyria client into `src/integrations/music/lyria.ts`.
  - Extend `AudioRef` with `{ musicGen?: { prompt, durationSeconds } }`.
  - Build a prompt-for-song library (genre / tempo / vibe combinators).
  - Add Remotion-side `musicGen` resolver that calls Lyria at render time
    and caches by content hash.

---

## Channel Ecosystem Strategy

- **The Briefing** brings serious recurring viewers.
- **Tomorrow Broke** brings mass awareness.
- **Mind Wars** builds intellectual respect.
- **Operator Mode** creates customers.
- **Bot Beats** *(future)* expands reach to unexpected audiences.

Together: a full-stack attention engine.

---

## Visual Identity System

Full details in `brand-kit-system.md`.

| Series | Feel | Primary | Accent | Fonts |
|---|---|---|---|---|
| The Briefing | clean, sharp, newsroom | `#f4f7fb` | `#2563eb` | Merriweather + Inter |
| Tomorrow Broke | dark neon, cinematic | `#050510` | `#ff2d9c` | Smooch Sans + Inter |
| Mind Wars | minimal black/gold, premium | `#0a0a0a` | `#d4af37` | Playfair Display + Inter |
| Operator Mode | modern business green/graphite | `#0f1512` | `#22c55e` | Montserrat |
| Bot Beats *(v2)* | chaotic internet energy | `#0b0018` | `#ff3df1` | Poppins |

---

## Daily Scheduling Framework

| Slot | Time | Series |
|---|---|---|
| Morning | — | The Briefing |
| Late morning | — | Operator Mode |
| Afternoon | — | Mind Wars |
| Evening | — | Tomorrow Broke |
| Night | — | Bot Beats *(v2)* |

Daemon crons are staggered off `:00` to avoid parallel fires. See the
registry's `cadence.cron` per series.

---

## Content Rules for All Series

- First 2 seconds must hook.
- Never start slow.
- Every video answers: why should anyone care now?
- Strong titles. Strong thumbnails.
- Recurring format.
- Fast pacing.
- Emotional contrast.
- No corporate jargon.
- No hard selling.

---

## Monetization Soft Integration

Subtle attribution only:

- **On-screen:** *Powered by AIOS* (bottom-right, 15% opacity, fades after 2s)
- **Description CTA:** *We build autonomous AI systems for modern companies.*
- **Pinned Comment CTA:** *Want systems like this in your business? Learn more.*

Never turn episodes into ads.

---

## Phase Priority

Start with the strongest three, then scale.

1. The Briefing *(proof series — first unlisted upload)*
2. Tomorrow Broke
3. Operator Mode
4. Mind Wars
5. Bot Beats *(deferred — v2)*

---

## What Each Series Owns

Every series owns, inside ohwow:

- One `agent_workforce_projects` row (its project hub).
- 2–4 agents (`briefing-researcher`, `briefing-writer`, `briefing-editor`,
  etc.) with explicit `system_prompt`, `tools_enabled`, `file_access_paths`.
- One or more knowledge documents (show bible, source list, style memory).
- 2–3 goals (`briefing-7d-avg-watch-time`, etc.) with per-series `kpi_id`
  prefixes that the strategist reads from `lift_measurements`.
- Per-episode plans (`agent_workforce_plan_steps`) encoding the DAG:
  source → draft → voice → render → review → approve → upload → metrics.

And, outside ohwow (in this repo):

- One brand-kit JSON: `packages/video/brand-kits/<slug>.json`
- One prompt module: `src/integrations/youtube/series/script-prompts/<slug>-prompt.ts`
- One seed adapter: `src/integrations/youtube/series/seed-adapters/<slug>-seed.ts`
- One compose wrapper: `scripts/yt-experiments/yt-compose-<slug>.mjs`
- One daemon automation entry: `src/daemon/seed-yt-automations.ts`
- One kill-switch env: `OHWOW_YT_<SERIES>_ENABLED`
- One approval-queue kind: `yt_short_draft_<slug>`
- One show-bible doc: `docs/youtube/<slug>-showbible.md`

Run `node scripts/yt-experiments/yt-series-bootstrap.mjs <slug>` once per
series to create the ohwow side; it's idempotent.
