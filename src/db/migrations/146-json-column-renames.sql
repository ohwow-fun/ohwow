-- Rename JSON-as-text columns to add _json suffix (enables coerceValue auto-parse)
ALTER TABLE director_arcs RENAME COLUMN pulse_at_entry TO pulse_at_entry_json;
ALTER TABLE director_arcs RENAME COLUMN pulse_at_close TO pulse_at_close_json;
ALTER TABLE director_phase_reports RENAME COLUMN delta_ledger TO delta_ledger_json;
ALTER TABLE director_phase_reports RENAME COLUMN inbox_added TO inbox_added_json;
ALTER TABLE phase_rounds RENAME COLUMN findings_written TO findings_written_json;
ALTER TABLE phase_rounds RENAME COLUMN commits TO commits_json;
ALTER TABLE x_dm_threads RENAME COLUMN raw_meta TO raw_meta_json;
