/**
 * Series registry — the source of truth for which YouTube shows OHWOW.FUN runs.
 *
 * A "series" is a recurring franchise on the channel. Each series has its own
 * seed source, script prompt, voice, visual brand kit, cadence, and success
 * metric. The compose pipeline (`yt-compose-core.mjs`) reads the registry at
 * runtime and dispatches to per-series modules.
 *
 * Bot Beats is intentionally present but `enabled: false` — it's deferred to
 * v2 because music-in-render requires Lyria integration work that's out of
 * scope for the first cut.
 */

export type SeriesSlug =
  | "briefing"
  | "tomorrow-broke"
  | "mind-wars"
  | "operator-mode"
  | "bot-beats";

export type VoiceProvider = "openrouter" | "kokoro";

export interface SeriesVoiceConfig {
  provider: VoiceProvider;
  voiceName: string;
  speed: number;
  /**
   * Prepended to the TTS system prompt when the provider is OpenRouter. Shapes
   * prosody (pacing, mood) without changing the narration text itself.
   */
  prosodyPrompt: string;
}

export interface SeriesCadence {
  /** Cron expression for the daemon automation that fires this series' compose script. */
  cron: string;
  /** Human-readable slot name (morning, late-morning, afternoon, evening, night). */
  slot: "morning" | "late-morning" | "afternoon" | "evening" | "night";
  /** Target episodes per week. Informational; actual cadence is the cron. */
  perWeek: number;
}

export interface SeriesConfig {
  slug: SeriesSlug;
  displayName: string;
  role:
    | "authority"
    | "virality"
    | "prestige"
    | "conversion"
    | "memes";
  tagline: string;
  enabled: boolean;

  /** Path to the brand-kit JSON relative to packages/video/brand-kits/. */
  brandKitFile: `${SeriesSlug}.json`;

  voice: SeriesVoiceConfig;
  cadence: SeriesCadence;

  /** Default visibility for automated uploads until human flips to public. */
  defaultVisibility: "private" | "unlisted" | "public";

  /** YouTube hashtag suffix appended to every description. Kept short: 3-5 tags. */
  hashtags: string[];

  /**
   * lift_measurements kpi_ids the strategist reads for this series. Scoped via
   * id prefix rather than a series column so no schema change is needed.
   */
  goalKpiIds: string[];

  /** Env var name for the per-series kill switch. */
  killSwitchEnv: string;

  /** Approval queue kind. Routed through propose() with bucketBy='series'. */
  approvalKind: `yt_short_draft_${SeriesSlug}`;
}

export const SERIES: Record<SeriesSlug, SeriesConfig> = {
  briefing: {
    slug: "briefing",
    displayName: "The Briefing",
    role: "authority",
    tagline: "Tell me what matters without wasting my time.",
    enabled: true,
    brandKitFile: "briefing.json",
    voice: {
      provider: "openrouter",
      voiceName: "alloy",
      speed: 1.05,
      prosodyPrompt:
        "Credible, newsroom-anchor cadence. Clear, confident, no hedging. " +
        "Slight forward-lean. Crisp consonants.",
    },
    cadence: {
      cron: "3 13 * * *",
      slot: "morning",
      perWeek: 7,
    },
    defaultVisibility: "unlisted",
    hashtags: ["#AI", "#AINews", "#Shorts"],
    goalKpiIds: [
      "yt_briefing_7d_avg_watch_time",
      "yt_briefing_7d_subscribers_gained",
      "yt_briefing_daily_streak",
    ],
    killSwitchEnv: "OHWOW_YT_BRIEFING_ENABLED",
    approvalKind: "yt_short_draft_briefing",
  },

  "tomorrow-broke": {
    slug: "tomorrow-broke",
    displayName: "Tomorrow Broke",
    role: "virality",
    tagline: "Show me what the future might actually feel like.",
    enabled: true,
    brandKitFile: "tomorrow-broke.json",
    voice: {
      provider: "openrouter",
      voiceName: "onyx",
      speed: 0.95,
      prosodyPrompt:
        "Noir narrator. Deadpan, understated, slightly ominous. Take your " +
        "time. Let each sentence breathe. Observing something everyone " +
        "missed.",
    },
    cadence: {
      cron: "18 1 * * *",
      slot: "evening",
      perWeek: 7,
    },
    defaultVisibility: "unlisted",
    hashtags: ["#AI", "#Future", "#Shorts"],
    goalKpiIds: [
      "yt_tomorrow_broke_7d_shares",
      "yt_tomorrow_broke_7d_comments",
      "yt_tomorrow_broke_completion_rate",
    ],
    killSwitchEnv: "OHWOW_YT_TOMORROW_BROKE_ENABLED",
    approvalKind: "yt_short_draft_tomorrow-broke",
  },

  "mind-wars": {
    slug: "mind-wars",
    displayName: "Mind Wars",
    role: "prestige",
    tagline: "Make me think.",
    enabled: true,
    brandKitFile: "mind-wars.json",
    voice: {
      provider: "openrouter",
      voiceName: "fable",
      speed: 1.0,
      prosodyPrompt:
        "Thoughtful moderator. Measured, curious, precise. Hold the tension " +
        "between two opposing ideas without taking sides.",
    },
    cadence: {
      cron: "13 21 * * *",
      slot: "afternoon",
      perWeek: 5,
    },
    defaultVisibility: "unlisted",
    hashtags: ["#AI", "#Debate", "#Philosophy", "#Shorts"],
    goalKpiIds: [
      "yt_mind_wars_7d_avg_watch_time",
      "yt_mind_wars_7d_saves",
      "yt_mind_wars_comment_depth",
    ],
    killSwitchEnv: "OHWOW_YT_MIND_WARS_ENABLED",
    approvalKind: "yt_short_draft_mind-wars",
  },

  "operator-mode": {
    slug: "operator-mode",
    displayName: "Operator Mode",
    role: "conversion",
    tagline: "How do I use AI to save time, grow revenue, reduce chaos?",
    enabled: true,
    brandKitFile: "operator-mode.json",
    voice: {
      provider: "openrouter",
      voiceName: "sage",
      speed: 1.05,
      prosodyPrompt:
        "Operator-to-operator. Warm, direct, experienced. Like a peer showing " +
        "you the trick they use every day. No pitch energy.",
    },
    cadence: {
      cron: "8 16 * * *",
      slot: "late-morning",
      perWeek: 5,
    },
    defaultVisibility: "unlisted",
    hashtags: ["#AI", "#Business", "#Ops", "#Shorts"],
    goalKpiIds: [
      "yt_operator_mode_7d_inbound_leads",
      "yt_operator_mode_7d_clicks_to_site",
      "yt_operator_mode_qualified_viewers",
    ],
    killSwitchEnv: "OHWOW_YT_OPERATOR_MODE_ENABLED",
    approvalKind: "yt_short_draft_operator-mode",
  },

  "bot-beats": {
    slug: "bot-beats",
    displayName: "Bot Beats",
    role: "memes",
    tagline: "Entertain me with future culture.",
    enabled: false,
    brandKitFile: "bot-beats.json",
    voice: {
      provider: "openrouter",
      voiceName: "ash",
      speed: 1.0,
      prosodyPrompt:
        "Playful, stylized hook delivery. Short stabs over beats. Energy " +
        "high. Most of the runtime is music, not voice.",
    },
    cadence: {
      cron: "23 5 * * *",
      slot: "night",
      perWeek: 4,
    },
    defaultVisibility: "private",
    hashtags: ["#AIMusic", "#Shorts"],
    goalKpiIds: [
      "yt_bot_beats_7d_shares",
      "yt_bot_beats_7d_rewatches",
      "yt_bot_beats_7d_followers_gained",
    ],
    killSwitchEnv: "OHWOW_YT_BOT_BEATS_ENABLED",
    approvalKind: "yt_short_draft_bot-beats",
  },
};

export function listSeries(opts: { onlyEnabled?: boolean } = {}): SeriesConfig[] {
  const all = Object.values(SERIES);
  return opts.onlyEnabled ? all.filter((s) => s.enabled) : all;
}

export function getSeries(slug: SeriesSlug): SeriesConfig {
  const s = SERIES[slug];
  if (!s) throw new Error(`unknown series: ${slug}`);
  return s;
}

export function assertSeriesEnabled(slug: SeriesSlug): void {
  const s = getSeries(slug);
  if (!s.enabled) {
    throw new Error(
      `series '${slug}' is disabled in the registry. Flip enabled:true once the pipeline is ready.`,
    );
  }
}
