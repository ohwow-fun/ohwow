-- Normalize agent_workforce_deliverables.created_at to ISO-8601 with a
-- trailing Z, so lexicographic comparison against JS `.toISOString()`
-- filter values in list_deliverables works correctly.
--
-- Background: the schema default is `datetime('now')`, which outputs
-- `YYYY-MM-DD HH:MM:SS` (space separator, no milliseconds, no Z).
-- One insert path (deliverables-recorder.ts) explicitly writes
-- `new Date().toISOString()` so those rows land as
-- `YYYY-MM-DDTHH:MM:SS.mmmZ`. Two other insert paths (saveDeliverable,
-- task-completion.ts) omit created_at entirely and fall back to the
-- default. That produces a mixed table: 24 rows in ISO-with-Z, 50 rows
-- in SQL-default.
--
-- list_deliverables' `since` filter calls `.gte('created_at', iso)`
-- where `iso` is always ISO-with-Z. SQLite compares lexicographically.
-- Position 10 of the string decides: space (0x20) < 'T' (0x54), so
-- every SQL-default row silently sorts BEFORE any ISO-with-Z filter,
-- and gets excluded even when it's chronologically newer. Found during
-- the M0.21 self-bench moonshot — ohwow reported 25 deliverables in
-- the 24h window when the real answer was 38. 13 rows lost to format
-- drift.
--
-- Fix:
--   1. Backfill every row whose created_at is missing a T or Z to ISO.
--      `strftime('%Y-%m-%dT%H:%M:%f', col) || 'Z'` produces
--      `2026-04-13T19:46:18.000Z` regardless of the original shape.
--   2. Do the same for updated_at since the same inserts leave it with
--      the SQL default.
--   3. Use LIKE filters so re-running the migration is a no-op.
--
-- The downstream insert sites (saveDeliverable, task-completion.ts)
-- are fixed in the same commit so new rows land in ISO from here on.

UPDATE agent_workforce_deliverables
SET created_at = strftime('%Y-%m-%dT%H:%M:%f', created_at) || 'Z'
WHERE created_at NOT LIKE '%T%Z';

UPDATE agent_workforce_deliverables
SET updated_at = strftime('%Y-%m-%dT%H:%M:%f', updated_at) || 'Z'
WHERE updated_at IS NOT NULL AND updated_at NOT LIKE '%T%Z';
