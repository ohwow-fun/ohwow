# Architecture

## Overview

ohwow is a local-first AI cognitive operating system built on a seven-layer philosophical architecture. Each layer addresses a distinct dimension of intelligence: how agents think (Brain), how they interact with the world (Body), why they act (Work), how they form collective organisms (Mesh), who they are (Soul), how they collaborate with humans (Symbiosis), and how they respect biological rhythms (BIOS). All layers run on your machine with a local SQLite database. Cloud features are optional and additive.

## The Seven Layers

```
┌──────────────────────────────────────────────────────────────┐
│ Layer 7: BIOS — Biological Awareness (Wu Wei, Karuna)        │
│   Energy waves. Stress detection. Recovery. Boundaries.      │
│   Notification filtering. Compassion for the biological.     │
├──────────────────────────────────────────────────────────────┤
│ Layer 6: SYMBIOSIS — Collaboration (Philia, Li)              │
│   Trust dynamics. Handoff intelligence. Collaboration rhythm.│
│   Mutual learning. Adaptive partnership.                     │
├──────────────────────────────────────────────────────────────┤
│ Layer 5: SOUL — Identity (Plato, Jung, Heraclitus)           │
│   Tripartite balance. Values. Shadow (blind spots). Growth.  │
│   Agent soul. Human soul. Relationship soul.                 │
│   + PERSONA: Chrono-biology. Cognitive load. Comm style.     │
├──────────────────────────────────────────────────────────────┤
│ Layer 4: MESH — Distributed Being (Leibniz, Hegel, Spinoza) │
│   Consciousness propagation. Shared body. Brain routing.     │
│   Self-healing failover.                                     │
├──────────────────────────────────────────────────────────────┤
│ Layer 3: WORK — Purposeful Action (Aristotle)                │
│   Telos. Ergon. Phronesis. Kairos. Dynamis. Eudaimonia.     │
├──────────────────────────────────────────────────────────────┤
│ Layer 2: BODY — Embodiment (Merleau-Ponty, von Uexküll)     │
│   Digital + physical organs. Nervous systems. Affordances.   │
├──────────────────────────────────────────────────────────────┤
│ Layer 1: BRAIN — Cognition (Husserl, Friston, Heidegger)    │
│   perceive → deliberate → act. Prediction. Reflection.      │
│   Tool mastery. Dialectic. Global workspace.                 │
├──────────────────────────────────────────────────────────────┤
│ Layer 0: RUNTIME — Infrastructure                            │
│   Orchestrator. Engine. Tools. DB. API. Scheduling.          │
│   Messaging. Browser. Desktop. MCP. A2A.                     │
└──────────────────────────────────────────────────────────────┘
```

## System Flow

```
CLI Entry (src/index.ts)
  │
  ├── TUI (terminal dashboard)
  │     └── React/Ink app (src/tui/)
  │
  └── Daemon (src/daemon/)
        │
        ├── Brain (src/brain/)
        │     ├── ExperienceStream — append-only event log (Whitehead)
        │     ├── PredictiveEngine — tool outcome prediction (Friston)
        │     ├── Intentionality — enriched intent with horizons (Husserl)
        │     ├── TemporalFrame — retention/impression/protention (Heidegger)
        │     ├── ToolEmbodiment — mastery-aware descriptions (Merleau-Ponty)
        │     ├── Dialectic — counter-argument for complex plans (Hegel)
        │     ├── GlobalWorkspace — consciousness bus (Baars)
        │     └── Brain — unified perceive→deliberate→act coordinator
        │
        ├── Body (src/body/)
        │     ├── DigitalBody — browser, desktop, channels, MCP as organs
        │     ├── PhysicalBody — serial, MQTT, HTTP, WebSocket, GPIO
        │     ├── DigitalNervousSystem — background monitoring (100ms-60s)
        │     ├── PhysicalNervousSystem — sensor loops, PID, reflexes (<10ms)
        │     └── NervousSystem — unified cross-domain affordances
        │
        ├── Work (src/work/)
        │     ├── Telos — purpose derivation from growth stage + goals
        │     ├── Ergon — work classification (theoria/poiesis/praxis)
        │     ├── Phronesis — growth-stage-aware allocation table
        │     ├── Kairos — temporal opportunity detection
        │     ├── Dynamis — capacity modeling (potential vs actual)
        │     ├── Eudaimonia — composite flourishing score (0-100)
        │     └── Synergeia — human-agent collaboration patterns
        │
        ├── Mesh (src/mesh/)
        │     ├── MeshNoosphere — consciousness propagation across peers
        │     ├── MeshBody — distributed body aggregation
        │     ├── MeshRouter — brain-informed peer scoring
        │     └── MeshResilience — heartbeat failure detection + auto-promotion
        │
        ├── Soul (src/soul/)
        │     ├── AgentSoul — tripartite, values, shadow, growth, identity
        │     ├── HumanSoul — revealed values, leadership style, value gaps
        │     ├── RelationshipSoul — bond, mutual adaptation, shared context
        │     ├── Shadow — universal blind spot detection (Jung)
        │     └── GrowthArc — longitudinal identity tracking (Heraclitus)
        │
        ├── Persona (src/persona/)
        │     ├── ChronoBio — circadian rhythm detection
        │     ├── CognitiveLoad — real-time capacity estimation
        │     ├── Communication — style inference from patterns
        │     └── PersonaObserver — behavioral observation engine
        │
        ├── Symbiosis (src/symbiosis/)
        │     ├── TrustDynamics — domain-specific trust evolution
        │     ├── HandoffIntelligence — when to hand off vs act autonomously
        │     ├── CollaborationRhythm — optimal pattern detection
        │     └── MutualLearning — bidirectional teaching tracking
        │
        ├── BIOS (src/bios/)
        │     ├── EnergyWave — ultradian rhythm detection
        │     ├── StressDetector — behavioral stress signals
        │     ├── RecoveryAdvisor — post-sprint recovery
        │     ├── BoundaryGuardian — work-life boundary learning
        │     └── NotificationFilter — bio-aware notification timing
        │
        ├── Orchestrator (src/orchestrator/)
        │     └── 150+ tools, cognitive cycle as primary path
        │
        ├── Execution Engine (src/execution/)
        │     └── Model Router → Ollama / Claude / OpenRouter
        │
        ├── Peers (src/peers/)
        │     └── mDNS discovery, task routing, leader election
        │
        ├── Messaging (src/whatsapp/, src/integrations/)
        │     └── WhatsApp (Baileys), Telegram
        │
        ├── Scheduler (src/scheduling/)
        │     └── Cron-based agent and workflow triggers
        │
        └── Control Plane (src/control-plane/)
              └── Optional cloud sync with ohwow.fun
```

## Module Map

### Philosophical Layers

| Directory | Philosophy | What it does |
|-----------|-----------|-------------|
| `src/brain/` | Husserl, Friston, Heidegger, Hegel, Baars, Whitehead, Kant | Cognitive coordinator: experience stream, predictive engine, intentionality, temporal frame, tool embodiment, dialectic, global workspace |
| `src/body/` | Merleau-Ponty, von Uexküll, Wiener, Gibson | Digital + physical embodiment: organs, affordances, nervous systems, PID controllers, safety reflexes |
| `src/work/` | Aristotle (Nicomachean Ethics, Metaphysics, Politics) | Purpose-driven execution: telos, ergon, phronesis, kairos, dynamis, eudaimonia, synergeia |
| `src/mesh/` | Leibniz, Hegel, Spinoza | Distributed being: consciousness propagation, shared body, brain-informed routing, self-healing |
| `src/soul/` | Plato (Tripartite), Jung (Shadow), Heraclitus (Flux) | Identity layer: agent soul, human soul, relationship soul, shadow detection, growth arc |
| `src/persona/` | Aristotle (Psyche), Levinas (Other) | Behavioral profiling: chronobiology, cognitive load, communication style, persona observation |
| `src/symbiosis/` | Aristotle (Philia), Confucius (Li) | Collaboration intelligence: trust dynamics, handoff intelligence, collaboration rhythm, mutual learning |
| `src/bios/` | Laozi (Wu Wei), Buddha (Karuna) | Biological awareness: energy waves, stress detection, recovery, boundary guardian, notification filter |

### Runtime Infrastructure

| Directory | What it does |
|-----------|-------------|
| `src/a2a/` | Agent-to-Agent protocol (JSON-RPC 2.0, trust levels, agent cards) |
| `src/api/` | Express HTTP server, REST routes, WebSocket handler |
| `src/browser/` | Playwright browser automation |
| `src/control-plane/` | Cloud connection to ohwow.fun |
| `src/daemon/` | Process daemonization, lifecycle management |
| `src/db/` | SQLite adapter, query builder, schema migrations |
| `src/execution/` | Agent task execution engine, model router |
| `src/integrations/` | Telegram bot, external service connectors |
| `src/lib/` | Shared utilities: logger, RAG, self-improvement, telemetry |
| `src/mcp/` | MCP client (consume external tools) |
| `src/mcp-server/` | MCP server (expose ohwow tools to Claude Code) |
| `src/orchestrator/` | Conversational AI orchestrator with 150+ tools |
| `src/peers/` | Multidevice mesh: mDNS discovery, leader election, task routing |
| `src/scheduling/` | Cron-based schedule management |
| `src/triggers/` | Webhook triggers, event evaluation |
| `src/tui/` | Terminal UI (React/Ink) |
| `src/web/` | Web UI (React/Vite) |
| `src/whatsapp/` | WhatsApp integration via Baileys |

## Key Data Flows

### The Cognitive Cycle (Primary Execution Path)

```
User message arrives
  │
  ├── PERCEIVE (Brain)
  │     Stimulus → ClassifiedIntent → EnrichedIntent with horizons
  │     + TemporalFrame (retention, impression, protention)
  │     + SelfModel (confidence, capabilities, limitations)
  │     = Perception
  │
  ├── DELIBERATE (Brain, for complex tasks)
  │     Perception → Dialectic counter-argument check
  │     + Work ontology alignment (telos, phronesis)
  │     = Plan with confidence score
  │
  ├── ACT (Orchestrator tool loop)
  │     For each iteration:
  │       Claude/Ollama generates tool calls
  │       For each tool: predict → execute → record → learn
  │       Check stagnation (semantic, not just hash)
  │       Temporal reflection between iterations
  │     = Response + experience stream entries
  │
  └── LEARN (Brain)
        Extract patterns from execution
        Publish to Global Workspace
        Flush experience stream for persistence
```

### Physical Body Data Flow

```
ESP32 sensor reading
  → Connection backend (serial/MQTT/HTTP)
  → PhysicalBody (device as organ)
  → PhysicalNervousSystem
  │   ├── Safety reflexes (<10ms): threshold checks
  │   ├── PID controllers (50ms): feedback loops
  │   └── Sensor data events
  → ExperienceStream (body_sensation)
  → GlobalWorkspace (if salient)
  → MeshNoosphere (propagate to peers, if salient enough)
```

### Mesh Consciousness Propagation

```
Device A discovers insight (tool failure pattern, etc.)
  → GlobalWorkspace.broadcast() [local, salience >= 0.5]
  → MeshNoosphere wraps as MeshConsciousnessItem
  │   meshId = hash(origin + content + timestamp)
  │   TTL = 5 minutes, maxHops = 2
  → Push to peers via POST /api/mesh/broadcast
  │
Device B receives:
  → Dedup check (seenSet) → Hop check → TTL check
  → Inject into local GlobalWorkspace
  → Brain's attention mechanism selects for conscious processing
  → Agent benefits from Device A's discovery without repeating the failure
```

### Work Ontology Flow

```
Task created
  → Ergon classifies work kind (theoria / poiesis / praxis)
  → Telos checks alignment with workspace purpose
  → Phronesis scores appropriateness for current growth stage
  → OrchestratorBrain.assess() combines all signals
  → System prompt injected with work guidance
  → Agent executes with type-aware evaluation criteria
  → Eudaimonia score updated from outcomes
```

## Speed Hierarchy

| Layer | Timescale | What runs |
|-------|-----------|-----------|
| Physical Reflex | <10ms | Safety stops, threshold responses |
| Digital Reflex | <10ms | Kill switch, crash recovery |
| Physical NS | 10-100ms | Sensor polling, PID controllers |
| Digital NS | 100ms-60s | Organ health monitoring |
| Unified NS | 1-5s | Proprioception, affordance computation |
| Brain | 1-30s | perceive → deliberate → act |
| Mesh | 10-30s | Consciousness propagation, health checks |
| Noosphere | minutes-days | Cross-agent learning, insight persistence |

## Database

SQLite via `better-sqlite3`. Key tables:

| Table | Purpose |
|-------|---------|
| `agents` | Agent configs, system prompts, stats |
| `tasks` | Task history (input, output, status, truth score) |
| `agent_memories` | RAG-indexed facts, skills, feedback |
| `contacts` / `contact_events` | CRM pipeline |
| `schedules` | Cron schedules for agents/workflows |
| `workflows` / `workflow_runs` | Automation DAGs |
| `projects` / `project_tasks` | Kanban boards |
| `workspace_peers` | Mesh peer registry |
| `self_improvement_logs` | Experience stream persistence |

## Configuration

Config file: `~/.ohwow/config.json`

Key fields: `licenseKey`, `ollamaUrl`, `ollamaModel`, `anthropicApiKey`, `preferLocalModel`, `port`, `workspaceGroup`, `deviceRole`

See `.env.example` for environment variable overrides.
