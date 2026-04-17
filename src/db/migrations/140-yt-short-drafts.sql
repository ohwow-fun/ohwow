-- 140-yt-short-drafts.sql
-- Staged YouTube Shorts drafts and per-episode metrics, one row per
-- (workspace, series, episode). Parallel to x_post_drafts but with
-- the extra fields a video pipeline needs — series slug, brief JSON,
-- video path, upload URL, and lift-measurement-friendly kpi_ids.
--
-- The compose pipeline (scripts/yt-experiments/yt-compose-core.mjs)
-- inserts one row here when a draft clears visual self-review. The
-- row moves pending → approved (human flip) → uploaded → live. When
-- the uploaded video has a videoId, the yt-metrics poller writes
-- per-poll rows to yt_episode_metrics.
--
-- series column is the slug from src/integrations/youtube/series/
-- registry.ts (briefing, tomorrow-broke, mind-wars, operator-mode,
-- bot-beats). The registry is the authority; this column is for
-- scoping queries, not validation — we keep the check loose so new
-- series don't require a schema migration.
--
-- source_seed_id dedupes against the seed adapter's seen-set when a
-- compose run produces the same brief twice. It's NOT a foreign key
-- because seeds live in workspace JSONL, not in the DB.

CREATE TABLE IF NOT EXISTS yt_short_drafts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  series TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  narration TEXT NOT NULL,
  brief_json TEXT,               -- full draft + spec + visual review
  video_path TEXT,               -- absolute path to rendered MP4
  source_seed_id TEXT,           -- seen-set hash the adapter emitted
  confidence REAL,               -- draft confidence (0..1)
  visual_review_score INTEGER,   -- 0..10 from gemini vision pass
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'uploaded', 'failed')),
  visibility TEXT
    CHECK (visibility IN ('private', 'unlisted', 'public') OR visibility IS NULL),
  video_url TEXT,                -- YouTube URL once uploaded
  video_id TEXT,                 -- YouTube videoId, used by metrics poller
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  rejected_at TEXT,
  uploaded_at TEXT,
  UNIQUE (workspace_id, series, source_seed_id)
);

CREATE INDEX IF NOT EXISTS idx_yt_short_drafts_ws_series_status
  ON yt_short_drafts (workspace_id, series, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_yt_short_drafts_video_id
  ON yt_short_drafts (video_id)
  WHERE video_id IS NOT NULL;

-- Per-video metric snapshots. One row per (video, poll_horizon). The
-- metrics poller (src/scheduling/yt-metrics-poller.ts) writes T+1h,
-- +24h, +7d samples. kpi_id is filled at the final horizon so the
-- strategist can pick up per-series lift rows via
-- lift_measurements.kpi_id LIKE 'yt_<series>_%' without a schema join.
--
-- draft_id references yt_short_drafts.id so we can reconstruct which
-- approval row produced which uploaded video.

CREATE TABLE IF NOT EXISTS yt_episode_metrics (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  draft_id TEXT NOT NULL REFERENCES yt_short_drafts(id) ON DELETE CASCADE,
  series TEXT NOT NULL,
  video_id TEXT NOT NULL,
  poll_horizon_hours INTEGER NOT NULL,  -- 1, 24, 168
  polled_at TEXT NOT NULL DEFAULT (datetime('now')),
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  avg_watch_pct REAL,                   -- 0..100
  retention_curve_json TEXT,            -- optional: per-second retention
  kpi_id TEXT,                          -- set only at the final poll
  UNIQUE (video_id, poll_horizon_hours)
);

CREATE INDEX IF NOT EXISTS idx_yt_episode_metrics_series_horizon
  ON yt_episode_metrics (series, poll_horizon_hours, polled_at DESC);
CREATE INDEX IF NOT EXISTS idx_yt_episode_metrics_draft
  ON yt_episode_metrics (draft_id, poll_horizon_hours);
