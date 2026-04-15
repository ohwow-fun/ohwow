#!/usr/bin/env bash
# patch-history.sh — recent autonomous patches with held/reverted status.
# Outputs a human-readable summary + JSON lines at the end.

set -euo pipefail

REPO="${OHWOW_REPO:-$HOME/Documents/ohwow/ohwow}"
DAYS="${1:-3}"

echo "=== Autonomous patch history (last ${DAYS}d) ==="
echo ""

git -C "$REPO" log \
  --since="${DAYS} days ago" \
  --pretty=format:"%aI  %h  %s" \
  --grep="Fixes-Finding-Id\|Auto-Reverts\|auto-revert\|rolled back" 2>/dev/null \
  | sort || true

echo ""
echo "=== Summary ==="
LANDED=$(git -C "$REPO" log --since="${DAYS} days ago" --grep="Fixes-Finding-Id" --oneline 2>/dev/null | wc -l | tr -d ' ')
REVERTED=$(git -C "$REPO" log --since="${DAYS} days ago" --grep="Auto-Reverts\|rolled back" --oneline 2>/dev/null | wc -l | tr -d ' ')
HELD=$((LANDED - REVERTED))

echo "Landed:   $LANDED"
echo "Reverted: $REVERTED"
echo "Held:     $HELD"
if [[ "$LANDED" -gt 0 ]]; then
  RATE=$(echo "scale=0; $HELD * 100 / $LANDED" | bc 2>/dev/null || echo "?")
  echo "Hold rate: ${RATE}%"
fi
