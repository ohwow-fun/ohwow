#!/usr/bin/env bash
# processes.sh — deterministic JSON snapshot of top processes by RAM and CPU.
# Read-only. Cross-platform-ish (uses ps with POSIX flags). On macOS also
# captures etime so long-running pegged processes (e.g. a stuck fileproviderd)
# surface clearly.
# Consumers: ohwow device-audit orchestrator.
#
# Usage: processes.sh [limit]   (default limit = 15)

set -euo pipefail

export LIMIT="${1:-15}"
export GENERATED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# BSD ps: -m sorts by memory (RSS), -r sorts by %CPU. etime is [[dd-]hh:]mm:ss.
export TOP_MEM=$(ps -Ao pid,rss,%cpu,etime,comm -m | head -n $((LIMIT + 1)) | tail -n +2)
export TOP_CPU=$(ps -Ao pid,rss,%cpu,etime,comm -r | head -n $((LIMIT + 1)) | tail -n +2)

python3 <<'PY'
import json, os, sys, re

def parse_etime(s):
    m = re.match(r'(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$', s.strip())
    if not m:
        return 0
    d, h, mn, sec = m.groups()
    return (int(d or 0) * 86400) + (int(h or 0) * 3600) + (int(mn) * 60) + int(sec)

def parse_rows(raw):
    rows = []
    for line in raw.strip().splitlines():
        if not line.strip():
            continue
        # pid rss %cpu etime comm(rest)
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        pid, rss_kb, cpu_pct, etime, comm = parts
        try:
            rows.append({
                "pid": int(pid),
                "rss_bytes": int(rss_kb) * 1024,
                "cpu_pct": float(cpu_pct),
                "elapsed_seconds": parse_etime(etime),
                "command": comm,
            })
        except ValueError:
            continue
    return rows

top_mem = parse_rows(os.environ["TOP_MEM"])
top_cpu = parse_rows(os.environ["TOP_CPU"])

out = {
    "generated_at": os.environ["GENERATED_AT"],
    "limit": int(os.environ["LIMIT"]),
    "top_by_memory": top_mem,
    "top_by_cpu": top_cpu,
}
json.dump(out, sys.stdout, indent=2)
print()
PY
