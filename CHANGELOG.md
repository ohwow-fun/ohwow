# Changelog

## [0.10.1] — 2026-04-22

### Fixed

- fix(tui): seed workspaceId from local DB, persist reconnect polling
- fix(tests): replace key-shaped fixture strings with short placeholders

## [0.10.0] — 2026-04-22

### Added

- **TUI redesign**: Onboarding collapsed from 10 steps to 2 questions (`FirstMomentStep` — business name + first task). `ExperienceChoiceStep`, `ModelStep`, `AgentDiscoveryStep`, `AgentSelectionStep`, and `IntegrationSetupStep` removed from the onboarding flow.
- **TUI redesign**: `Today` state board replaces the dashboard grid as the home screen. Three zones: agent roster (live status), attention queue (approvals surface red, `a`/`r` to act), dispatch rail.
- **TUI redesign**: 4-section navigation — Today (1), Team (2), Work (3), Settings (4). Number keys switch sections from anywhere.
- **TUI redesign**: Contacts and People consolidated under Team; Activity and Automations consolidated under Work.
- **TUI redesign**: Universal keyboard grammar — `j`/`k` navigate all lists, `Escape` is back-only, `?` opens context help. Persistent status bar on every screen shows current section and available keys.
- **TUI redesign**: Floating dispatch overlay on `d` from any screen — type a task, optional `@agent`, `Enter` queues it without leaving the current view.
- **TUI redesign**: Post-onboarding landing on Today with the first agent in the roster; `needsOnboarding` banner removed.
- **Eternal system**: `EternalSpec` runtime module with inactivity watcher, conservative mode, and values corpus.
- **Eternal system**: Trustee escalation — `requiresTrusteeApproval` wired into conductor; email/webhook delivery for trustee notifications.
- **Eternal system**: `ohwow eternal init` wizard to configure spec, trustee contact, and values corpus.
- **Eternal system**: `GET /api/eternal/state` and `GET`/`PUT /api/eternal/config` runtime endpoints.
- **Eternal system**: `eternal.config.json` loaded at daemon boot; inactivity watcher scheduled hourly.
- **Eternal system**: Layer 2 revenue leak watcher — detects unattributed payment events.
- **Eternal system**: Layer 2 infrastructure bill tracker — migration 150, route, and watcher.
- **Eternal system**: Layer 4 contact SLA watcher — surfaces at-risk relationships.
- **Eternal system**: `recordActivity` wired into API middleware and CLI for activity tracking.
- **Eternal system**: Values corpus injected into orchestrator system prompt.
- **Video**: HeyGen avatar provider and `ohwow video avatar` command.
- **Video**: Higgsfield text-to-video provider.
- **Video**: Standardized provider metadata — Seedance, Kling v2, Runway, and credit tier definitions.
- **Browser/CDP**: `cdp_trace_events` SQLite table (migration 147) with structured trace logs across all browser/tab/action lifecycle points. `ohwow_list_cdp_events` MCP verb.
- **Self-bench**: `ModelInductionProbeExperiment` — closes the discovery → self-test loop; inducted models auto-promote to `runtime_config` pool.
- **Self-bench**: `ModelReleaseMonitorExperiment` — 12h model release tracking.
- **Sync**: `self_findings` registered in `SYNC_REGISTRY` for cloud sync.
- **Dev**: TUI journey simulator (`npm run tui-journey`) for visual QA of screen transitions.

### Fixed

- **Browser**: Reuse existing CDP tab in deliverable and tool executors; eliminated stale-Chrome singleton with `killStaleDebugChrome`.
- **Browser**: Normalize `claimTarget.profileDir` to filesystem path in composer helpers.
- **Autonomy**: Use OpenRouter model ID format (`anthropic/claude-haiku-4.5`) for default planning model.
- **Voice**: Allow product mention in `buyer_intent` reply prompts.
- **Daemon**: Apply per-workspace license key for secondary workspaces.
- **Dependencies**: Patch 5 Dependabot vulnerabilities via npm overrides.

## [0.9.0] — 2026-04-16

### Added
- **Showcase**: `ohwow showcase <target>` Phase 1 MVP
- **Showcase**: Parallel probe scanner for epic first impression
- **Funnel surgeon**: Attribution rollup view (migration 128)
- **Funnel surgeon**: Public attribution hit endpoint
- **Funnel surgeon**: Stripe webhook for `plan:paid` attribution
- **Funnel surgeon**: Attribution observer experiment (advisory)
- **Outreach**: Thermostat experiment (proposal-only, off by default)
- **Outreach**: Cross-channel cooldown policy (`src/lib/outreach-policy.ts`)
- **Outreach**: Email channel via Resend (dispatcher + thermostat wiring)

### Changed
- **Sales loop**: Capture live-run-1 observations in `TUNING-NOTES` (handles redacted)

## [0.8.2] — 2026-04-13

### Added
- **X posting**: `content_calendar` sync and two-step article publish flow
- **X posting**: Deterministic X browser tools for launch week
- **MCP**: Switch workspaces from inside Claude Code
- **TUI**: Workspace name in header plus `/workspace` switcher

### Fixed
- **TUI**: Read `agent_workforce_workspaces` by row instead of hardcoded id

## [0.8.1] — 2026-04-13

### Added
- **Multi-workspace (phase 1 — local-only)**: Per-workspace config via `~/.ohwow/workspaces/<name>/workspace.json` layered on top of global `config.json`. Local-only mode blanks `licenseKey` and forces `tier='free'` so the daemon boots fully isolated, no `ControlPlaneClient`, no cloud sync — useful for operational sandbox brains. New CLI: `workspace create <name> --local-only`, `workspace create --name="Label"`, `workspace info [<name>]`; `workspace list` now shows `(local-only)` / `(cloud: Label)` markers. Helpers added to `config.ts`: `WorkspaceConfig`, `read/writeWorkspaceConfig`, `findWorkspaceByLicenseKey`, `findWorkspaceByCloudId`, `applyWorkspaceOverrides`.
- **Multi-workspace (phase 2 — cloud-integrated)**: Per-workspace license keys map to distinct cloud workspaces, so two local workspaces can each connect to their own ohwow.fun workspace without sharing state. Zero cloud-side changes. New CLI: `workspace link <name> --license-key=<k> [--name=...]`, `workspace unlink <name>`, `workspace create <name> --license-key=<k>`; `workspace info` now shows cloud metadata. Three-layer mirror-detection safety:
  1. Pre-create: refuses a license already in use by another local workspace (including the default via global `config.json`)
  2. Pre-connect (daemon boot): refuses if another `workspace.json` has pinned the same `cloudWorkspaceId`
  3. Post-connect: throws if a pinned `cloudId` doesn't match what the cloud returned (detects license reassignment), never silently re-points

  After a successful `ControlPlaneClient.connect()`, `cloudWorkspaceId` / `cloudDeviceId` / `lastConnectAt` are persisted back to `workspace.json`; failed connects skip persistence so retries stay idempotent. Forward-compat: `ConnectRequest` gains an optional `requestedWorkspaceId` populated from `workspace.json.requestedCloudWorkspaceId` (current cloud ignores unknown fields; enables future multi-workspace-per-license).

### Fixed
- **Security** — patch 4 Dependabot advisories via `package.json` override floors:
  - `axios >=1.15.0` — GHSA-fvcv-3m26-pcqx (critical: cloud metadata exfiltration via header injection chain) and GHSA-3p68-rc4w-qgx5 / CVE-2025-62718 (critical: NO_PROXY hostname normalization bypass → SSRF). Pulled in by `@whiskeysockets/baileys`.
  - `basic-ftp >=5.2.2` — GHSA-6v7q-wjvx-w8wg (high: incomplete CRLF injection protection allows arbitrary FTP command execution). Pulled in via `stagehand → puppeteer-core → pac-proxy-agent → get-uri`.
  - `langsmith >=0.5.18` — GHSA-fw9q-39r9-c252 / CVE-2026-40190 (medium: prototype pollution via incomplete `__proto__` guard in internal lodash `set()`). Pulled in via `stagehand → @langchain/core`.

## [0.8.0] — 2026-04-13

### Added
- **Wiki layer**: Karpathy-style wiki with tools + daemon API, lint, version history, orchestrator tool surface, and ambient curation (system prompt nudge + post-turn reflector emitting summaries/backlinks)
- **Workspace**: Switchable single-workspace support
- **Orchestrator**: Three-layer context-overflow defense, conversation persona (agents can drive a chat thread), `team_member` + chief-of-staff tools for human onboarding, knowledge intent for ingest/upload verbs
- **Onboarding**: `propose_first_month_plan` tool with persist + accept, `send_cloud_invite` tool, onboarding plan leverages ohwow
- **Team**: Cloud-side persona wiring, sync upstream + auto-activate on chat
- **Sync**: Centralized local→cloud dispatcher, sync agents/tasks/goals/onboarding plans upstream, contact + knowledge doc sync + activity feed, auto-record + attribute deliverables from chat tool chains
- **LLM organ**: Per-sub-task model selection via `selectForPurpose`, `llm_calls` telemetry table populating `RoutingHistory`, `config.model → config.model_policy.default` migration, `ohwow_llm` MCP tool + `/api/llm` route, router forwards `operationType` + predictive engine signal, `Purpose` superset + `AgentModelPolicy` types
- **Media**: Lyria audio SSE streaming served over loopback, `generated_media` SSE event beside `tool_done`
- **Browser**: `browser_evaluate` raw Playwright JS, auto-launch real Chrome with CDP + consent detection, `new_tab`/`switch_tab`/`close_tab`, Chrome profile resolution by email or alias for `desktop_focus_app` and browser path
- **MCP**: Daemon lifecycle tools
- **Tunnel**: Propagate cloudflared URL rotations + auto-restart on exit
- **Desktop**: Multi-monitor screenshot support
- **API**: Stub endpoints for dashboard-expected routes
- **Ramp tasks**: Default to guide-owned, justify member-owned

### Fixed
- **Workspace**: Handle pinned legacy `dbPath` in config.json, unify local workspace identity across HTTP + orchestrator, rename parent workspaces row during consolidation
- **Wiki-reflector**: Emit summaries + backlinks so curated pages stay lint-clean
- **Onboarding-plan**: Route synthesis through sonnet-4.6 + bump tokens
- **Person-model**: Observations FK + camelCase tolerance
- **Orchestrator**: Explicit tool-name mentions bypass intent filter, CRM intent loads business section, browser path uses `chromeProfileAliases`
- **RAG**: Title-token overlap before semantic chunk retrieval, knowledge discovery + filesystem + daemon introspection
- **Research**: Graceful degradation without Anthropic key
- **Bash**: Redact high-signal secrets from `run_bash` output
- **Browser**: Pass Stagehand API key + OpenRouter fallback, clone whole user-data-dir instead of symlinking, never auto-create browser singleton outside `/session/start`, `/browser/health` no longer creates singleton, `/export-cookies` accepts POST
- **Media**: Use valid Lyria model IDs, stream Lyria audio responses via SSE
- **WS**: Route upgrades via `noServer` mode so `/ws`, `/ws/terminal`, `/ws/voice` coexist; `/ws` accepts cloud content tokens for dashboard via tunnel
- **Daemon**: Scope local queries to `'local'` workspace, tear down HTTP-route browser singleton on shutdown, include cloud providers in `modelReady`
- **Desktop**: Persist remote desktop service across actions, screenshot endpoint returns raw JPEG for `Accept: */*`
- **Scrapling**: Bundle server tree + robust path + correct CLI invocation
- **Control-plane**: Accept real sync-resource response shape
- **MCP**: Resolve absolute ohwow path + PATH env for Claude Code spawn
- **API**: Move stub endpoints before agents router to avoid catch-all match, resolve `package.json` version from cwd
- **Deliverables**: Stop double-encoding content payloads

### Changed
- chore: Point `.mcp.json` to local dev binary instead of npx

## [0.7.0] — 2026-04-11

### Added
- **Center of Operations**: Full 6-phase implementation
  - Phase 1: Person Model schema (deep person ingestion) + orchestrator tools + refinement
  - Phase 2: Transition Engine schema + local runtime wiring
  - Phase 3: Work Router service + tools, wired into daemon + system prompt
  - Phase 4: Human Growth Engine + Skill Paths, wired with tools + daemon + tests
  - Phase 5: Observation Engine, wired with tools + daemon + tests
  - Phase 6: Collective Intelligence Engine, wired with tools + system prompt + tests
  - Operational pillars added to local runtime
  - Smoke tests for Center of Operations orchestrator tools
- **Desktop automation**: Context-aware SOP execution with window targeting, auto-detect display after focus/window, `list_windows` tool, `desktop_focus_app` tool, robust multi-monitor support with `move_window`, native dialog + copy node path for Accessibility setup
- **Browser**: Connect to real Chrome via CDP with profile selection, agents use real Chrome for browser tasks, base64 screenshot data in SSE events
- **SOPs**: Inject skills into agent system prompts, enrich `run_agent`, feed desktop journal into workflow mining, track skill `success_rate` via EMA, wire skills + discovered processes into orchestrator chat, decompose SOPs into granular sequences
- **Engine**: Dynamic catalog-aware model selection for agents, cost-effective models for agent tiers
- **API**: Task detail endpoints for cloud proxy

### Fixed
- Desktop: Stop false-negative Accessibility check, fix character-drop typing issue, remove stale OHWOW.app bundle creation
- Browser: Handle null activePage on CDP connect, use separate user-data-dir with symlinked profile, always pass profile directory to prevent Chrome profile picker, graceful Chrome restart preserves tabs, skip Scrapling tools when Chrome CDP is available, use Chrome binary directly on macOS
- Engine: Release desktop lock on task completion, persist desktop service across model router iterations, sync desktop activation state, SOP tasks use STRONG model, only pin agent model for explicit OpenRouter IDs, skip SOP injection for sequence sub-steps
- SOPs: Use static imports for skill compilation, force tool execution, stronger instructions to follow procedure steps, activate desktop section for desktop-tool skills, guide agent to select correct Chrome profile, distinguish real Chrome from Playwright Chromium, screenshot correct display
- Orchestrator: Enable vision, fix screenshot dedup, auto-activate browser, instruct orchestrator to use browser tools directly
- Agents: Update test to match 3-arg `executeTask` signature, force `tool_choice` for SOP enrichment
- API: Correct table names for task activity and state endpoints
- Daemon: Include cloud providers in `modelReady` status check

### Changed
- SOPs: Desktop SOPs use single task with smart prompt instead of sequences

## [0.6.9] — 2026-04-09

### Added
- feat(orchestrator): wire goal checkpoints into OpenRouter chat path
- feat(orchestrator): conversation digests and goal checkpoints
- feat(orchestrator): replace 40-message cap with token-budget-aware trimming
- feat(orchestrator): use Grok 4.20 (2M context) as orchestrator brain
- feat(orchestrator): per-iteration model selection in OpenRouter tool loop
- feat(brain): add WisdomEngine for strategic guidance from strongest model
- feat(orchestrator): 5x iteration limits, persistence-aware reflection
- feat(models): add Grok 4.20 and Grok 4.1 Fast to curated catalog
- feat(orchestrator): upgrade OpenRouter loop to full Anthropic-path intelligence
- feat(orchestrator): add circuit breaker and duplicate tool call detection
- feat(orchestrator): add dedicated OpenRouter tool loop with streaming
- feat(model-router): add streaming tool-calling to OpenRouterProvider
- feat(browser): respect browserHeadless config in HTTP API sessions

### Fixed
- fix(orchestrator): bump conversational iteration limit, add parallel tool retry
- fix(orchestrator): gate philosophical layers by context size, smart history truncation
- fix(desktop): externalize nut-js to fix __dirname crash in ESM bundle
- fix(tui): add connecting state and prevent fetch errors during daemon startup

## [0.6.8] — 2026-04-09

### Fixed
- Log and cleanup failed task executions instead of silently swallowing errors
- Pre-flight check now recognizes OpenRouter as a valid provider and marks task as failed on error
- Add 30s timeout to MCP server connections to prevent indefinite hangs
- Set execution_backend to native on DevOps preset to bypass Claude Code CLI autodetect

### Changed
- Rename useOllama to useModelRouter for clarity across the execution engine

## [0.6.7] — 2026-04-09

### Added
- Git-aware env scrubbing for bash tool (SSH_AUTH_SOCK preserved for git push)
- Auto-inject GitHub MCP server for devops-enabled agents
- DevOps system prompt for release management guidance
- DevOps agent preset with bash, files, and MCP capabilities
- Release workflow template for DevOps agent
- Per-agent config field on presets, passed through during onboarding

### Fixed
- Pass per-agent model ID to OpenRouter provider in Ollama path
- Prevent fetch to null port, guard greeting on daemon connection

## [0.6.6] — 2026-04-09

### Fixed
- QA fixes for meeting listener
- Poll daemon status until cloudConnected is true
- Simplify greeting — wait for agents to load, no health polling

## [0.6.5] — 2026-04-09

### Fixed
- Don't fallback from OpenRouter to Ollama on availability timeout

## [0.6.4] — 2026-04-09

### Added
- Proactive contextual greeting on every TUI session

### Fixed
- Skip welcome message for returning users with existing agents
- Add safety timeout for welcome loading state

## [0.6.3] — 2026-04-09

### Fixed
- Skip cloud auth when OpenRouter key is already configured

## [0.6.2] — 2026-04-09

### Fixed
- Bump basic-ftp to 5.2.1 via override (CVE-2026-39983, CRLF command injection)

## [0.6.1] — 2026-04-09

### Added
- feat: support OpenRouter in TUI model picker
- feat: include task output and react trace in cloud reports

### Fixed
- fix: skip whitespace-only thoughts in react trace

## [0.6.0] — 2026-04-09

### Added
- feat: wire meeting listener tools into orchestrator
- feat: add meeting session sync to control plane client
- feat: add MeetingSession service for live audio transcription + notes
- feat: add meeting_sessions table for local audio capture
- feat: add Swift ScreenCaptureKit audio capture helper + Node service
- feat: add cloud data query tools for orchestrator
- feat: support OpenRouter in orchestrator chat
- feat: auto-transcribe YouTube videos when URL shared in chat
- feat: add arena HTTP server and external client
- feat: add arena training loop and cross-arena skill transfer
- feat: add arena generator and body introspection
- feat: add arena reward library and difficulty scaling
- feat: add arena trajectory recording and persistence
- feat: add Arena training environment protocol

### Fixed
- fix: force-include cloud data tools in ALWAYS_INCLUDED set
- fix: make cloud data tools always available (no intent filtering)
- fix: correct OpenRouter baseURL for Anthropic SDK
- fix: arena low-priority cleanup (local)
- fix: address QA review findings for arena system

## [0.5.3] — 2026-04-09

### Added
- feat(orchestrator): code mode with dev intent, project detection, and coding protocols
- feat(tui): Claude Code-style rich tool result rendering
- feat: evolution event emission to local runtime
- feat: SavepointStore for named execution checkpoints
- feat: recursive folding with depth limit, fold-aware context budget, structured fold returns
- feat: context-folding type definitions
- feat: web research and HTTP fetch tools enabled for all agents by default
- feat: co-evolution for local runtime (CORAL-style parallel agent iteration)
- feat: evolve_task wired into local orchestrator tool system
- feat: hand gesture recognition and cloud Eye layout ported to local runtime
- feat: git context and LSP instructions wired into system prompt
- feat: LSP client core, tool handlers, recovery audit migration, preflight
- feat: GLM 5.1 added to OpenRouter curated models
- Add /desktop/remote-action endpoint for cloud orchestrator control

### Fixed
- fix: add paused column to local runtime, align with cloud schema
- fix(orchestrator): QA round 2 — detector coverage, section cap, prompt trim
- fix(tui): QA round 2 — line numbering, stream errors, dead code
- fix(tui): QA fixes for code mode tool rendering
- fix(tui): increase result budget for code tools in rich rendering
- fix: improve evolve_task tool description for better LLM selection
- fix: thread depth through recursive sub-orchestrators
- fix: auth and validation for /desktop/remote-action
- fix: hand landmark overlay using clientWidth for 1:1 canvas-to-screen mapping
- fix: address remaining LOW/MEDIUM QA audit issues
- fix: address QA audit findings (1 CRITICAL, 6 HIGH, 5 MEDIUM)

### Changed
- refactor(tui): unified diff rendering for file edits
- test(orchestrator): add dev intent test cases, update file intent tests

### Dependencies
- bump hono 4.12.9 → 4.12.12
- bump @hono/node-server 1.19.11 → 1.19.13
- bump @anthropic-ai/sdk 0.81.0 → 0.82.0
- bump vite 8.0.3 → 8.0.6
- bump @types/node 25.5.0 → 25.5.2
- bump dotenv 17.3.1 → 17.4.1

## [0.5.2] — 2026-04-07

### Added
- feat: add deliverables UI to local web dashboard
- feat: add deliverables API routes for local dashboard
- feat: add save_deliverable tool and enhance deliverables schema
- feat: add BPP state sync to cloud control plane

### Fixed
- fix: L2 approval dead code and React key anti-patterns
- fix: address QA audit findings for deliverables
- fix: always create deliverables for task outputs
- fix: remove "psychological" from BPP comments
- fix: prevent infinite voice restart loop on local Eye page

### Docs
- docs: update README with AI agent comparison section

## [0.5.1] — 2026-04-07

### Fixed
- Bump vite to 6.4.2 to resolve CVE file-read and path-traversal vulnerabilities (GHSA-p9ff-h696-f583, GHSA-4w7w-66w2-5vf9)

## [0.5.0] — 2026-04-07

### Added
- Local Eye page with voice + camera companion
- Camera presence system: presence engine, greeting assembler, eye organ, inner thoughts loop
- Presence API route with event bus wiring, endocrine hints, and narrative beats in presence signals
- speakGreeting and auto_start voice activation
- Agent genesis and promotion lifecycle (local runtime)
- Sequential multi-agent coordination engine (Phases 1–7): decomposer, abstention protocol, cost estimation, budget governance, TUI wiring, experience learning, cross-environment chains
- OpenRouter integration: live model catalog, searchable web picker, cloud provider routing, cost estimation, budget governance
- Claude Code as third model source option in onboarding and model picker
- Doc mount system: browsable documentation filesystems, RAG enrichment, per-agent declarative mounted_docs, mesh propagation
- Rewritten ClaudeCodeProvider using CLI instead of MCP sampling bridge

### Fixed
- QA round 2 fixes for local Eye
- QA issues in presence engine, greeting, and inner thoughts
- 9 bugs from QA reviews of OpenRouter integration
- QA audit findings across doc mount system

### Changed
- Curated OpenRouter model catalog mirroring cloud dashboard
- Widened model source types to include claude-code across the stack
- Updated env docs for cloudProvider, fixed model source hints

## [0.4.8] — 2026-04-06

### Added
- Audio transcription tool (`transcribe_audio`) with provider cascade: Voicebox, Gemma Audio, Whisper Local, Whisper API. Supports optional LLM analysis of the transcript
- Internet tools: `youtube_transcript` (yt-dlp), `read_rss_feed` (rss-parser), `github_search` (gh CLI). Zero-cost, zero-config
- Auto-install of yt-dlp and gh CLI on daemon startup (non-blocking, same pattern as scrapling)
- Text-to-speech tool (`generate_voice`) via Kokoro TTS with OpenAI fallback
- Google Lyria music generation and video generation via OpenRouter

### Fixed
- QA cleanup: dead code removal, fragile regex fixes, base64 MIME detection improvements

## [0.4.7] — 2026-04-06

### Added
- feat: gate filesystem/bash access behind permission-based gateway tool
- feat: device-pinned data manifest and locality control (Phase A)
- feat: secure device-to-device data fetch protocol (Phase B)
- feat: filter ephemeral device-pinned content from extraction (Phase C)
- feat: fetch approval flow and predictive pre-fetch (Phases D+E)
- feat: wire DeviceDataFetcher into runtime + shutdown cleanup
- feat: wire device-pinned memories into task execution engine
- feat: conversation persistence layer (Phase 1)
- feat: conversation memory extraction engine (Phase 2)
- feat: local-to-cloud conversation and memory sync (Phase 5)
- feat: accept config and department_id when creating agents via API

### Fixed
- fix: system prompt no longer claims filesystem tools before permission granted
- fix: QA audit fixes for device-pinned data (Phases A-E)
- fix: QA audit fixes for conversation persistence
- fix: respect agent's configured model for Ollama vs Anthropic routing
- fix: use 'pending' instead of 'queued' for task status
- fix: include README.md in npm files field for registry display

## [0.4.6] — 2026-04-05

### Added
- feat: send real device metrics to cloud (system RAM, VRAM, fleet sensing)
- feat: wire BPP modules into daemon startup (scheduler, health, bios)
- feat: soul persistence, DB migration, and cross-system connector flows
- feat: symbiosis-enriched A2A and BPP health vitals
- feat: homeostasis-gated scheduling, rate limiting, and context budget
- feat: BPP-aware model routing via brain confidence and endocrine state
- feat: complete affect/hexis feedback loop in tool dispatch
- feat: wire immune system into tool execution and error recovery
- feat: automatic periodic sync scheduling for data source connectors
- feat: budget UI controls for agent settings
- feat: org topology visualization tab reusing flow-builder renderer
- feat: synapse decay scheduler, health metric, and endocrine wiring
- feat: OpenRouter cost tracking fix and budget WebSocket events
- feat: mesh-distributed RAG for cross-device knowledge retrieval
- feat: Google Drive and Notion data source connectors
- feat: knowledge graph generation for the RAG pipeline
- feat: integrate local knowledge retrieval into deep research flow
- feat: hard budget kill switch and biological org hierarchy
- feat: GitHub and Local Files data source connectors
- feat: background document processing worker for RAG pipeline
- feat: LLM-based reranker for RAG retrieval pipeline
- feat: OpenAI-compatible LLM provider for vLLM, Together, Groq, etc.
- feat: smart text chunker with structure-aware splitting and overlap
- feat: Phase 1 RAG enhancements inspired by Onyx
- feat: provider-aware model management UX for web and TUI
- feat: resource-aware MLX model lifecycle management
- feat: integrate mlx-vlm for Gemma 4 inference on Apple Silicon

### Fixed
- fix: suppress require-yield in connector sync test (intentional throw)
- fix: resolve lint warnings in BPP integration code
- fix: address review issues in RAG pipeline
- fix: use toBeCloseTo for float comparison in endocrine test

### Changed
- chore: fix all 70 ESLint warnings across codebase

### Performance
- perf: optimize knowledge graph extraction with heuristic NER and parallel batching
- perf: batch DB operations in updateCorpusStats

### Tests
- test: add BPP hot-path integration tests

### Docs
- docs: update RAG enhancement plan to reflect completed implementation
- docs: rename and de-brand RAG enhancement plan
- docs: add Onyx analysis and enhancement plan for ohwow

### Dependencies
- chore(deps): bump @anthropic-ai/sdk from 0.80.0 to 0.81.0
- chore(deps): bump lodash from 4.17.23 to 4.18.1 in /src/web
- build(deps-dev): bump typescript-eslint from 8.57.2 to 8.58.0
- build(deps): bump express-rate-limit from 8.3.1 to 8.3.2
- build(deps): bump @modelcontextprotocol/sdk from 1.28.0 to 1.29.0

## [0.4.5] — 2026-04-03

### Added
- Native audio speech-to-text via Gemma 4 (`GemmaAudioProvider`)
- Audio task type and routing in ModelRouter
- Audio badge in model selection UI and API
- Gemma 4 models added to catalog with audio modality support

### Fixed
- Move `node-pty` to `optionalDependencies` to prevent install failures on unsupported platforms
- Read version from `package.json` instead of hardcoded string in TUI
