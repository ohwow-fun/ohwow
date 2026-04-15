#!/usr/bin/env bash
# Scan staged diff for real-looking personal emails and flag them.
# Open-source repo → tests/docblocks must use placeholders (alice@example.com,
# carol@acme.test, handle 'example_com', etc.) not real work/personal addresses.
# Runs in pre-commit. Blocks the commit on any hit. To override for a legitimate
# case, set OHWOW_ALLOW_PERSONAL_DATA=1 before `git commit` — the env bypass
# is a recorded override, not a silent skip.

set -euo pipefail

if [[ "${OHWOW_ALLOW_PERSONAL_DATA:-}" == "1" ]]; then
  exit 0
fi

# Added lines only (+, skipping the +++ file marker).
ADDED=$(git diff --cached -U0 | grep '^+' | grep -v '^+++')
if [[ -z "$ADDED" ]]; then
  exit 0
fi

# Patterns of real-email providers that should never appear in this repo's
# test fixtures or docblock examples. example.com / example.org / example.net
# / example.test / acme.test are the RFC-reserved fictional domains — those
# are allowed. The signoff/co-author trailers are excluded because the repo
# has accepted `Signed-off-by` retaining a real committer identity.
PATTERN='@(gmail|googlemail|yahoo|outlook|hotmail|icloud|live|proton(mail)?|ohwow\.fun|dcommunity\.io|aved\.ai)\.?(com|org|net|io|ai|fun|me)?\b'

HITS=$(echo "$ADDED" | grep -viE '^\+.*(Signed-off-by|Co-Authored-By):' | grep -iE "$PATTERN" || true)

if [[ -n "$HITS" ]]; then
  echo "[pre-commit] Blocking: staged diff contains real-looking personal emails."
  echo "             Use RFC 2606 placeholders: alice@example.com, carol@acme.test, handle 'example_com'."
  echo "             To override for a legitimate case, set OHWOW_ALLOW_PERSONAL_DATA=1."
  echo ""
  echo "$HITS" | head -20
  exit 1
fi

exit 0
