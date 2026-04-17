# device-audit

Read-only, deterministic scripts that snapshot local-device performance state
as JSON. Designed to be called by ohwow operator tooling, self-bench
experiments, and the orchestrator for device-health findings.

All scripts are macOS-only (they rely on `vm_stat`, `sysctl`, `df -k`, and
`ps` with BSD flags). Non-Darwin hosts get `{"error":"unsupported_os",...}`
with exit code 2.

## Scripts

| Script | Output |
|---|---|
| `memory.sh` | RAM + swap + compressor state, plus cumulative page/swap counters |
| `disk.sh` | All mounted volumes with size/used/available/capacity |
| `processes.sh [limit]` | Top N processes by RSS and by %CPU (default 15) |
| `load.sh` | Hostname, CPU topology, uptime, load averages (1/5/15) |
| `audit.sh` | Orchestrator — runs all of the above + a `warnings` array |

## Warning codes emitted by `audit.sh`

| Code | Threshold |
|---|---|
| `swap_near_limit` | `swap.used_pct > 85` |
| `low_free_ram` | `ram.available_bytes < 1 GiB` |
| `high_load_15m` | `load.load_per_core.15m > 1.5` |
| `pegged_long_running` | process `%cpu > 80` AND `elapsed > 1d` |
| `disk_near_full` | any volume `capacity_pct > 90` |

## Example

```bash
./audit.sh | jq '.warnings'
./memory.sh | jq '.swap'
./processes.sh 5 | jq '.top_by_cpu'
```

## Design notes

- Bytes everywhere (not MB/GB) so consumers don't fight unit drift.
- Percentages are already-computed floats with one decimal.
- `generated_at` is ISO-8601 UTC. All scripts emit it so findings can be
  correlated across a run.
- `audit.sh` always exits 0 on successful emission — `warnings` being
  non-empty is a *result*, not a *failure*. Downstream code should parse
  `.warnings` rather than rely on exit status.
- Process-level env knob: `DEVICE_AUDIT_PROC_LIMIT=N ./audit.sh` to change
  the top-N cutoff.
