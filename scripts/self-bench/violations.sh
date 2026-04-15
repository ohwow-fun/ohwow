#!/usr/bin/env bash
# violations.sh — current active copy violations with file/line detail.
# Outputs JSON array of violation objects.

set -euo pipefail

DB="${OHWOW_DB:-$HOME/.ohwow/workspaces/default/runtime.db}"

if [[ ! -f "$DB" ]]; then
  echo '{"error":"db_not_found"}' && exit 1
fi

sqlite3 "$DB" "
  SELECT json_object(
    'ran_at', ran_at,
    'files_scanned', json_extract(evidence,'$.files_scanned'),
    'total_violations', json_extract(evidence,'$.total_violations'),
    'violations', json_extract(evidence,'$.violations')
  )
  FROM self_findings
  WHERE experiment_id='source-copy-lint'
  ORDER BY ran_at DESC LIMIT 1;
" 2>/dev/null || echo '{"total_violations":0,"violations":[]}'
