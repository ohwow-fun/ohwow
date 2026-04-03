# Changelog

## [0.4.5] — 2026-04-03

### Added
- Native audio speech-to-text via Gemma 4 (`GemmaAudioProvider`)
- Audio task type and routing in ModelRouter
- Audio badge in model selection UI and API
- Gemma 4 models added to catalog with audio modality support

### Fixed
- Move `node-pty` to `optionalDependencies` to prevent install failures on unsupported platforms
- Read version from `package.json` instead of hardcoded string in TUI
