Generational wealth starts with systems that can outlast you. Not just the assets, the logic behind them. The way you see each problem, the standards you refuse to lower, the judgment that grows and protects the money. Wealth transfers while the intelligence behind it usually doesn't.

---

## What it is

Ohwow orchestrates an AI agents workforce around your actual goals. It runs as a daemon on your machine and stays local by default. Your data and business logic live on your hardware. Cloud sync and a web dashboard are available but optional.

Out of the box it handles browser automation, voice, outreach across X, WhatsApp, Telegram, and Threads, video generation, and document processing. Multiple businesses run in parallel, each with their own agents, database, and schedule.

It also watches for better AI models, tests them against your real tasks, and upgrades itself automatically.

---

## How it thinks

Most AI agents forget everything between sessions. ohwow keeps context: what you've done, what worked, what your goals are, and what your standards are. Agents build on that over time instead of starting from scratch every time.

The system is built in layers. The brain layer handles reasoning and prediction. The body layer covers everything it can interact with: browser, desktop, voice, messaging. The work layer keeps agents focused on what actually matters at your current stage. The soul layer holds values and identity so agents behave consistently even when you're not watching.

All of it runs locally. The system doesn't learn who you are from your API usage. It learns from working with you directly.

---

## Eternal Systems

Most AI tools assume you're always there to supervise. ohwow is built for the opposite.

You configure a values document and an inactivity protocol. If you go silent for too long, the system shifts to conservative mode: autonomous work pauses and a trustee gets notified. Go longer and it moves to estate mode, where designated people take over.

You also set an escalation map: what the system can decide on its own, what needs your approval, and what requires a trustee sign-off. Routine work runs without interruption. Bigger decisions wait.

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

The onboarding wizard runs on first start and takes about five minutes. After that the daemon runs in the background and the terminal dashboard is available any time via `ohwow`.

To contribute, read [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, DCO requirements, and the PR process. Good starting points are tests for existing modules and bug fixes in `src/browser/`.

The cloud dashboard is at [ohwow.fun](https://ohwow.fun).
