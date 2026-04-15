#!/usr/bin/env bash
# db-query.sh — general-purpose sqlite3 query runner against the ohwow runtime DB.
# Usage: ./db-query.sh "SELECT ..." [workspace]
# The system uses this for ad-hoc diagnostics without the HTTP API.

set -euo pipefail

WORKSPACE="${2:-default}"
DB="${OHWOW_DB:-$HOME/.ohwow/workspaces/$WORKSPACE/runtime.db}"

if [[ -z "${1:-}" ]]; then
  echo "Usage: db-query.sh <sql> [workspace]" >&2
  echo "Tables: self_findings, agent_workforce_tasks, agent_workforce_agents, llm_calls" >&2
  exit 1
fi

if [[ ! -f "$DB" ]]; then
  echo "DB not found: $DB" >&2
  exit 1
fi

sqlite3 -json "$DB" "$1" 2>/dev/null || sqlite3 "$DB" "$1"
