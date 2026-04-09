-- =====================================================================
-- MEETING SESSIONS (local audio capture + transcription)
-- Stores live meeting listening sessions with running transcript and notes.
-- =====================================================================

CREATE TABLE IF NOT EXISTS meeting_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'listening',
  app TEXT NOT NULL DEFAULT 'all',
  transcript TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '{}',
  chunk_count INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  cloud_session_id TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_meeting_sessions_workspace
  ON meeting_sessions(workspace_id, status);
