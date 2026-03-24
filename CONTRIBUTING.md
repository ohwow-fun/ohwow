# Contributing to ohwow

Thanks for wanting to contribute. Whether it's a bug fix, a new agent template, or a feature, we appreciate the help.

## Getting Set Up

### Prerequisites

- Node.js 20+
- npm
- C++ build tools for native modules (`better-sqlite3`):
  - **macOS**: `xcode-select --install`
  - **Linux**: `sudo apt install build-essential python3`
  - **Windows**: Visual Studio C++ Build Tools (`winget install Microsoft.VisualStudio.2022.BuildTools`)
- [Ollama](https://ollama.com) (optional, for testing with local models)
- Anthropic API key (optional, for testing with Claude)

### Tech Stack

| Technology | Purpose |
|---|---|
| TypeScript | Language (ESM, strict mode) |
| tsup | Build tool (bundles to dist/) |
| Vitest | Test framework |
| Ink (React) | Terminal UI |
| Vite + React | Web dashboard |
| Zustand | State management (TUI + Web) |
| Pino | Structured logging |
| better-sqlite3 | Local database |
| Playwright | Browser automation |

### Clone and Build

```bash
git clone https://github.com/ohwow-fun/ohwow.git
cd ohwow
npm install
npm run build
```

### Run Locally

```bash
# Development mode (with hot reload via tsx)
npm run dev

# Or run the built version
npm start
```

### Run the Web UI Dev Server

```bash
npm run dev:web
```

This starts the Vite dev server on port 7701 with hot module replacement.

### Run Tests

```bash
npm test          # Run all tests once
npm run test:watch  # Watch mode
```

### Type Check

```bash
npx tsc --noEmit
```

## Making Changes

### Branch Naming

Use descriptive branch names: `fix/memory-consolidation`, `feat/new-agent-template`, `docs/architecture`.

### Code Style

- TypeScript, ESM modules throughout
- Use `logger` from `src/lib/logger.ts` for all logging. Never use `console.log`, `console.error`, or `console.warn`
- Zustand for state management (TUI and Web UI)
- When selecting from Zustand stores, never return new references from selectors (no `.filter()`, `.map()`, `|| []` inside selectors). Derive with `useMemo` instead

### Before Submitting

Run both of these and fix any errors:

```bash
npx tsc --noEmit
npm test
```

### Commit Messages

Write descriptive commit messages that explain *why*, not just *what*. All commits must include a DCO sign-off:

```bash
git commit -s -m "fix: agent memory extraction skips empty tasks"
```

The `-s` flag adds `Signed-off-by: Your Name <your@email.com>` automatically. This is required for all contributions.

### Pull Request Process

1. Fork the repo and create a branch
2. Make your changes
3. Run `npx tsc --noEmit && npm test`
4. Commit with DCO sign-off (`git commit -s`)
5. Open a PR against `main`
6. Fill out the PR template

We review PRs as quickly as we can. Small, focused PRs are easier to review and merge.

## Where to Start

Check the [good first issue](https://github.com/ohwow-fun/ohwow/labels/good%20first%20issue) label for tasks that are approachable for new contributors.

### Adding an Agent Template

Agent presets live in `src/tui/data/agent-presets.ts`. Each preset includes a name, role, system prompt, and business type. To add one:

1. Open `src/tui/data/agent-presets.ts`
2. Add your preset to the appropriate business type array
3. Include a descriptive system prompt that explains the agent's role, tone, and focus areas
4. Open a PR with the `agent-template` label

### Project Structure

See [ARCHITECTURE.md](./ARCHITECTURE.md) for a map of the codebase and how the modules connect.

## AI-Assisted Contributions

We welcome AI-assisted contributions. If you use an AI tool (Claude, Copilot, etc.) to write code, you are still responsible for reviewing and testing it. The DCO sign-off certifies that you have the right to submit the code regardless of how it was generated. AI co-author attributions (e.g., `Co-Authored-By:`) are welcome but not required.

## Developer Certificate of Origin (DCO)

By contributing, you certify that you wrote the code or have the right to submit it under the MIT license. We use the [DCO](https://developercertificate.org/) to track this. Every commit must include a `Signed-off-by` line (use `git commit -s`).

## Questions?

Open a [discussion](https://github.com/ohwow-fun/ohwow/discussions) or reach out at ogsus@ohwow.fun.
