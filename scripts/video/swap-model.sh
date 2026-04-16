#!/usr/bin/env bash
# Swap the active fal.ai video model in ~/.ohwow/config.json.
# Deterministic JSON edit via node; never touches the repo.
#
# Usage:
#   ./swap-model.sh                                                  # prints catalog + current
#   ./swap-model.sh fal-ai/bytedance/seedance/v1/pro/text-to-video   # sets model
set -euo pipefail

CFG="$HOME/.ohwow/config.json"
SLUG="${1:-}"

if [ -z "$SLUG" ]; then
  CURRENT=$(node -e "const c=JSON.parse(require('fs').readFileSync('$CFG','utf8'));process.stdout.write(c.falVideoModel||'(unset)')")
  cat <<EOF
Current falVideoModel: $CURRENT

Known fal slugs (April 2026 catalog):

  fal-ai/bytedance/seedance/v1/pro/text-to-video        Seedance 1.0 Pro. SOTA summer-2025. ~\$0.50 / 5s / 720p.  (default choice)
  fal-ai/bytedance/seedance/v1/pro/fast/text-to-video   Seedance 1.0 Pro Fast. Cheaper, nearly identical quality.
  bytedance/seedance-2.0/text-to-video                  Seedance 2.0 Standard. SOTA Apr-2026. ~\$1.52 / 5s / 720p.
  bytedance/seedance-2.0/fast/text-to-video             Seedance 2.0 Fast. ~\$1.21 / 5s / 720p.
  fal-ai/kling-video/v2.1/master/text-to-video          Kling 2.1 Master. Alternative SOTA, strong on human motion.
  fal-ai/luma-dream-machine                             Luma Dream Machine. Older. Uses "5s" duration format.

Usage:
  $0 <slug>

EOF
  exit 2
fi

node -e "
const fs = require('node:fs');
const p = '$CFG';
const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
const prev = cfg.falVideoModel || '(unset)';
cfg.falVideoModel = '$SLUG';
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
console.log('falVideoModel:', prev, '->', cfg.falVideoModel);
"
