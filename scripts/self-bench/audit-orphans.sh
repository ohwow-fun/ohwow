#!/usr/bin/env bash
# audit-orphans.sh — detect orphan files inside the self-bench sandbox.
#
# Scope: files under src/self-bench/experiments/ that are untracked by git
# AND have no matching entry in ~/.ohwow/self-commit-log (so they did not
# come from safeSelfCommit). Common causes: interrupted vitest runs that
# leaked a *-smoke-<timestamp>.ts file (experiment-template.test.ts),
# aborted autonomous authoring attempts, manual scratch files.
#
# Usage:
#   ./audit-orphans.sh            # print JSON report to stdout
#   ./audit-orphans.sh --clean    # also delete the orphans (confirmation
#                                   prompt; pass --force to skip it)
# Environment:
#   OHWOW_REPO        repo root (default: ~/Documents/ohwow/ohwow)
#   OHWOW_AUDIT_LOG   audit log path (default: ~/.ohwow/self-commit-log)

set -euo pipefail

REPO="${OHWOW_REPO:-$HOME/Documents/ohwow/ohwow}"
AUDIT_LOG="${OHWOW_AUDIT_LOG:-$HOME/.ohwow/self-commit-log}"
SANDBOX="src/self-bench/experiments"

CLEAN=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

cd "$REPO"

ORPHAN_LIST=$(mktemp)
trap 'rm -f "$ORPHAN_LIST"' EXIT

git ls-files --others --exclude-standard -- "$SANDBOX" | while read -r f; do
  [[ -z "$f" ]] && continue
  if [[ -f "$AUDIT_LOG" ]] && grep -qF "\"$f\"" "$AUDIT_LOG" 2>/dev/null; then
    continue
  fi
  echo "$f" >> "$ORPHAN_LIST"
done

python3 - "$ORPHAN_LIST" "$REPO" "$SANDBOX" "$AUDIT_LOG" <<'PY'
import json, os, sys
list_path, repo, sandbox, audit_log = sys.argv[1:5]
rows = []
with open(list_path) as fh:
    for line in fh:
        p = line.strip()
        if not p: continue
        abs_p = os.path.join(repo, p)
        try:
            st = os.stat(abs_p)
            rows.append({"path": p, "size_bytes": st.st_size, "mtime_epoch": int(st.st_mtime)})
        except OSError:
            rows.append({"path": p, "size_bytes": None, "mtime_epoch": None})
print(json.dumps({
    "sandbox": sandbox, "audit_log": audit_log,
    "count": len(rows), "orphans": rows,
}, indent=2))
PY

ORPHAN_COUNT=$(wc -l < "$ORPHAN_LIST" | tr -d ' ')

if [[ "$CLEAN" -eq 1 && "$ORPHAN_COUNT" -gt 0 ]]; then
  echo "" >&2
  echo "Would delete $ORPHAN_COUNT orphan(s):" >&2
  sed 's/^/  /' "$ORPHAN_LIST" >&2
  if [[ "$FORCE" -eq 0 ]]; then
    read -r -p "Delete? [y/N] " ans
    [[ "$ans" =~ ^[Yy] ]] || { echo "aborted." >&2; exit 0; }
  fi
  while read -r f; do [[ -n "$f" ]] && rm -f "$REPO/$f"; done < "$ORPHAN_LIST"
  echo "deleted $ORPHAN_COUNT file(s)." >&2
fi
