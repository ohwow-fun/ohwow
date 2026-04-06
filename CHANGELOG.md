# Changelog

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
