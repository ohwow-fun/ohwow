# Multi-Workspace Plan

**Status** (updated 2026-04-13):
- ✅ Switchable single-workspace support (atomic rename migration, directory-based layout) — shipped in `daf534e` and `b967112`.
- 🚧 Phase 1: local-only workspaces — in progress.
- 🚧 Phase 2: cloud-integrated workspaces with per-workspace license keys — in progress.
- ⏸ Phase 3: automated cloud provisioning (requires new cloud endpoint) — deferred.
- ⏸ Future: multi-workspace-per-license cloud feature (requires cloud-side API change) — forward-compat hook shipped in Phase 2.

This doc captures the design decisions behind multi-workspace support for the ohwow daemon. It's the source of truth after the audit that found creating a second local workspace today would silently mirror the first via cloud sync.

---

## 1. Motivation

The daemon was originally one-workspace-per-install: one license key, one cloud workspace, one local SQLite file under `~/.ohwow/data/`. When we tried to add a second local workspace for AvenueD ops alongside the ohwow.fun GTM workspace, we hit an architectural wall:

- Cloud identity is 1:1 with the license key. `ControlPlaneClient.connect()` sends only the license key and the cloud returns exactly one `workspaceId` per license (`src/control-plane/client.ts:195-234`).
- On boot, `syncAgentConfigs` + `syncMemoriesFromCloud` + `syncStateFromCloud` hydrate the local DB from that cloud workspace. Workspace consolidation at `src/daemon/start.ts:668-789` rewrites all local rows to the returned cloud `workspaceId`.
- Net effect: two local workspaces backed by the same license become perfect mirrors of the same cloud workspace within ~15 seconds of first connect. Silent data collision.

We need true isolation for two legitimate use cases:

1. **Local-only sandboxes**: operational workspaces (like AvenueD ops) that shouldn't sync to the ohwow.fun cloud brain at all.
2. **Separate cloud workspaces**: multi-tenant scenarios where you want two independent cloud brains on one machine.

## 2. Core design

**Each cloud workspace has its own license key. Each local workspace optionally carries its own license key in a per-workspace config file.**

The cloud API stays unchanged. The local runtime adds a per-workspace config layer that overrides the global one. The global `~/.ohwow/config.json` keeps acting as the default workspace's config — so the existing `default` workspace keeps working exactly as today, untouched.

This is the only shape that gives true isolation without a cloud-side API rewrite. Multi-workspace-per-license (one license → many cloud workspaces) is a cloud-side change kept out of scope for now, but Phase 2 ships a forward-compat hook (`requestedWorkspaceId` field) so it can be added later without breaking anything.

## 3. Per-workspace config file

New file: `~/.ohwow/workspaces/<name>/workspace.json`

```jsonc
{
  "schemaVersion": 1,

  // Required. Determines whether control plane connects at all.
  "mode": "local-only" | "cloud",

  // Required when mode="cloud". The license key for this workspace's cloud brain.
  "licenseKey": "ent-...",

  // Optional. Populated automatically after first successful connect.
  // Used for mirror detection and `workspace info` display.
  "cloudWorkspaceId": "d6080b9b-...",
  "cloudDeviceId": "1bf5a170-...",
  "lastConnectAt": "2026-04-13T09:30:00Z",

  // Optional. Human label for `workspace list` / `workspace info`.
  "displayName": "AvenueD Ops",

  // Future: forward-compatible slot for multi-workspace-per-license.
  // Forwarded as ConnectRequest.requestedWorkspaceId when the cloud supports it.
  "requestedCloudWorkspaceId": null
}
```

**The existing `default` workspace has no `workspace.json`**. Its absence signals "legacy default — inherit everything from global `config.json`." Only new or explicitly-configured workspaces get a `workspace.json`.

## 4. Config loading precedence

```
env vars  >  workspace.json  >  ~/.ohwow/config.json  >  built-in defaults
```

Fields overridable per-workspace:
- `licenseKey` — different cloud workspace
- `tier` — force `free` for local-only
- Model settings — `anthropicApiKey`, `openRouterApiKey`, `orchestratorModel`, `ollamaModel`, etc. (nice side benefit; not required for Phase 1/2)

Fields that stay GLOBAL (never per-workspace):
- `port` — one daemon at a time, always same port
- `dbPath` — computed from workspace dir by the resolver
- `cloudUrl` — same cloud backend for all workspaces
- `deviceRole`, `workspaceGroup` — machine-level settings

**Mode-based override rules** (implemented in `applyWorkspaceOverrides`):

- `mode="local-only"`: blanks `licenseKey`, forces `tier="free"` regardless of whether a license is in global config. This ensures control plane never connects for this workspace.
- `mode="cloud"`: uses `workspace.json.licenseKey` (not the global one), forces `tier="connected"`. Cloud resolves actual plan tier on connect.
- No `workspace.json`: passes through unchanged. Default workspace gets its config from global `config.json` just like today.

## 5. CLI surface

### Phase 1 (local-only)

```bash
ohwow workspace create <name> --local-only
ohwow workspace use <name>            # boots disconnected (tier=free)
ohwow workspace list                  # shows "  avenued  (local-only)"
ohwow workspace info <name>           # mode, tier, paths, status
```

### Phase 2 (cloud-integrated)

```bash
# Create a cloud workspace. Requires a license key minted out-of-band
# (ohwow.fun web dashboard).
ohwow workspace create <name> --license-key=ent-abc...

# Promote a local-only workspace to cloud
ohwow workspace link <name> --license-key=ent-abc...

# Demote cloud → local-only (stops syncing, keeps local data)
ohwow workspace unlink <name>

# Rich status
ohwow workspace info <name>
# → mode: cloud
#   license: ent-abc***
#   cloud workspace: d6080b9b-... (AvenueD Ops)
#   device: 1bf5a170-...
#   last connect: 2m ago
#   tier: enterprise
```

### Phase 3 (deferred, nice-to-have)

```bash
ohwow workspace create <name> --cloud --name="AvenueD Ops"
# → Calls POST /api/local-runtime/provision-workspace with the global license
#   as parent token, gets back { workspaceId, licenseKey } for a new child.
#   Requires a new cloud endpoint.

ohwow workspace export <name> > ws.tar
ohwow workspace import <name> < ws.tar
```

## 6. Mirror detection (safety layer)

Three layers of defense against silently mirroring two locals to one cloud workspace:

1. **Pre-create check** (no cloud round-trip): `workspace create --license-key=X` refuses if license X is already used by another `workspace.json` or the global `config.json`. Error: `"License ent-abc*** is already used by workspace 'default'. Use a different license or run 'ohwow workspace unlink default' first."`

2. **Post-connect check**: after first successful `ControlPlaneClient.connect()`, we persist `cloudWorkspaceId` into `workspace.json`. On every subsequent boot, if the cloud returns a `cloudWorkspaceId` different from what's persisted, the daemon refuses to start. Detects license reassignment.

3. **Cross-workspace conflict check** (daemon boot): scan other `workspace.json` files; if any other workspace has the same persisted `cloudWorkspaceId`, refuse to boot. Belt-and-suspenders against misconfiguration.

## 7. Cloud provisioning

**Phase 2 today**: user mints the license manually via the ohwow.fun web dashboard and pastes it into `workspace create --license-key=...`. Zero cloud-side changes.

**Phase 3 future**: new endpoint `POST /api/local-runtime/provision-workspace` taking a parent license, returning `{ workspaceId, licenseKey }` for a newly-created child workspace. Enables `workspace create --cloud` to automate minting. One new route + one `parent_license_key_id` column on the cloud side. Not required for Phase 2.

## 8. Forward compatibility: multi-workspace-per-license

If one-license-to-many-workspaces becomes desirable later, the protocol hook is already in the plan: `workspace.json.requestedCloudWorkspaceId`. When set, the client forwards it as a new optional field on `ConnectRequest`:

```ts
export interface ConnectRequest {
  licenseKey: string;
  requestedWorkspaceId?: string;   // NEW, optional
  // ...existing fields...
}
```

Cloud side: if field is set and the license has permission for that workspace, return it; otherwise return the primary (current behavior). Fully backward compatible.

## 9. Inventory of cloud-linked subsystems

| Subsystem | Storage | Shared Across Workspaces? | Gap with multi-workspace |
|-----------|---------|---------------------------|--------------------------|
| License Key | global `config.json` | shared unless overridden via `workspace.json` | Fixed in Phase 2 |
| Device ID | returned by cloud on connect, in-memory | per-workspace (cloud may dedupe by `machineId`) | Verify cloud dedup behavior |
| Control Plane workspace ID | cloud-determined | per-workspace after Phase 2 | Fixed |
| WhatsApp auth | per-workspace DB (`whatsapp_connections`) | no | Re-scan needed per workspace |
| Telegram tokens | per-workspace DB | no | Re-add needed per workspace |
| OAuth connectors | per-workspace DB | no | Re-OAuth needed per workspace |
| Local agent configs | per-workspace DB | no | Fresh DB gets agents from cloud on connect |
| Tasks/goals/contacts | per-workspace DB | no | Already isolated |
| MCP server context | follows active daemon | no | Already isolated |

## 10. Risks and open questions

1. **Machine ID collision.** Both workspaces on one machine send the same `machineId`. Cloud likely uses `(workspaceId, machineId)` for device dedup — with different cloud workspaces this is fine. **To verify**: register same machine against two licenses, confirm cloud creates two device rows.

2. **Integration connection locks.** WhatsApp connection locks (`src/whatsapp/auth-state.ts:58-89`) are machine-scoped. Same WhatsApp number in two workspaces → one loses the lock. Accept as documented constraint.

3. **Device limit exhaustion.** Each license has a `maxRuntimes`. Rapidly switching workspaces may temporarily show two devices. Daemon `disconnect()` on graceful stop already handles this (`control-plane/client.ts:179`).

4. **First-connect rollback.** If `syncAgentConfigs` partially succeeds and then a later step fails, local DB has partial state. **Phase 2 fix**: wrap the whole connect-then-sync-then-consolidate block in a SQLite transaction.

5. **Per-workspace inheritance surprises.** `workspace.json` that sets `licenseKey` but omits model keys will silently use the global model keys. `workspace info` should show which fields are inherited vs overridden.

## 11. Implementation file map

### Phase 1 (~150 LoC)

| File | Change |
|---|---|
| `src/config.ts` | `WorkspaceConfig` type + read/write helpers + `applyWorkspaceOverrides` + `loadConfig` refactor |
| `src/index.ts` | `workspace create --local-only`, `workspace info <name>`, `workspace list` mode markers |
| `src/daemon/start.ts` | No changes (gates on `tier !== 'free'` already) |

### Phase 2 (~300 LoC)

| File | Change |
|---|---|
| `src/config.ts` | `findWorkspaceByLicenseKey`, `findWorkspaceByCloudId`, cloud-mode override logic |
| `src/index.ts` | `workspace create --license-key`, `workspace link`, `workspace unlink`, info enhancements |
| `src/daemon/start.ts` | Cross-workspace conflict check + post-connect persistence |
| `src/control-plane/client.ts` | Forward `requestedWorkspaceId` from workspace config |
| `src/control-plane/types.ts` | Add `requestedWorkspaceId?: string` to `ConnectRequest` |

## 12. Testing

### Phase 1 smoke
1. `workspace create ws-test1 --local-only` → creates dir + workspace.json
2. `workspace list` → shows marker
3. `workspace info ws-test1` → local-only, tier free
4. `workspace use ws-test1` → daemon boots, no `[ControlPlane] Connected` in log
5. Switch back to default, cleanup

### Phase 2 smoke (state transitions)
1. `workspace create ws-test2 --license-key=fake-license-abc` → creates cloud-mode config
2. `workspace info ws-test2` → cloud mode, masked license
3. `workspace create ws-test3 --license-key=fake-license-abc` → **refuses** (mirror detection)
4. `workspace unlink ws-test2` → reverts to local-only
5. `workspace link ws-test2 --license-key=different-license` → promotes back to cloud
6. Cleanup

### Phase 2 end-to-end (manual, requires real second license)
Deferred to user. After minting a second ohwow.fun workspace + license:
1. `workspace create avenued-ops --license-key=<real>`
2. `workspace use avenued-ops`
3. Verify daemon connects, `cloudWorkspaceId` gets persisted in `workspace.json`
4. Switch back to default, verify no cross-pollution.
