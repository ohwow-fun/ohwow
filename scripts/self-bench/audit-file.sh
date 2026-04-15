#!/usr/bin/env bash
# audit-file.sh — full provenance audit for one repo-relative file path.
#
# Aggregates everywhere the self-improvement loop might have touched the
# file: git history, safeSelfCommit audit log, daemon.log mentions, and
# self_findings rows that list the path in evidence.affected_files.
#
# Usage:
#   ./audit-file.sh <repo-relative-path>
# Example:
#   ./audit-file.sh src/self-bench/experiments/roadmap-updater.ts
#
# Environment:
#   OHWOW_REPO         repo root (default: ~/Documents/ohwow/ohwow)
#   OHWOW_AUDIT_LOG    audit log (default: ~/.ohwow/self-commit-log)
#   OHWOW_DAEMON_LOG   daemon log (default: workspace default daemon.log)
#   OHWOW_DB           sqlite db (default: workspace default runtime.db)

set -euo pipefail

if [[ $# -ne 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  sed -n '2,16p' "$0"; exit 0
fi

FILE="$1"
REPO="${OHWOW_REPO:-$HOME/Documents/ohwow/ohwow}"
AUDIT_LOG="${OHWOW_AUDIT_LOG:-$HOME/.ohwow/self-commit-log}"
DAEMON_LOG="${OHWOW_DAEMON_LOG:-$HOME/.ohwow/workspaces/default/daemon.log}"
DB="${OHWOW_DB:-$HOME/.ohwow/workspaces/default/runtime.db}"

abs="$REPO/$FILE"

# --- Filesystem ---
if [[ -e "$abs" ]]; then
  FS=$(python3 - "$abs" <<'PY'
import json, os, sys
p = sys.argv[1]
st = os.stat(p)
print(json.dumps({
    "exists": True,
    "size_bytes": st.st_size,
    "mtime_iso": __import__("datetime").datetime.utcfromtimestamp(int(st.st_mtime)).isoformat() + "Z",
}))
PY
)
else
  FS='{"exists": false}'
fi

# --- Git: tracked? commits touching the path. ---
TRACKED=$(git -C "$REPO" ls-files --error-unmatch "$FILE" >/dev/null 2>&1 && echo true || echo false)
GIT_LOG=$(git -C "$REPO" log --all --pretty=format:'%h%x09%aI%x09%s' -- "$FILE" 2>/dev/null \
  | python3 -c 'import sys,json; rows=[]
for line in sys.stdin:
    parts = line.rstrip("\n").split("\t", 2)
    if len(parts) == 3:
        rows.append({"sha": parts[0], "time": parts[1], "subject": parts[2]})
print(json.dumps(rows))')

# --- safeSelfCommit audit log matches ---
AUDIT_MATCHES='[]'
if [[ -f "$AUDIT_LOG" ]]; then
  AUDIT_MATCHES=$({ grep -F "\"$FILE\"" "$AUDIT_LOG" 2>/dev/null || true; } \
    | python3 -c 'import sys,json; print(json.dumps([l.rstrip("\n") for l in sys.stdin]))')
fi

# --- Daemon log grep (cap to 20 most recent matches) ---
DAEMON_MATCHES='[]'
if [[ -f "$DAEMON_LOG" ]]; then
  DAEMON_MATCHES=$({ grep -F "$FILE" "$DAEMON_LOG" 2>/dev/null || true; } | tail -20 \
    | python3 -c 'import sys,json; print(json.dumps([l.rstrip("\n") for l in sys.stdin]))')
fi

# --- self_findings with affected_files containing this path ---
FINDINGS='[]'
if [[ -f "$DB" ]]; then
  FINDINGS=$(sqlite3 "$DB" "
    SELECT json_group_array(json_object(
      'id', id, 'ran_at', ran_at, 'experiment_id', experiment_id,
      'verdict', verdict, 'summary', summary
    ))
    FROM self_findings
    WHERE json_extract(evidence, '\$.affected_files') LIKE '%\"$FILE\"%'
    ORDER BY ran_at DESC LIMIT 20;
  " 2>/dev/null || echo '[]')
  [[ -z "$FINDINGS" ]] && FINDINGS='[]'
fi

cat <<JSON
{
  "file": "$FILE",
  "filesystem": $FS,
  "git_tracked": $TRACKED,
  "git_commits": $GIT_LOG,
  "audit_log_matches": $AUDIT_MATCHES,
  "daemon_log_matches": $DAEMON_MATCHES,
  "findings_with_affected_file": $FINDINGS
}
JSON
