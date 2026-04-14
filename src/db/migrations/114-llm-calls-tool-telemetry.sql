-- =====================================================================
-- Migration 114: LLM call tool-use telemetry
--
-- Adds per-row "did this model actually call tools on this call" signal
-- to llm_calls. The agent ReAct loops (react-loop.ts, model-router-loop.ts)
-- will start writing rows here after commit B wires them up — today the
-- table only has runLlmCall and orchestrator chat, so agent iterations
-- are invisible to telemetry.
--
-- Columns:
--   tool_call_count — integer count of tool_calls in the model response
--                     for this single LLM call. NULL when not meaningful
--                     (e.g. a generation purpose call that wasn't offered
--                     tools). 0 is a real value — means the model was
--                     offered tools and chose not to call any.
--   task_shape      — 'work' when looksLikeToolWork(taskInput) is true
--                     at the call site, 'chat' when it's false, NULL when
--                     the call site doesn't have a task input (ad-hoc
--                     /api/llm, orchestrator chat without a task, etc.).
--
-- Enables E1's selector self-healing: query the rolling tool-call rate
-- per (model, task_shape='work') and auto-demote models with <40% rate
-- from the FAST agent tier.
-- =====================================================================

-- @statement
ALTER TABLE llm_calls ADD COLUMN tool_call_count INTEGER;
-- @statement
ALTER TABLE llm_calls ADD COLUMN task_shape TEXT;
-- @statement
CREATE INDEX IF NOT EXISTS llm_calls_model_shape_idx
  ON llm_calls(model, task_shape, created_at DESC);
