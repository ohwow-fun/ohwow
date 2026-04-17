# ohwow MCP Tools Reference

Complete registry of all MCP tools exposed by the ohwow runtime to Claude Code and other MCP clients. Tools are grouped by domain. Each tool name starts with `ohwow_`.

## How Tools Work

```
Claude Code  →  MCP Server (stdio)  →  DaemonApiClient  →  Express API  →  SQLite
```

- **Direct tools** call REST endpoints via `client.get()` / `client.post()` / `client.patch()`. Fast (~100ms).
- **AI-powered tools** route through the orchestrator via `client.postSSE('/api/chat', ...)`. Slower (~15-60s) but can use all 88+ internal orchestrator tools.

## Tool Categories

| Category | Tools | Description |
|----------|-------|-------------|
| [Orchestrator](#orchestrator) | 2 | Send messages to the AI orchestrator |
| [Agents](#agents) | 9 | Agent lifecycle, paths, CRUD |
| [Tasks](#tasks) | 2 | Task execution and status |
| [Workspace](#workspace) | 4 | Workspace switching, daemon lifecycle |
| [CRM](#crm) | 3 | Contact management |
| [Deals](#deals) | 5 | Deal pipeline, revenue |
| [Calendar](#calendar) | 3 | Events and availability |
| [Email](#email) | 3 | Inbox search, AI summaries, drafts |
| [Briefing](#briefing) | 1 | Daily digest |
| [Documents](#documents) | 4 | Templates, generation, e-signatures |
| [Support](#support) | 4 | Tickets and metrics |
| [Analytics](#analytics) | 2 | Website analytics, business reports |
| [Finance](#finance) | 3 | Expenses and P&L |
| [Time](#time) | 2 | Time tracking and reports |
| [Team](#team) | 1 | Team member listing |
| [Projects](#projects) | 2 | Project management |
| [Goals](#goals) | 1 | Goal tracking |
| [Workflows](#workflows) | 2 | Workflow execution |
| [Automations](#automations) | 2 | Automation management |
| [Knowledge](#knowledge) | 3 | Knowledge base (RAG) |
| [Research](#research) | 2 | Web research and scraping |
| [Messaging](#messaging) | 2 | WhatsApp and Telegram |
| [Cloud](#cloud) | 2 | Cloud dashboard |
| [MCP Servers](#mcp-servers) | 4 | Third-party MCP registration |
| [Permissions](#permissions) | 2 | Permission request handling |
| [Observability](#observability) | 3 | Trigger health, findings, insights |
| [LLM](#llm) | 1 | Direct model routing |

---

## Orchestrator

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_chat` | AI | Send a message to the orchestrator (88+ internal tools). Returns conversationId immediately. Poll with `ohwow_get_chat`. |
| `ohwow_get_chat` | Direct | Poll an in-flight conversation. Status: "running", "done", or "error". |

## Agents

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_list_agents` | Direct | List all agents with status, role, and capabilities. |
| `ohwow_run_agent` | Direct | Execute an agent with a prompt. Returns async task ID. |
| `ohwow_create_agent` | Direct | Create a new agent with system prompt and tool allowlist. |
| `ohwow_get_agent` | Direct | Fetch full agent configuration. |
| `ohwow_update_agent` | Direct | Modify agent settings (prompt, tools, schedule, enabled). |
| `ohwow_delete_agent` | Direct | Delete an agent and its memory. |
| `ohwow_grant_agent_path` | Direct | Grant filesystem access to a directory. |
| `ohwow_list_agent_paths` | Direct | List all granted filesystem paths. |
| `ohwow_revoke_agent_path` | Direct | Revoke filesystem access. |

## Tasks

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_get_task` | Direct | Get task status and result by ID. |
| `ohwow_list_tasks` | Direct | List recent tasks. Filter by status or agent. |

## Workspace

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_workspace_status` | Direct | Agent count, uptime, tier, system stats. |
| `ohwow_workspace_list` | Direct | List all local workspaces with port and status. |
| `ohwow_workspace_use` | Direct | Switch this MCP session to a different workspace. |
| `ohwow_daemon_status` | Direct | Check if the daemon is running. |
| `ohwow_daemon_start` | Direct | Start the daemon. |
| `ohwow_daemon_stop` | Direct | Stop the daemon. |
| `ohwow_daemon_restart` | Direct | Full stop + start cycle. |

## CRM

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_list_contacts` | Direct | List contacts with quick filter by name/email/company. |
| `ohwow_create_contact` | Direct | Add a new contact (defaults to lead/active). |
| `ohwow_search_contacts` | AI | Deep full-text search across all contact fields including notes. |

## Deals

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_list_deals` | Direct | List deals with stage, value, close date. Filter by stage/contact/owner. |
| `ohwow_create_deal` | Direct | Create a deal linked to a contact. |
| `ohwow_update_deal` | Direct | Move stage, update value/close date. Stage changes auto-logged. |
| `ohwow_pipeline_summary` | Direct | Pipeline overview: count/value per stage, weighted forecast, win rate. |
| `ohwow_revenue_summary` | Direct | MRR, growth %, ARR, monthly trend, won deal metrics. |

## Calendar

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_list_events` | Direct | List calendar events for a date range. |
| `ohwow_create_event` | Direct | Create event with attendees, location, recurrence. |
| `ohwow_find_availability` | Direct | Find free time slots (business hours, weekdays). |

## Email

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_search_emails` | Direct | Search/filter emails by sender, subject, date, read status. Fast. |
| `ohwow_summarize_inbox` | AI | AI summary of unread emails grouped by priority (~30s). |
| `ohwow_draft_reply` | AI | AI-drafted reply based on instructions, saved as draft (~20s). |

## Briefing

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_daily_briefing` | AI | Morning digest: calendar + pipeline + tasks + stale leads + revenue (~60s). |

## Documents

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_list_templates` | Direct | List document templates. Filter by type. |
| `ohwow_create_template` | Direct | Create template with `{{variable}}` placeholders. |
| `ohwow_generate_document` | Direct | Generate from template. Auto-populates CRM + deal data. |
| `ohwow_send_for_signature` | Direct | Send document for e-signature (manual tracking, provider hooks ready). |

## Support

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_list_tickets` | Direct | List tickets. Filter by status/priority/assignee/contact. |
| `ohwow_create_ticket` | Direct | Create ticket with auto-assigned number. Link to contact. |
| `ohwow_update_ticket` | Direct | Change status + add internal note in one call. Auto-tracks SLA timestamps. |
| `ohwow_ticket_metrics` | Direct | Avg response time, resolution time, SLA compliance, volume by category. |

## Analytics

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_website_analytics` | Direct | Traffic, top pages, referrers from analytics snapshots. |
| `ohwow_business_report` | AI | Weekly report: revenue + pipeline + contacts + tasks + support (~60s). |

## Finance

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_list_expenses` | Direct | List expenses with category, amount, vendor, date. |
| `ohwow_log_expense` | Direct | Log expense with category, vendor, tax deductible flag. |
| `ohwow_financial_summary` | Direct | P&L: revenue minus expenses, breakdown by category, tax-deductible total. |

## Time

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_track_time` | Direct | Log time on a project, deal, or ticket. |
| `ohwow_time_report` | Direct | Report grouped by person, project, or date. Total + billable hours. |

## Team

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_list_team` | Direct | List team members with name, role, department, hourly rate. |

## Projects

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_list_projects` | Direct | List projects with task counts and status. |
| `ohwow_create_project` | Direct | Create a new project. |

## Goals

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_list_goals` | AI | List workspace goals with progress tracking (~15s). |

## Workflows

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_list_workflows` | Direct | List workflows with step definitions and run history. |
| `ohwow_run_workflow` | AI | Execute a workflow by ID (~60s). |

## Automations

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_list_automations` | Direct | List automations with triggers, actions, and fire counts. |
| `ohwow_run_automation` | Direct | Manually trigger an automation. |

## Knowledge

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_list_knowledge` | AI | List all knowledge base documents (~15s). |
| `ohwow_search_knowledge` | AI | Semantic RAG search with source attribution (~15s). |
| `ohwow_add_knowledge_url` | AI | Ingest a web page into the knowledge base (~30s). |

## Research

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_deep_research` | AI | Multi-source web research. Depths: quick (~30s), thorough (~60s), comprehensive (~120s). |
| `ohwow_scrape_url` | Direct | Scrape a web page with anti-bot handling. |

## Messaging

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_send_message` | AI | Send via WhatsApp or Telegram. Channel must be connected first. |
| `ohwow_list_chats` | AI | List connected chats for a channel. |

## Cloud

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_list_sites` | Direct | List sites on ohwow.fun. Requires cloud connection. |
| `ohwow_list_integrations` | Direct | List connected integrations (Gmail, GitHub, Stripe, etc.). |

## MCP Servers

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_add_mcp_server` | Direct | Register an external MCP server (HTTP or stdio). |
| `ohwow_list_mcp_servers` | Direct | List registered MCP servers (credentials redacted). |
| `ohwow_remove_mcp_server` | Direct | Unregister and disconnect an MCP server. |
| `ohwow_test_mcp_server` | Direct | Test connectivity and list exposed tools. |

## Permissions

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_list_permission_requests` | Direct | List tasks awaiting filesystem/bash permission decisions. |
| `ohwow_approve_permission_request` | Direct | Approve (once/always) or deny a permission request. |

## Observability

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_list_failing_triggers` | Direct | List triggers with consecutive failures (stuck crons). |
| `ohwow_list_findings` | Direct | Query self-bench experiment ledger. Filter by experiment, category, severity. |
| `ohwow_list_insights` | Direct | Query distilled insights ranked by novelty and importance. |

## LLM

| Tool | Type | Description |
|------|------|-------------|
| `ohwow_llm` | Direct | Invoke ohwow's model router for a sub-task. Supports tool-use loops. Returns model_used, tokens, cost_cents, latency_ms. |

---

## Adding New Tools

Checklist:
1. Tool name: `ohwow_<verb>_<noun>` (e.g. `ohwow_list_deals`)
2. Description: `[Category] What it does. What it returns. When to use it vs alternatives.`
3. Every Zod param has `.describe()` with format (e.g. `YYYY-MM-DD`, `cents`, `UUID`)
4. Long-running tools (~15s+) note the timeout in the description
5. Similar tools disambiguate (e.g. "For quick filtering use X, for deep search use Y")
6. File: `src/mcp-server/tools/<domain>.ts`, export `register<Domain>Tools(server, client)`
7. Barrel: add import + call in `src/mcp-server/tools.ts`
8. API route: `src/api/routes/<domain>.ts`, export `create<Domain>Router(db, eventBus)`
9. Server: add import + `app.use()` in `src/api/server.ts`
10. Migration: `src/db/migrations/<NNN>-<name>.sql`, then `npm run regen:migration-registry`
