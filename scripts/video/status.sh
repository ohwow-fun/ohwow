#!/usr/bin/env bash
# Show current video-gen configuration.
# Deterministic read-only: config.json fields, env overrides, adapter reachability.
set -euo pipefail

CFG="$HOME/.ohwow/config.json"

say() { printf '%s\n' "$*"; }

say "== ohwow video-gen status =="
say ""

if [ ! -f "$CFG" ]; then
  say "config.json: MISSING ($CFG)"
  exit 1
fi

# Config.json state (keys are masked; never echo the raw secret).
HAS_FAL=$(node -e "const c=JSON.parse(require('fs').readFileSync('$CFG','utf8'));process.stdout.write(c.falKey ? ('set (len='+c.falKey.length+')') : 'unset')")
FAL_MODEL=$(node -e "const c=JSON.parse(require('fs').readFileSync('$CFG','utf8'));process.stdout.write(c.falVideoModel || '(default fal-ai/luma-dream-machine)')")
HAS_OR=$(node -e "const c=JSON.parse(require('fs').readFileSync('$CFG','utf8'));process.stdout.write(c.openRouterApiKey ? 'set' : 'unset')")

say "config.json ($CFG):"
say "  falKey:          $HAS_FAL"
say "  falVideoModel:   $FAL_MODEL"
say "  openRouterApiKey: $HAS_OR"
say ""

# Env-var overrides (take precedence in the adapter).
say "env overrides:"
say "  FAL_KEY:              $([ -n "${FAL_KEY:-}" ] && echo "set (len=${#FAL_KEY})" || echo 'unset')"
say "  FAL_VIDEO_MODEL:      ${FAL_VIDEO_MODEL:-unset}"
say "  OHWOW_VIDEO_HTTP_URL: ${OHWOW_VIDEO_HTTP_URL:-unset}"
say ""

# Modal LTX endpoint reachability (if configured).
if [ -n "${OHWOW_VIDEO_HTTP_URL:-}" ]; then
  BASE="${OHWOW_VIDEO_HTTP_URL%/v1/videos}"
  HEALTH_URL="${BASE}/health"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" || echo '000')
  say "LTX-Video (Modal): $HEALTH_URL → HTTP $code"
else
  say "LTX-Video (Modal): not configured"
fi
say ""

# Which provider the router would pick right now, based on keys.
if [ -n "${FAL_KEY:-}" ] || [ "$HAS_FAL" != "unset" ]; then
  say "router would use: fal ($FAL_MODEL)"
elif [ -n "${OHWOW_VIDEO_HTTP_URL:-}" ]; then
  say "router would use: generic-http (Modal LTX)"
else
  say "router would use: NONE (no providers available)"
fi
