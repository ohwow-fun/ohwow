#!/usr/bin/env bash
# load.sh — deterministic JSON snapshot of system load + uptime.
# Read-only. macOS only (relies on sysctl keys).
# Consumers: ohwow device-audit orchestrator.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '{"error":"unsupported_os","os":"%s"}\n' "$(uname -s)"
  exit 2
fi

GENERATED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
NCPU=$(sysctl -n hw.ncpu)
NCPU_PHYSICAL=$(sysctl -n hw.physicalcpu)
CPU_BRAND=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "")
BOOT_EPOCH=$(sysctl -n kern.boottime | sed -n 's/.*sec = \([0-9]*\).*/\1/p')
NOW_EPOCH=$(date +%s)
UPTIME_SECONDS=$(( NOW_EPOCH - BOOT_EPOCH ))
HOSTNAME_VAL=$(scutil --get ComputerName 2>/dev/null || hostname)

# Load averages — sysctl returns "{ 1.23 4.56 7.89 }" or similar.
LOADAVG_RAW=$(sysctl -n vm.loadavg)
read -r L1 L5 L15 < <(echo "$LOADAVG_RAW" | tr -d '{}' | awk '{print $1, $2, $3}')

export GENERATED_AT NCPU NCPU_PHYSICAL CPU_BRAND UPTIME_SECONDS HOSTNAME_VAL L1 L5 L15

python3 <<'PY'
import json, os, sys
ncpu = int(os.environ["NCPU"])
l1 = float(os.environ["L1"])
l5 = float(os.environ["L5"])
l15 = float(os.environ["L15"])
out = {
  "generated_at": os.environ["GENERATED_AT"],
  "hostname": os.environ["HOSTNAME_VAL"],
  "cpu": {
    "logical_cores": ncpu,
    "physical_cores": int(os.environ["NCPU_PHYSICAL"]),
    "brand": os.environ["CPU_BRAND"],
  },
  "uptime_seconds": int(os.environ["UPTIME_SECONDS"]),
  "load_average": {"1m": l1, "5m": l5, "15m": l15},
  "load_per_core": {
    "1m": round(l1 / ncpu, 2),
    "5m": round(l5 / ncpu, 2),
    "15m": round(l15 / ncpu, 2),
  },
}
json.dump(out, sys.stdout, indent=2)
print()
PY
