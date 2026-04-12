-- Shape C: agents are sub-orchestrators, not single-model wrappers.
--
-- Moves any existing `config.model` string on agent rows into
-- `config.model_policy.default`, then removes the legacy `config.model` key
-- so downstream code never reads it again. Agents that already carry a
-- `model_policy` are left alone. Agents without a model at all are also
-- untouched.
--
-- Idempotent and safe to re-run: the WHERE clause narrows to rows that
-- both (a) still have `config.model` and (b) do not yet have
-- `config.model_policy.default`.

UPDATE agent_workforce_agents
SET config = json_remove(
  json_set(
    config,
    '$.model_policy.default',
    json_extract(config, '$.model')
  ),
  '$.model'
)
WHERE json_extract(config, '$.model') IS NOT NULL
  AND json_extract(config, '$.model_policy.default') IS NULL;

-- For rows that had `config.model` AND already had a `model_policy` but
-- no default set: the previous UPDATE handled the "no default" case. For
-- rows with both a legacy `config.model` AND an existing
-- `model_policy.default`, we drop the legacy key without overwriting the
-- policy — the policy wins.
UPDATE agent_workforce_agents
SET config = json_remove(config, '$.model')
WHERE json_extract(config, '$.model') IS NOT NULL;
