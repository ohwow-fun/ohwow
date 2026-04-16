#!/usr/bin/env bash
# Scan either a staged diff (pre-commit mode) or an arbitrary text file
# (commit-msg mode) for real-looking personal identifiers. Block the git
# operation on any hit.
#
# Usage:
#   scripts/check-personal-data.sh            # pre-commit: scan staged diff
#   scripts/check-personal-data.sh <file>     # commit-msg: scan commit message file
#
# Open-source repo → tests / docblocks / commit messages must use
# RFC 2606 placeholders (alice@example.com, carol@acme.test,
# handle 'example_com', etc.), not real work or personal addresses.
# Override for a legitimate case: set OHWOW_ALLOW_PERSONAL_DATA=1 before
# `git commit` — the env bypass is a deliberate per-commit override, not
# a silent skip.

set -euo pipefail

if [[ "${OHWOW_ALLOW_PERSONAL_DATA:-}" == "1" ]]; then
  exit 0
fi

# Patterns of real-email providers and ohwow-adjacent domains that should
# never appear in this repo outside of the accepted Signed-off-by /
# Co-Authored-By trailers. example.com / example.org / example.net /
# example.test / acme.test are RFC-reserved fictional domains — allowed.
PATTERN='@(gmail|googlemail|yahoo|outlook|hotmail|icloud|live|proton(mail)?|ohwow\.fun|dcommunity\.io|aved\.ai)\.?(com|org|net|io|ai|fun|me)?\b'

# Mode A: commit-msg. The hook passes the commit message file as $1.
# Scan the whole file, skip only the trailer lines (signoff + coauthor).
# This catches personal data in subject + body, which the pre-commit
# diff scan cannot see.
if [[ $# -ge 1 && -f "$1" ]]; then
  MSG_FILE="$1"
  HITS=$(grep -vE '^(Signed-off-by|Co-Authored-By):' "$MSG_FILE" | grep -iE "$PATTERN" || true)
  if [[ -n "$HITS" ]]; then
    echo "[commit-msg] Blocking: commit message contains real-looking personal identifiers."
    echo "             Use RFC 2606 placeholders (alice@example.com, acme.test, handle 'example_com')."
    echo "             Override for a legitimate case: OHWOW_ALLOW_PERSONAL_DATA=1"
    echo ""
    echo "$HITS" | head -20
    exit 1
  fi
  exit 0
fi

# Mode B: pre-commit. Scan added lines in the staged diff. The
# grep pipeline can legitimately exit 1 (no added lines, e.g. a
# pure deletion commit); `|| true` lets set -euo pipefail fall
# through to the empty-string guard instead of hard-failing.
ADDED=$(git diff --cached -U0 | { grep '^+' || true; } | { grep -v '^+++' || true; })
if [[ -z "$ADDED" ]]; then
  exit 0
fi

HITS=$(echo "$ADDED" | grep -viE '^\+.*(Signed-off-by|Co-Authored-By):' | grep -iE "$PATTERN" || true)

if [[ -n "$HITS" ]]; then
  echo "[pre-commit] Blocking: staged diff contains real-looking personal emails."
  echo "             Use RFC 2606 placeholders: alice@example.com, carol@acme.test, handle 'example_com'."
  echo "             Override for a legitimate case: OHWOW_ALLOW_PERSONAL_DATA=1"
  echo ""
  echo "$HITS" | head -20
  exit 1
fi

exit 0
