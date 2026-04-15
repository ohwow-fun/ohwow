#!/usr/bin/env bash
# loop-status.sh — snapshot of the autonomous self-improvement loop.
# Used by operators and RoadmapUpdaterExperiment.probe().
# Outputs structured JSON to stdout.

set -euo pipefail

DB="${OHWOW_DB:-$HOME/.ohwow/workspaces/default/runtime.db}"
REPO="${OHWOW_REPO:-$HOME/Documents/ohwow/ohwow}"

if [[ ! -f "$DB" ]]; then
  echo '{"error":"db_not_found","db":"'"$DB"'"}' && exit 1
fi

# --- Loop health (latest patch-loop-health finding) ---
HEALTH=$(sqlite3 "$DB" "
  SELECT json_object(
    'ran_at', ran_at,
    'verdict', verdict,
    'summary', summary,
    'hold_rate', json_extract(evidence,'$.hold_rate'),
    'patches_landed', json_extract(evidence,'$.patches_landed'),
    'patches_reverted', json_extract(evidence,'$.patches_reverted'),
    'violation_pool_today', json_extract(evidence,'$.violation_pool_today')
  )
  FROM self_findings
  WHERE experiment_id='patch-loop-health'
  ORDER BY ran_at DESC LIMIT 1;
" 2>/dev/null || echo '{}')

# --- Active violations (latest source-copy-lint finding) ---
VIOLATIONS=$(sqlite3 "$DB" "
  SELECT json_object(
    'ran_at', ran_at,
    'verdict', verdict,
    'total_violations', json_extract(evidence,'$.total_violations'),
    'files_with_violations', json_extract(evidence,'$.files_with_violations'),
    'violations', json_extract(evidence,'$.violations')
  )
  FROM self_findings
  WHERE experiment_id='source-copy-lint'
  ORDER BY ran_at DESC LIMIT 1;
" 2>/dev/null || echo '{}')

# --- Recent autonomous patches (last 24h from git log) ---
PATCHES=$(git -C "$REPO" log \
  --since="24 hours ago" \
  --pretty=format:'{"sha":"%h","msg":"%s","time":"%aI"}' \
  --grep="Fixes-Finding-Id" 2>/dev/null | paste -sd',' || echo '')

# --- Proposal queue ---
PROPOSALS=$(sqlite3 "$DB" "
  SELECT json_object(
    'ran_at', ran_at,
    'verdict', verdict,
    'summary', summary
  )
  FROM self_findings
  WHERE experiment_id='experiment-proposal-generator'
  ORDER BY ran_at DESC LIMIT 1;
" 2>/dev/null || echo '{}')

# --- Patch author (latest) ---
PATCH_AUTHOR=$(sqlite3 "$DB" "
  SELECT json_object(
    'ran_at', ran_at,
    'verdict', verdict,
    'summary', summary,
    'last_intervention', json_extract(intervention_applied,'$.description')
  )
  FROM self_findings
  WHERE experiment_id='patch-author'
  ORDER BY ran_at DESC LIMIT 1;
" 2>/dev/null || echo '{}')

# --- Roadmap last updated ---
ROADMAP_MTIME=$(stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%SZ' "$REPO/AUTONOMY_ROADMAP.md" 2>/dev/null || echo 'unknown')

NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

cat <<JSON
{
  "generated_at": "$NOW",
  "roadmap_last_modified": "$ROADMAP_MTIME",
  "loop_health": $HEALTH,
  "violations": $VIOLATIONS,
  "recent_patches": [${PATCHES}],
  "proposals": $PROPOSALS,
  "patch_author": $PATCH_AUTHOR
}
JSON
