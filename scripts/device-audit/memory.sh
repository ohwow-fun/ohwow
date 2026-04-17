#!/usr/bin/env bash
# memory.sh — deterministic JSON snapshot of physical memory + swap state.
# Read-only. macOS only (uses vm_stat, sysctl).
# Consumers: ohwow device-audit orchestrator, operator diagnostics.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '{"error":"unsupported_os","os":"%s"}\n' "$(uname -s)"
  exit 2
fi

export VM_STAT="$(vm_stat)"
export SWAP_RAW="$(sysctl -n vm.swapusage)"
export MEM_TOTAL="$(sysctl -n hw.memsize)"
export GENERATED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

python3 <<'PY'
import json, os, re, sys

vm = os.environ["VM_STAT"]
swap = os.environ["SWAP_RAW"]
mem_total = int(os.environ["MEM_TOTAL"])

# vm_stat header: "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
m = re.search(r"page size of (\d+) bytes", vm)
page_size = int(m.group(1)) if m else 4096

pages = {}
for line in vm.splitlines():
    m = re.match(r'^"?([^":]+)"?:\s*([0-9]+)\.?\s*$', line)
    if m:
        pages[m.group(1).strip()] = int(m.group(2))

def b(key):
    return pages.get(key, 0) * page_size

free = b("Pages free")
active = b("Pages active")
inactive = b("Pages inactive")
speculative = b("Pages speculative")
wired = b("Pages wired down")
compressor = b("Pages occupied by compressor")
compressed = b("Pages stored in compressor")
file_backed = b("File-backed pages")
anon = b("Anonymous pages")

used = active + wired + compressor
available = free + inactive + speculative

def swap_mb(label):
    m = re.search(rf"{label}\s*=\s*([0-9.]+)M", swap)
    return float(m.group(1)) if m else 0.0

swap_total_mb = swap_mb("total")
swap_used_mb = swap_mb("used")
swap_free_mb = swap_mb("free")

out = {
    "generated_at": os.environ["GENERATED_AT"],
    "ram": {
        "total_bytes": mem_total,
        "used_bytes": used,
        "available_bytes": available,
        "free_bytes": free,
        "wired_bytes": wired,
        "active_bytes": active,
        "inactive_bytes": inactive,
        "speculative_bytes": speculative,
        "compressor_bytes": compressor,
        "compressed_pages_bytes": compressed,
        "file_backed_bytes": file_backed,
        "anonymous_bytes": anon,
        "used_pct": round(used / mem_total * 100, 1),
        "free_pct": round(available / mem_total * 100, 1),
    },
    "swap": {
        "total_bytes": round(swap_total_mb * 1024 * 1024),
        "used_bytes": round(swap_used_mb * 1024 * 1024),
        "free_bytes": round(swap_free_mb * 1024 * 1024),
        "encrypted": "encrypted" in swap,
        "used_pct": round(swap_used_mb / swap_total_mb * 100, 1) if swap_total_mb > 0 else 0.0,
    },
    "counters": {
        "pageins": pages.get("Pageins", 0),
        "pageouts": pages.get("Pageouts", 0),
        "swapins": pages.get("Swapins", 0),
        "swapouts": pages.get("Swapouts", 0),
        "compressions": pages.get("Compressions", 0),
        "decompressions": pages.get("Decompressions", 0),
    },
}
json.dump(out, sys.stdout, indent=2)
print()
PY
