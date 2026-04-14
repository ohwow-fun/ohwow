# CLAUDE.md — ohwow runtime

Rules for AI-assisted contributions to ohwow. Shared conventions (git workflow, copywriting, backward compatibility) live in the [parent CLAUDE.md](../CLAUDE.md).

## Validation

Run before every commit:

```bash
npm run typecheck && npm test
```

## Code Conventions

- **ESM only.** All local imports use `.js` extensions: `import { foo } from './bar.js'`
- **Structured logging.** Use `import { logger } from './lib/logger.js'` (pino). Never `console.log`, `console.error`, or `console.warn`
- **Database access.** Use the `DatabaseAdapter` interface in `src/db/`. Never write raw SQL outside of migrations
- **DCO sign-off required.** All commits need `git commit -s -m "fix: description"`

## Testing

- **Framework:** Vitest
- **Location:** `__tests__/` directories colocated with source
- **AI call timeout:** 60s for tests that hit a model
- **Fixtures:** Use the `baseArgs()` pattern for shared test setup
- **Commands:** `npm test` runs all tests, `npm run test:watch` for watch mode

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `src/orchestrator/` | AI agent orchestration, tool execution, system prompts |
| `src/tui/` | Terminal UI (Ink/React), onboarding, agent presets |
| `src/web/` | Browser dashboard (Vite/React) |
| `src/api/` | Express HTTP API server |
| `src/db/` | SQLite database adapter, migrations, schema |
| `src/peers/` | Multidevice mesh networking, peer discovery, task routing |
| `src/triggers/` | Event triggers, field mapping, scheduling |
| `src/mcp/` | MCP client for tool integration |
| `src/mcp-server/` | MCP server exposing ohwow to Claude Code |
| `src/execution/` | Model routing (Ollama/Anthropic), task execution |
| `src/planning/` | Task planning and decomposition |
| `src/lib/` | Shared utilities (logger, config, feature gates, prompt safety) |
| `src/integrations/` | Third-party service integrations |
| `src/voice/` | Voice input/output, text-to-speech |
| `src/whatsapp/` | WhatsApp/Telegram messaging channels |
| `src/browser/` | Browser automation via Playwright |
| `src/control-plane/` | Cloud control plane client |
| `src/tunnel/` | Cloudflare tunnel management |
| `src/webhooks/` | Inbound webhook handling |
| `src/scheduler/` | Cron-based task scheduling |
| `src/a2a/` | Agent-to-agent protocol (Google A2A) |

## Good Places to Start

- Agent templates in `src/tui/data/agent-presets.ts`
- Tests for existing modules (many have zero coverage)
- Bug fixes and error handling improvements
- Documentation improvements

## Workspaces

ohwow supports multiple workspaces running in parallel — each gets its own
SQLite DB under `~/.ohwow/workspaces/<name>/`, its own daemon process on
its own port, and optionally its own cloud workspace under a separate
license key. The active "focus" lives in `~/.ohwow/current-workspace`.

CLI:

- `ohwow workspace list` — all workspaces with mode + running status
- `ohwow workspace create <name> [--local-only|--cloud|--license-key=...]`
- `ohwow workspace start [<name>] [--all]` / `stop` / `restart`
- `ohwow workspace use <name>` — set focus (does NOT stop other daemons)
- `ohwow workspace info [<name>]`

MCP tools (Claude Code sessions):

- `ohwow_workspace_list` — discover available workspaces
- `ohwow_workspace_use(name)` — retarget this MCP session without
  restarting Claude Code

Implementation rules for contributors:

- **Never hardcode `WHERE id='local'`** on `agent_workforce_workspaces` or
  `WHERE workspace_id='local'` on its child tables. The daemon's boot-time
  consolidation (`src/daemon/start.ts`) rewrites the seed row's id to the
  cloud workspace UUID when a license key is configured, and post-
  consolidation the literal `'local'` returns nothing. Read positionally
  with `LIMIT 1` and use the resolved row's id to scope downstream
  queries on `agent_workforce_agents` / `agent_workforce_tasks`.
- **Never hardcode port 7700 or `~/.ohwow/data/`** in new code. Use
  `resolveActiveWorkspace()`, `portForWorkspace(name)`,
  `workspaceLayoutFor(name)`, and `readWorkspaceConfig(name)` from
  `src/config.ts`. Daemons can run on any port; data dirs are always
  under `~/.ohwow/workspaces/<name>/`.
- **Daemon spawning** must propagate `OHWOW_WORKSPACE` and `OHWOW_PORT`
  to the child via `startDaemonBackground` in `src/daemon/lifecycle.ts`.
  Don't bypass this — the child needs both env vars to bind to the
  right workspace.
- **`workspace use` is focus-only** under the parallel-daemon model. It
  must not stop the previously focused workspace's daemon. The whole
  point is parallel execution — schedulers, agents, integrations, and
  ControlPlane sync run for every started workspace simultaneously.
- **Per-workspace config layering**: `loadConfig()` reads global
  `~/.ohwow/config.json` then layers per-workspace overrides via
  `applyWorkspaceOverrides` from the active workspace's `workspace.json`.
  The default workspace has no `workspace.json` (legacy behavior). If
  you add a new override-able field, wire it through both layers.

See `docs/multi-workspace-plan.md` for the full design + migration history.

## References

- [ARCHITECTURE.md](./ARCHITECTURE.md) for system design and module interactions
- [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, PR process, and DCO requirements
