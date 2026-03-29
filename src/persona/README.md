# Persona — Behavioral Profiling

**Layer 5a: How agents and humans are RIGHT NOW.**

The Persona observes behavioral patterns in real-time: when does this person work best? How loaded are they? How do they prefer to communicate? This is temperament, not identity (that's Soul).

## Modules

| Module | What it observes |
|--------|-----------------|
| `chrono-bio.ts` | Circadian rhythm from action timestamps. Peak hours, low hours, work start/end. |
| `cognitive-load.ts` | Real-time capacity from open approvals + tasks + recent decisions. |
| `communication.ts` | Style inference: brief/moderate/detailed, fast/deliberate/cautious. |
| `persona-observer.ts` | Behavioral observation engine with persistence adapter. |
| `soul.ts` | Unified coordinator with `buildPromptContext()`. |

## How It Learns

The system learns by watching, not asking. Every user message, approval, rejection, and briefing read is an observation. The persona model improves over days.

## Integration

Persona context is injected into agent system prompts: "The human is currently at peak energy. Cognitive load: moderate. They prefer brief communication."
