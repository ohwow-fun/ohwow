# Changelog

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
