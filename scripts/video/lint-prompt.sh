#!/usr/bin/env bash
# Static prompt linter for text-to-video generation.
# Deterministic grep-based checks; catches common failure modes before spending API budget.
#
# Usage:
#   ./lint-prompt.sh "a slow dolly-in over a quiet home office at dawn, dust motes drifting..."
#   PROMPT="..." ./lint-prompt.sh
#
# Exit codes: 0=ready, 1=warnings, 2=usage error.
set -euo pipefail

PROMPT="${1:-${PROMPT:-}}"
if [ -z "$PROMPT" ]; then
  echo "Usage: $0 '<prompt>'  (or set PROMPT=... env var)" >&2
  exit 2
fi

CAMERA='dolly|push(-| )?in|pull(-| )?back|pan(s|ning)?|track(s|ing)?|orbit(s|ing)?|drone|crane|tilt(s|ing)?|glide|zoom|static frame|handheld|follow(s|ing)?|circl(es|ing)'
SUBJECT='drift(s|ing)?|ris(es|ing)|fall(s|ing)?|rustl(es|ing)|flow(s|ing)?|billow(s|ing)?|shatter(s|ing)?|pour(s|ing)?|run(s|ning)?|walk(s|ing)?|gallop(s|ing)?|spin(s|ning)?|rippl(es|ing)|stream(s|ing)?|smoke|steam|mist|spray|dust motes|leaves'
STYLE='photorealistic|documentary|shot on|35mm|iPhone|Sony|cinematic|film grain'
OVERLOAD='anamorphic|lens flare|film grain|color grade|chiaroscuro|volumetric|vignette|bokeh|180[- ]degree shutter'

score=0
warn=()

check() {
  local pattern="$1" label="$2" example="$3"
  if echo "$PROMPT" | grep -iqE "$pattern"; then
    echo "  ok  $label"
    score=$((score + 1))
  else
    warn+=("MISSING: $label (try: $example)")
  fi
}

echo "== prompt lint =="
echo ""
check "$CAMERA"  "camera-motion cue"  "slow dolly-in, tracking shot, aerial drone"
check "$SUBJECT" "subject-motion cue" "steam rising, mist drifting, hands pouring"
check "$STYLE"   "style/realism anchor" "shot on iPhone, 35mm film, documentary"

words=$(echo "$PROMPT" | wc -w | tr -d ' ')
if [ "$words" -lt 40 ]; then
  warn+=("SHORT: $words words (target 60-200; LTX/Seedance reward detail)")
elif [ "$words" -gt 220 ]; then
  warn+=("LONG: $words words (target 60-200; model ignores tail tokens)")
else
  echo "  ok  word count $words"
fi

overload=$( { echo "$PROMPT" | grep -oiE "$OVERLOAD" || true; } | wc -l | tr -d ' ')
if [ "$overload" -gt 3 ]; then
  warn+=("STYLE OVERLOAD: $overload stacked modifiers (drop to <=3 or smaller models produce abstract mush)")
else
  echo "  ok  style modifier count $overload (<=3)"
fi

# Tense check: heuristic. Past-tense verbs often signal the prompt is a summary, not a shot directive.
if echo "$PROMPT" | grep -qE '\b(walked|ran|moved|turned|flew|sat|stood)\b'; then
  warn+=("TENSE: past-tense verbs detected. LTX/Seedance reward present tense ('walks' not 'walked')")
fi

echo ""
if [ "${#warn[@]}" -eq 0 ]; then
  echo "PROMPT READY (score $score/3)."
  exit 0
else
  echo "warnings (score $score/3):"
  for w in "${warn[@]}"; do echo "  - $w"; done
  exit 1
fi
