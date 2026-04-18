-- 141-llm-calls-origin.sql
-- Split autonomous vs interactive LLM spend for gap 13 budget enforcement.
--
-- The per-workspace daily cap in `createBudgetMeter` only guards the
-- autonomous loop (schedulers, self-bench, content-cadence, agents the
-- daemon fires on its own). Today every row in llm_calls is summed as
-- autonomous spend, which means a founder chatting in the TUI or running
-- a manual tool invocation erodes headroom for the autonomous side. The
-- cap can trip on bogus numbers and halt autonomous work using spend the
-- cap was never meant to guard.
--
-- This migration adds an `origin` column so the meter can filter the
-- sum to `origin = 'autonomous'`. Defaulting to `'autonomous'` is the
-- cost-safe choice and matches the meter's current behavior exactly:
-- every existing row backfills as autonomous, no spend goes "missing",
-- and the cap keeps tripping conservatively until callers start passing
-- `'interactive'` explicitly (tagging the interactive entry points is
-- the next round).
--
-- SQLite note: ALTER TABLE ADD COLUMN supports a NOT NULL constraint
-- when paired with a literal DEFAULT, which 'autonomous' is. No shim
-- needed. The partial index keeps the meter's hot path cheap: it only
-- covers the rows the meter actually reads (origin='autonomous', scoped
-- to a single workspace, ordered by created_at for the UTC-midnight
-- lower bound).

-- @statement
ALTER TABLE llm_calls ADD COLUMN origin TEXT NOT NULL DEFAULT 'autonomous';

-- @statement
CREATE INDEX IF NOT EXISTS idx_llm_calls_autonomous_spend
  ON llm_calls (workspace_id, created_at DESC)
  WHERE origin = 'autonomous';
