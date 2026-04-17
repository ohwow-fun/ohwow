# Show Bible — The Briefing

> **Status:** skeleton. Run `node scripts/yt-experiments/yt-series-brief.mjs briefing`
> to fill this doc with deep-research findings and re-ingest as a knowledge
> item the `briefing-researcher` agent RAGs into.

## One-liner

Daily rapid-update AI news Short. Tell a busy operator what changed today
and why it matters — concrete fact, single business implication, one
tactical takeaway. No hedging.

## Voice

Credible, newsroom-anchor cadence. Clear, confident, no hedging. Pace is
slightly faster than Tomorrow Broke; pauses are shorter. Host position:
insider, not observer.

## Format contract

**Length:** 45s default. 90s and 3 min extended cuts for big stories only.

**Structure:** 3 scenes (45s cut):

1. **Hook (0–3s)** — the news as a sentence. Actor + artifact. *"Anthropic
   just shipped X."* Text on screen from frame 1.
2. **Fact (3–20s)** — concrete details: what it does, who it's for, how
   it's different. Real numbers / versions / names. No vibes.
3. **Implication (20–40s)** — the single business consequence. Operator
   lens: what does this change for builders / SMBs / agencies?
4. **Takeaway (40–45s)** — one-line action or watch-for. *"Watch for this
   to land in Claude Code next quarter."* Closes the loop.

## Source rules

Primary: x-intel `bucket='advancements'` rows from the last 24h.
Fallback: researcher agent with web search tool if no fresh rows.

**Must cite the actor** (company / researcher / open-source project).
Paraphrase claims; never fabricate numbers. If the source is a rumor, say
so.

## Banned

- "Everyone is talking about…" — if we're covering it, the viewer already
  knows people are talking
- "Game-changer" / "unprecedented" / any corporate superlative
- OHWOW self-references (same list as x-compose banned phrases)
- Hedging: "some argue", "it's possible that", "experts say"

## Success metric

7-day avg watch time. Target: ≥60% completion rate at 45s.

## Deep-research checklist

<!-- Filled by yt-series-brief.mjs -->

- [ ] What daily AI-news Shorts are working in 2026 (who, what, why)?
- [ ] What hook patterns open above 70%?
- [ ] What format lengths retain best for news content?
- [ ] What failure modes dominate (talking-head boring, too-long,
      corporate, wrong-audience)?
- [ ] Sources to monitor beyond x-intel (benchmarks, release notes, gov
      announcements, leaks).
