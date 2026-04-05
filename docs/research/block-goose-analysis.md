# Block/Goose — Deep Analysis

> Research date: 2026-04-05
> Repository: https://github.com/block/goose
> Version analyzed: v1.30.0

## Overview

**Goose** is an open-source, local, model-agnostic AI agent built by **Block, Inc.** (Square, Cash App, Afterpay). It automates end-to-end engineering workflows — building projects, debugging, running tests, managing APIs, and orchestrating complex multi-step tasks autonomously.

| Metric | Value |
|--------|-------|
| Stars | ~36,500 |
| Forks | ~3,500 |
| Contributors | 373+ |
| Releases | 126 |
| License | Apache-2.0 |
| Governance | Linux Foundation (Agentic AI Foundation) |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Core | Rust (~58% of codebase) |
| Desktop UI | Electron + TypeScript/React (~34%) |
| Async Runtime | Tokio |
| HTTP Server | Axum (binary: `goosed`, port 3000) |
| CLI | Clap |
| Code Parsing | Tree-sitter (Go, Java, JS, Kotlin, Python, Ruby, Rust, Swift, TS) |
| Observability | OpenTelemetry |
| Local Inference | candle-core, llama-cpp |
| Database | SQLite via sqlx |
| Build | Cargo workspace, Hermit for toolchain management |

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   User Interfaces                │
│  ┌──────────┐  ┌───────────┐  ┌──────────────┐  │
│  │   CLI    │  │  Desktop  │  │  IDE Plugins │  │
│  │(goose-cli)│ │ (Electron)│  │(VS Code/JB)  │  │
│  └────┬─────┘  └─────┬─────┘  └──────┬───────┘  │
│       └───────────────┼───────────────┘          │
│                       ▼                          │
│              ┌────────────────┐                  │
│              │  goose-server  │  (Axum HTTP API) │
│              └───────┬────────┘                  │
│                      ▼                           │
│              ┌────────────────┐                  │
│              │   goose (core) │                  │
│              │  Agent Engine  │                  │
│              │  - Conversations                  │
│              │  - Tool Execution                 │
│              │  - Security/Permissions            │
│              │  - Token Counting                 │
│              │  - Model Routing                  │
│              │  - Sub-agent Orchestration         │
│              └──┬──────────┬──┘                  │
│                 ▼          ▼                      │
│  ┌──────────────┐  ┌──────────────┐              │
│  │  goose-mcp   │  │  goose-acp   │              │
│  │  (Extensions) │  │ (Agent Comm) │              │
│  └──────┬───────┘  └──────────────┘              │
│         ▼                                        │
│  ┌──────────────────────────────┐                │
│  │     MCP Servers (Extensions) │                │
│  │  Developer · Memory · Browser│                │
│  │  Computer Controller · etc.  │                │
│  └──────────────────────────────┘                │
└─────────────────────────────────────────────────┘
         │
         ▼
  ┌─────────────────────────┐
  │     LLM Providers       │
  │  Anthropic · OpenAI     │
  │  Google · Ollama · AWS  │
  │  Azure · OpenRouter     │
  │  Databricks · XAI · ... │
  └─────────────────────────┘
```

## Workspace Crates

| Crate | Purpose |
|-------|---------|
| `goose` | Core agent framework — conversations, tools, security, permissions, scheduling, config, model routing, OAuth |
| `goose-server` | Axum HTTP API server (`goosed` binary) |
| `goose-cli` | CLI with 16+ commands (configure, session, recipe, schedule, mcp, acp, etc.) |
| `goose-mcp` | MCP extensions — developer tools, memory, computer controller, browser |
| `goose-acp` | Agent Client Protocol for IDE integration |
| `goose-acp-macros` | Proc macros for ACP |
| `goose-sdk` | Developer SDK |
| `goose-test` / `goose-test-support` | Test framework and helpers |

## Extension System

Extensions are MCP servers connected via different transport mechanisms. Six extension types:

1. **Stdio** — spawns an external process communicating over stdin/stdout
2. **StreamableHttp** — connects to HTTP-based MCP servers
3. **Builtin** — compiled into the Goose binary, registered via global thread-safe registry
4. **Platform** — direct access to agent process internals (in-process)
5. **Frontend** — tools provided by the UI layer
6. **InlinePython** — Python code executed via `uvx`

Security: a 31-item blocklist prevents extensions from overriding critical environment variables (PATH, LD_PRELOAD, PYTHONPATH, etc.).

## AI Provider Support

40+ provider modules including: Anthropic, OpenAI, Google/Gemini, Azure, AWS Bedrock, Databricks, Ollama, LiteLLM, OpenRouter, GitHub Copilot, xAI, Venice, Snowflake, and local inference engines.

Model configuration includes: context limit (default 128K), temperature, max tokens (default 4096), reasoning mode detection, and tool shimming for models without native tool use.

## Tool Execution Pipeline

1. LLM generates tool calls in its response
2. Tool confirmation router decides if user approval is needed
3. For sensitive tools: confirmation channel registered, action-required event yielded, execution blocks until user responds
4. Call dispatched to the correct extension's MCP server
5. Results streamed back with optional progress notifications
6. Tool monitor detects potential issues like infinite loops (`--max-tool-repetitions`)
7. Large response handler manages oversized outputs
8. Complex tasks can spawn subagents for agent composition

## Key Differentiators

1. **Model-agnostic** — 25+ LLM providers including local models via Ollama
2. **MCP-native** — every extension is an MCP server; co-developed the standard with Anthropic
3. **Recipes** — reusable YAML workflow definitions (goals, extensions, inputs, sub-recipes)
4. **Privacy-first** — runs on-machine, no data sent to Block
5. **Approval-gated execution** — security inspection and user confirmation for sensitive tools
6. **Sub-agent orchestration** — agent hierarchies with dynamic model selection
7. **Free and open-source** — Apache-2.0, no subscription tiers

## Competitive Positioning

| | Goose | Claude Code | Cursor | Aider |
|---|---|---|---|---|
| Type | Standalone agent | CLI agent | IDE | CLI tool |
| Models | 25+ providers | Claude only | Multi-model | Multi-model |
| Open source | Yes (Apache-2.0) | No | No | Yes (Apache-2.0) |
| Extension system | MCP servers | MCP servers | Plugins | Limited |
| Focus | Full workflow automation | Coding agent | IDE code editing | Git-aware code editing |
| Cost | Free (pay your LLM) | Subscription | Subscription | Free (pay your LLM) |

## Relevance to ohwow

Both Goose and ohwow share architectural patterns:

- **MCP integration** for tool extensibility
- **Agent orchestration** with sub-agents
- **Model-agnostic routing** (Ollama, Anthropic, etc.)
- **CLI + UI interfaces**
- **SQLite for persistence**

Key areas where Goose's approach could inform ohwow:
- Rust-based tool execution with approval gates
- Recipes system for shareable workflows
- MCP-native extension architecture with 6 transport types
- 31-item env var blocklist for extension security
- Tool monitoring and infinite loop detection
