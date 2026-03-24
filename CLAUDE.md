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

## References

- [ARCHITECTURE.md](./ARCHITECTURE.md) for system design and module interactions
- [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, PR process, and DCO requirements
