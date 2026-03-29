# Brain — Cognitive Architecture

**Layer 1: How agents think.**

The Brain is the unified cognitive coordinator. It replaces "call LLM in a loop" with a genuine cognitive cycle: perceive → deliberate → act. Every philosophical concept is load-bearing architecture.

## Modules

| Module | Philosophy | What it does |
|--------|-----------|-------------|
| `experience-stream.ts` | Whitehead (Process) | Append-only ring buffer. Everything is an experience. The single source of truth for all brain modules. |
| `predictive-engine.ts` | Friston (Free Energy) | Predicts tool outcomes before execution. Learns from prediction errors. Subsumes stagnation detection. |
| `intentionality.ts` | Husserl (Phenomenology) | Enriches intent with horizons: what the user probably needs next, what's implied, what's uncertain. |
| `temporal-frame.ts` | Heidegger (Temporality) | Retention (just-past), impression (now), protention (anticipated future). Temporal reflection. |
| `tool-embodiment.ts` | Merleau-Ponty (Embodiment) | Mastered tools get compressed descriptions (saves 200-500 tokens). Tool sequence patterns. |
| `dialectic.ts` | Hegel (Dialectic) | Counter-argument for complex plans. Catches wrong-direction errors before execution. |
| `global-workspace.ts` | Baars (Consciousness) | Salience-filtered event bus. Specialist processors compete for attention. |
| `self-model.ts` | Kant (Apperception) | Self-awareness: model capabilities, confidence, limitations, tool proficiency. |
| `brain.ts` | All of the above | The coordinator. perceive() → deliberate() → act helpers. |

## The Cognitive Cycle

```
perceive(stimulus, classified, selfModelDeps)
  → Perception { intent with horizons, temporal frame, self-model }

deliberate(perception, planDescription?, stepCount?)
  → Plan { actions, prediction, counter-argument, confidence }

act: recordToolExecution() + isStagnating() + buildReflection()
  → experience stream entries, tool proficiency updates
```

This is the **primary execution path** in the orchestrator and engine. Not an add-on.
