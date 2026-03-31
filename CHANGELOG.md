# Changelog

All notable changes to this project will be documented in this file.

## [0.4.2] — 2026-03-31

### Added
- Zero-config voice mode with automatic tier detection: browser-native (Web Speech API) as instant fallback, Voicebox auto-start when Python is available
- Browser-native STT/TTS via Web Speech API for zero-install voice
- Auto-start Voicebox on daemon boot if Python is detected
- `/api/voice/providers` now returns `recommendedMode` for client auto-detection

## [0.4.1] — 2026-03-31

### Added
- feat(web): add Tier Choice and Integration Setup to web onboarding
- feat(tui): add experience choice gate for terminal vs web onboarding
- feat(web): add Phase 3 pages for existing backend capabilities
- feat(web): add weekly calendar view to schedules page
- feat(web): add kanban board view to project detail page
- feat(web): add Activity and Performance tabs to agent detail page
- feat(web): add timeline, richer metadata, and collapsible sections to task detail
- feat(web): show tool calls in chat stream with expandable chips
- feat(dashboard): add task activity chart and quick stats row
- feat(web): add Phase 1 pages and enrich existing UI

### Fixed
- fix(web): replace Webhook icon with Plug (not in phosphor-icons)

### Changed
- chore(web): update package-lock.json peer dependency flags

## [0.4.0] — 2026-03-31

### Added
- feat: add TUI toggle, unit tests, and heartbeat coordinator
- feat(execution): add Claude Code CLI as full-delegation task executor
- feat(turboquant): TUI status display, model badges, crash watchdog, API endpoint
- feat(body): wire MCP organ + conscious signal warnings into local runtime
- feat(turboquant): add capability detection, gate context inflation on confirmed compression
- feat(body): wire dynamic organs and inject proprioception into system prompt
- feat(body): bootstrap DigitalBody into local runtime lifecycle
- feat(inference): add LlamaCppProvider for TurboQuant KV cache compression
- feat(body): add VoiceOrgan and auditory nervous signals
- feat(voice): wire VoiceSession into Brain experience stream
- feat(brain): add voice as first-class auditory modality in cognitive architecture
- feat(turboquant): enable 4-bit KV cache compression by default
- feat(model-mgmt): add TurboQuant KV cache compression algorithms
- feat(voice): integrate Microsoft VibeVoice open-source voice AI models

### Fixed
- fix(deps): resolve Dependabot security alerts for langsmith, file-type, picomatch
- fix(test): mock process.platform in safety-guard tests for CI
- fix(ci): add .npmrc with legacy-peer-deps and regenerate lockfile
- fix(ci): upgrade npm in CI and regenerate lockfile
- fix(ci): regenerate package-lock.json to match package.json
- fix(body): close 5 local embodiment gaps
- fix(turboquant): shutdown leak, model switch restart, binary auto-download

### Changed
- docs: expand README intro with cognitive architecture, embodiment, and mesh
- ci: fix npm ci sync and bump actions/checkout to v6
- test(voice): add VibeVoice provider and service manager tests

## [0.2.0] - 2026-03-15

### Added
- Initial open-source release
- 48 pre-built AI agents across 6 business types
- 150+ orchestrator tools
- Built-in CRM with contacts, pipeline, and events
- WhatsApp and Telegram messaging integration
- Browser automation via Playwright
- Voice I/O (STT + TTS)
- Multi-device mesh networking with auto-discovery
- MCP client and server support
- A2A protocol (Google Agent-to-Agent)
- DAG-based workflow engine
- Webhook automation triggers
- Cron scheduling with proactive engine
- Local web dashboard at localhost:7700
- Terminal UI with chat, agents, tasks, CRM tabs
- Code sandbox (isolated JS execution)
- Agent memory with RAG-based retrieval
- Goal planning with approval workflows
- Connected mode for ohwow.fun cloud features
