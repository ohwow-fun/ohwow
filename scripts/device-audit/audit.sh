#!/usr/bin/env bash
# audit.sh — orchestrates the device-audit sub-scripts and emits a single
# JSON document with a deterministic `warnings` array of actionable findings.
# Read-only. macOS only.
# Consumers: ohwow operator tooling, self-bench device-health experiment.
#
# Warning rules (thresholds intentionally conservative):
#   - swap_near_limit        : swap.used_pct > 85
#   - low_free_ram           : ram.available_bytes < 1 GiB
#   - high_load_15m          : load.load_per_core.15m > 1.5
#   - pegged_long_running    : process %cpu > 80 AND elapsed > 1 day
#   - disk_near_full         : any volume capacity_pct > 90
#
# Exit code is always 0 on successful emission (so downstream parsers don't
# conflate "warnings present" with "script failed"). Use jq to inspect warnings.

set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '{"error":"unsupported_os","os":"%s"}\n' "$(uname -s)"
  exit 2
fi

export MEM=$("$HERE/memory.sh")
export DISK=$("$HERE/disk.sh")
export PROCS=$("$HERE/processes.sh" "${DEVICE_AUDIT_PROC_LIMIT:-15}")
export LOAD=$("$HERE/load.sh")
GENERATED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

export GENERATED_AT

python3 <<'PY'
import json, sys, os
mem = json.loads(os.environ["MEM"])
disk = json.loads(os.environ["DISK"])
procs = json.loads(os.environ["PROCS"])
load = json.loads(os.environ["LOAD"])

warnings = []

swap_pct = mem["swap"]["used_pct"]
if swap_pct > 85:
    warnings.append({
        "code": "swap_near_limit",
        "severity": "critical" if swap_pct > 95 else "warn",
        "message": f"Swap is {swap_pct}% full ({mem['swap']['used_bytes'] / 2**30:.1f} GB of {mem['swap']['total_bytes'] / 2**30:.1f} GB).",
        "remediation": "Quit memory-heavy apps or reboot to flush swap.",
    })

avail_bytes = mem["ram"]["available_bytes"]
if avail_bytes < 1 * 2**30:
    warnings.append({
        "code": "low_free_ram",
        "severity": "warn",
        "message": f"Only {avail_bytes / 2**30:.2f} GB RAM available.",
        "remediation": "Close unused apps; check top_by_memory for heavy processes.",
    })

load15_per_core = load["load_per_core"]["15m"]
if load15_per_core > 1.5:
    warnings.append({
        "code": "high_load_15m",
        "severity": "critical" if load15_per_core > 3 else "warn",
        "message": f"15-min load avg is {load15_per_core}× per-core (load {load['load_average']['15m']} on {load['cpu']['logical_cores']} cores).",
        "remediation": "Check top_by_cpu for runaway processes.",
    })

for p in procs["top_by_cpu"]:
    if p["cpu_pct"] > 80 and p["elapsed_seconds"] > 86400:
        warnings.append({
            "code": "pegged_long_running",
            "severity": "critical",
            "message": f"{p['command'].split('/')[-1]} (pid {p['pid']}) at {p['cpu_pct']}% CPU for {p['elapsed_seconds'] // 86400}d.",
            "remediation": f"Inspect pid {p['pid']}; consider killing if safe.",
            "pid": p["pid"],
        })

for v in disk["volumes"]:
    if v["capacity_pct"] > 90:
        warnings.append({
            "code": "disk_near_full",
            "severity": "critical" if v["capacity_pct"] > 95 else "warn",
            "message": f"{v['mount']} is {v['capacity_pct']}% full ({v['available_bytes'] / 2**30:.1f} GB free).",
            "remediation": "Review large caches under ~/Library/Caches and ~/Downloads.",
        })

out = {
    "generated_at": os.environ["GENERATED_AT"],
    "warnings": warnings,
    "memory": mem,
    "disk": disk,
    "processes": procs,
    "load": load,
}
json.dump(out, sys.stdout, indent=2)
print()
PY
