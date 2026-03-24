# Architecture

## Overview

ohwow is a local-first AI business operating system that runs on your machine. It provides an orchestrator (conversational AI COO), a fleet of AI agents, automation workflows, CRM, messaging integrations, and a multidevice mesh. Everything is stored in a local SQLite database. Cloud features are optional and additive.

## System Flow

```
CLI Entry (src/index.ts)
  |
  ├── TUI (terminal dashboard)
  |     └── React/Ink app (src/tui/)
  |
  └── Daemon (src/daemon/)
        |
        ├── HTTP Server + WebSocket (src/api/)
        |     └── Web UI served at :7700 (src/web/)
        |
        ├── Execution Engine (src/execution/)
        |     └── Model Router → Ollama / Claude / OpenRouter
        |
        ├── Orchestrator (src/orchestrator/)
        |     └── 150+ tools for business operations
        |
        ├── Scheduler (src/scheduling/)
        |     └── Cron-based agent and workflow triggers
        |
        ├── Trigger Evaluator (src/triggers/)
        |     └── Webhook and event-based automation
        |
        ├── Mesh Networking (src/peers/)
        |     └── mDNS discovery, task routing, leader election
        |
        ├── Messaging (src/whatsapp/, src/integrations/)
        |     └── WhatsApp (Baileys), Telegram
        |
        └── Control Plane Client (src/control-plane/)
              └── Optional cloud sync with ohwow.fun
```

## Module Map

| Directory | What it does |
|-----------|-------------|
| `src/a2a/` | Agent-to-Agent protocol (JSON-RPC 2.0, trust levels, agent cards) |
| `src/api/` | Express HTTP server, REST routes, WebSocket handler |
| `src/browser/` | Playwright browser automation (navigation, scraping, screenshots) |
| `src/control-plane/` | Cloud connection to ohwow.fun (sync, task dispatch, heartbeats) |
| `src/daemon/` | Process daemonization, lifecycle management, PID files |
| `src/db/` | SQLite adapter, query builder, schema migrations |
| `src/execution/` | Agent task execution engine, model router, tool execution |
| `src/integrations/` | Telegram bot, external service connectors |
| `src/lib/` | Shared utilities: logger, RAG, telemetry, prompt injection, onboarding |
| `src/mcp/` | MCP client (consume external tools via Model Context Protocol) |
| `src/mcp-server/` | MCP server (expose ohwow tools to Claude Code and other MCP clients) |
| `src/media/` | Media processing (images, audio, file handling) |
| `src/orchestrator/` | Conversational AI orchestrator with 150+ tools |
| `src/peers/` | Multidevice mesh: mDNS discovery, leader election, task routing |
| `src/planning/` | Goal decomposition, multi-step plan generation |
| `src/scheduler/` | Low-level scheduler implementation |
| `src/scheduling/` | Cron-based schedule management for agents and workflows |
| `src/services/` | Service initialization and dependency wiring |
| `src/triggers/` | Webhook triggers, event evaluation, automation dispatch |
| `src/tui/` | Terminal UI built with React/Ink (dashboard, agents, tasks, CRM) |
| `src/tunnel/` | Cloudflare tunnel integration for external access |
| `src/types/` | Shared TypeScript type definitions |
| `src/voice/` | Speech-to-text and text-to-speech pipelines |
| `src/web/` | Web UI built with React/Vite, served by the HTTP server |
| `src/webhooks/` | Webhook processing and routing |
| `src/whatsapp/` | WhatsApp integration via Baileys (QR code auth, message handling) |

## Key Data Flows

### 1. Agent Task Execution

```
User message (TUI/Web/WhatsApp/API)
  → Orchestrator receives message
  → Tool selection (from 150+ available tools)
  → If agent task: Engine.executeTask()
    → Model Router picks provider (Ollama local / Claude / OpenRouter)
    → LLM generates response (with tool calls if needed)
    → Tool execution loop (ReAct pattern)
    → Result stored in SQLite
    → Memory extraction (facts, skills, feedback) via RAG
  → Response returned to user
```

### 2. Automation DAG Execution

```
Trigger fires (webhook / schedule / manual)
  → Trigger evaluator matches conditions
  → Workflow loaded (DAG of steps)
  → Steps executed in dependency order:
    → agent_prompt, run_agent, save_contact, conditional branch,
      webhook_forward, transform_data, create_task, etc.
    → Parallel branches execute concurrently
  → Results logged, contacts updated
```

### 3. Mesh Networking

```
Runtime starts
  → mDNS advertisement (Bonjour/Avahi)
  → Discover peers in same workspace group
  → Exchange capabilities (RAM, GPU, loaded models, queue depth)
  → Leader election (lowest MAC address wins)
  → Leader runs singleton services (scheduler, proactive engine)
  → Task routing: score peers by capability match
  → Overflow delegation: full queue → idle peer with capacity
  → Health monitoring: 3 missed pings → peer marked offline
```

## Database

SQLite via `better-sqlite3`. Schema managed through sequential migrations in `src/db/migrations/`. Key tables:

- `agents` — agent configs, system prompts, settings
- `tasks` — task history (input, output, status, timing)
- `agent_memories` — RAG-indexed facts, skills, feedback
- `contacts` — CRM contacts with pipeline stage
- `contact_events` — activity timeline (calls, emails, meetings)
- `schedules` — cron schedules for agents and workflows
- `workflows` — automation DAG definitions
- `workflow_runs` — execution history
- `approvals` — pending human-in-the-loop items
- `projects` / `project_tasks` — Kanban boards

## Configuration

Config file: `~/.ohwow/config.json`

Key fields:
- `licenseKey` — ohwow.fun cloud license (optional)
- `ollamaUrl` — Ollama server URL
- `ollamaModel` — default local model
- `anthropicApiKey` — Claude API key (optional)
- `preferLocalModel` — route to Ollama first
- `port` — HTTP server port (default 7700)
- `workspaceGroup` — mesh group name for peer filtering
- `deviceRole` — "hybrid", "worker", or "coordinator"

See `.env.example` for all environment variable overrides.

## Web UI

React + Vite app in `src/web/`. Built during `npm run build` and served by Express at `http://localhost:{port}`. Same capabilities as the TUI. Development server: `npm run dev:web` (port 7701 with HMR).

## TUI

React + Ink app in `src/tui/`. Renders directly in the terminal. Tab-based navigation: Dashboard, Agents, Tasks, Approvals, Activity, Automations, Contacts, Settings. Communicates with the daemon via the same HTTP/WebSocket API as the Web UI.
