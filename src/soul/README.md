# Soul — Identity Layer

**Layer 5b: Who agents and humans ARE.**

The Soul is what makes an entity THIS entity and not any other. Not behavioral profiling (that's Persona). Identity. Values. Blind spots. Growth.

Both agents and humans have souls. The relationship between them has a soul too.

## Philosophy

- **Plato (Tripartite)**: every soul has reason (analytical), spirit (driven), and appetite (habitual). The balance defines character.
- **Jung (Shadow)**: what the entity can't see about itself. Blind spots detected from repeated patterns.
- **Heraclitus (Flux)**: the soul is always becoming. Growth arc tracks identity evolution over time.
- **Aristotle (De Anima)**: the soul is the form of the body — what makes this thing what it IS.

## Modules

| Module | What it computes |
|--------|-----------------|
| `agent-soul.ts` | Tripartite balance from principles + stats + tool habits. Values from positive feedback. Shadow from failures. Growth from success trends. Emerging identity sentence. |
| `human-soul.ts` | Tripartite from review patterns. Revealed vs stated values with gap detection. Leadership style. Shadow from behavioral blind spots. |
| `relationship-soul.ts` | Bond strength from trust + interaction + comfort. Mutual adaptation. Shared context unique to this pair. Health trajectory. |
| `shadow.ts` | Universal blind spot detection. Groups failures by theme. Classifies: skill gap, value mismatch, behavioral pattern, overconfidence. |
| `growth-arc.ts` | Longitudinal tracking. Direction: ascending, plateau, declining, transforming. Velocity. Transition detection. |
| `soul.ts` | TrueSoul coordinator with `buildPromptContext()` for system prompt injection. |

## Key Distinction

| Layer | Question | Timeframe |
|-------|----------|-----------|
| **Persona** (`src/persona/`) | "How is this person RIGHT NOW?" | Minutes to hours |
| **Soul** (`src/soul/`) | "Who IS this entity?" | Weeks to months |

Persona is state. Soul is identity.
