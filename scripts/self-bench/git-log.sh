#!/usr/bin/env bash
# git-log.sh — recent autonomous commits with finding linkage.
# Usage: ./git-log.sh [days]
# Outputs JSON array of commit objects.

set -euo pipefail

REPO="${OHWOW_REPO:-$HOME/Documents/ohwow/ohwow}"
DAYS="${1:-3}"

PY_SCRIPT='
import sys, re, json
raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
records = [r.strip() for r in raw.split("\x00") if r.strip()]
out = []
for rec in records:
    parts = rec.split("\t", 3)
    if len(parts) < 3: continue
    sha = parts[0].strip()
    ts = parts[1].strip()
    subject = parts[2].strip()
    body = parts[3] if len(parts) > 3 else ""
    if not sha: continue
    finding_id = experiment_id = reverts_sha = ""
    for line in body.splitlines():
        m = re.match(r"^Fixes-Finding-Id:\s+(\S+)", line)
        if m: finding_id = m.group(1)
        m = re.match(r"^Self-authored by experiment:\s+(\S+)", line)
        if m: experiment_id = m.group(1)
        m = re.match(r"^Auto-Reverts:\s+(\S+)", line)
        if m: reverts_sha = m.group(1)
    out.append({
        "sha": sha[:40], "time": ts, "subject": subject,
        "finding_id": finding_id, "experiment_id": experiment_id,
        "reverts": reverts_sha,
    })
print(json.dumps(out, indent=2))
'

git -C "$REPO" log \
  --since="${DAYS} days ago" \
  --pretty=format:"%H%x09%aI%x09%s%x09%b%x00" \
  --grep="Fixes-Finding-Id\|Auto-Reverts" 2>/dev/null \
| python3 -c "$PY_SCRIPT"
