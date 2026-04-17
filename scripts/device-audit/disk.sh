#!/usr/bin/env bash
# disk.sh — deterministic JSON snapshot of mounted volumes.
# Read-only. macOS only (parses df -k). Reports all local volumes;
# skips devfs, map auto_home, and read-only system snapshots.
# Consumers: ohwow device-audit orchestrator.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '{"error":"unsupported_os","os":"%s"}\n' "$(uname -s)"
  exit 2
fi

export GENERATED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
export DF_OUTPUT=$(df -k)

python3 <<'PY'
import json, os, sys
lines = os.environ["DF_OUTPUT"].strip().splitlines()[1:]
volumes = []
for line in lines:
    # Columns: Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted
    parts = line.split()
    if len(parts) < 9:
        continue
    fs = parts[0]
    # "Mounted on" may contain spaces — it's the last field, everything after position 8 joined.
    mount = " ".join(parts[8:])
    if fs in ("devfs", "map") or mount.startswith("/System/Volumes/Update/mnt") \
       or mount == "/System/Volumes/Data/home":
        continue
    try:
        total = int(parts[1]) * 1024
        used = int(parts[2]) * 1024
        avail = int(parts[3]) * 1024
        cap = int(parts[4].rstrip("%"))
    except ValueError:
        continue
    volumes.append({
        "filesystem": fs,
        "mount": mount,
        "total_bytes": total,
        "used_bytes": used,
        "available_bytes": avail,
        "capacity_pct": cap,
    })

# Identify the primary data volume — where user files live.
primary = next((v for v in volumes if v["mount"] == "/System/Volumes/Data"), None) \
       or next((v for v in volumes if v["mount"] == "/"), None)

out = {
    "generated_at": os.environ["GENERATED_AT"],
    "primary_data_volume": primary,
    "volumes": volumes,
}
json.dump(out, sys.stdout, indent=2)
print()
PY
