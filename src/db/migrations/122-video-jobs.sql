-- 122-video-jobs.sql
-- Tracking table for deterministic video renders driven by the
-- video_generation skill (src/execution/skills/video_generation.ts).
--
-- Each job corresponds to one VideoSpec → MP4 pipeline invocation. The
-- spec_hash column lets us dedupe: if a prior job with the same spec
-- hash is already 'done', callers can short-circuit and reuse that MP4
-- instead of re-rendering.
--
-- Checkpoints live in a child table so a crashed daemon can resume from
-- the last completed stage without losing earlier work (rendered voice,
-- generated music, timing solver output).

CREATE TABLE IF NOT EXISTS video_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  spec_hash TEXT NOT NULL,
  spec_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending','preparing','resolving','rendering','storing',
    'done','failed','canceled'
  )),
  progress REAL NOT NULL DEFAULT 0,
  stage TEXT,
  error TEXT,
  output_path TEXT,
  size_bytes INTEGER,
  duration_frames INTEGER,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_video_jobs_workspace_status
  ON video_jobs(workspace_id, status);
-- @statement
CREATE INDEX IF NOT EXISTS idx_video_jobs_spec_hash
  ON video_jobs(spec_hash);
-- @statement
CREATE INDEX IF NOT EXISTS idx_video_jobs_created
  ON video_jobs(created_at DESC);
-- @statement
CREATE TABLE IF NOT EXISTS video_job_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES video_jobs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_vjc_job_stage
  ON video_job_checkpoints(job_id, stage);
