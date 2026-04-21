Generational wealth starts with systems that can outlast you. Not just the assets, the logic behind them. The way you see each problem, the standards you refuse to lower, the judgment that grows and protects the money. Wealth transfers while the intelligence behind it usually doesn't.

---

## What it is

Ohwow orchestrates an AI agents workforce around your actual goals. It runs as a persistent daemon on your machine, builds a SQLite record of your context, and stays local by default.

It doesn't run in the cloud by default. Your data, your models, your business logic live on your hardware. Cloud sync and a web dashboard exist and are additive. The system is whole without them.

Out of the box: browser automation over Chrome DevTools Protocol, voice input and output, outreach across X, WhatsApp, Telegram, and Threads, video generation, document processing, and a scheduling engine that runs while you sleep. Multiple workspaces run in parallel, one per business, each with its own daemon, database, and agent workforce.

The runtime upgrades itself. A model intelligence loop monitors new releases, runs induction probes against live tasks, and promotes better models into the execution pool without manual intervention.

---

## How it thinks

Most AI agents are stateless request-handlers. You send a message, they respond, the context evaporates. ohwow builds a cognitive operating system instead.

Seven layers, each grounded in a philosophical tradition:

- **Brain** (Husserl, Friston, Heidegger): perceive, deliberate, act. Predictive coding drives tool outcome estimation. Intentionality structures the horizon of a task. Temporal framing keeps past and future present in every decision.
- **Body** (Merleau-Ponty, von Uexküll): browser, desktop, voice, and messaging channels treated as organs. The agent knows what it can reach and what it can do with each limb.
- **Work** (Aristotle): purpose derived from growth stage and goals. Telos (what is this agent for), ergon (what kind of work is this), kairos (when is the right moment), eudaimonia (is this contributing to flourishing).
- **Mesh** (Leibniz, Hegel, Spinoza): consciousness propagation across peers. Distributed body aggregation. Self-healing failover.
- **Soul** (Plato, Jung, Heraclitus): identity across time. Values, shadow, growth arc. Agents don't reset between sessions.
- **Symbiosis** (Philia, Li): trust dynamics, handoff intelligence, mutual adaptation between agent and operator.
- **BIOS** (Wu Wei, Karuna): biological awareness. Energy, stress, recovery. The system notices when the human needs rest.

All seven layers run locally. The runtime doesn't infer your values from your API calls. It accumulates them.

---

## Eternal Systems

This is the part that makes ohwow different from every other AI agent framework.

Most systems assume their operator is present. ohwow doesn't.

The Eternal module encodes an inactivity protocol and a values corpus. If the operator goes dark, the system transitions through defined modes: normal, conservative, estate. In conservative mode, autonomous work pauses and a trustee is notified. In estate mode, designated successors receive operational control.

An escalation map governs what the system can decide alone. Routine outreach runs autonomously. Large expenses and strategic decisions route to trustee approval. The operator configures the thresholds. The runtime enforces them without exception.

The values corpus is a document the runtime reads at boot. It holds the operator's standards, the reasoning behind decisions they've already made, the judgment accumulated over years. When the system acts on their behalf, it acts from that document.

```bash
ohwow eternal init
```

Intelligence doesn't usually transfer with wealth. ohwow is an attempt to change that.

---

## Get started

```bash
npm install -g ohwow
ohwow start
```

The onboarding wizard runs on first start. It takes about five minutes. After that, the daemon runs in the background and the terminal dashboard is available at any time via `ohwow`.

To contribute: read [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, DCO sign-off requirements, and the PR process. Good starting points are tests for existing modules, browser automation fixes in `src/browser/`, and documentation.

The cloud dashboard lives at [ohwow.fun](https://ohwow.fun). It's optional.
