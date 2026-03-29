# Work — Purpose Layer

**Layer 3: Why agents act.**

Tasks, goals, and projects exist as database rows. The Work layer gives them philosophical depth. Different kinds of work succeed differently. Different growth stages need different priorities. The workspace has a purpose, and every task should serve it.

## Modules

| Module | Philosophy | What it does |
|--------|-----------|-------------|
| `telos.ts` | Aristotle (Final Cause) | Derives workspace purpose from growth stage + goals + founder focus |
| `ergon.ts` | Aristotle (Proper Function) | Classifies work as theoria (research), poiesis (creation), or praxis (action) |
| `phronesis.ts` | Aristotle (Practical Wisdom) | Growth-stage-aware allocation. 10 stages, 3 work kinds, anti-patterns |
| `kairos.ts` | Greek (Opportune Moment) | Temporal urgency for proactive signals. Decay rates. Time windows |
| `dynamis.ts` | Aristotle (Potential) | Capacity modeling: agents and humans. Overloaded/balanced/idle |
| `eudaimonia.ts` | Aristotle (Flourishing) | Composite 0-100 workspace health score. Six weighted dimensions |
| `synergeia.ts` | Aristotle (Working Together) | Human-agent collaboration patterns. Effectiveness. Recommendations |

## Work Kinds (Ergon)

| Kind | Greek | Examples | Success criteria |
|------|-------|----------|-----------------|
| Theoria | Contemplation | Research, analysis, reporting | Insight depth, source diversity |
| Poiesis | Production | Content, code, designs | Artifact quality, completeness |
| Praxis | Action | Sales, outreach, hiring | World state changed, deal closed |

## Growth Stage Wisdom (Phronesis)

Each of the 10 growth stages (Explore → Compound) has recommended work allocation and anti-patterns. Example: Stage 1 (Launch) recommends 55% praxis, 30% poiesis, 15% theoria with the anti-pattern "Don't build more features, sell what you have."

## Eudaimonia Score

A single number that captures workspace flourishing:
- Goal Velocity (20%): are goals progressing?
- Agent Efficiency (15%): success rate, cost
- Team Growth (15%): are people balanced and improving?
- Business Health (20%): MRR trend
- System Health (10%): Noosphere health
- Purpose Alignment (20%): are tasks serving the telos?

All modules are pure functions. No LLM calls. <5ms each.
