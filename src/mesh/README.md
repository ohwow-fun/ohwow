# Mesh — Distributed Being

**Layer 4: How devices form one organism.**

Multiple ohwow instances across your devices form a distributed organism. Each device is a Leibnizian monad: self-contained yet reflecting the collective. Consciousness propagates. Bodies aggregate. Routing uses experience. The mesh heals itself.

## Modules

| Module | Philosophy | What it does |
|--------|-----------|-------------|
| `mesh-noosphere.ts` | Hegel (Geist) | Consciousness propagation across peers. Push + pull. Salience gating |
| `mesh-body.ts` | Merleau-Ponty (Intercorporeality) | Aggregate body snapshots from all peers. Cross-device affordances |
| `mesh-router.ts` | Aristotle (Synergeia) | Brain-informed routing: tool mastery, work-kind affinity, prediction accuracy |
| `mesh-resilience.ts` | Spinoza (Substance) | Heartbeat failure detection. Automatic secondary promotion. Connection transfer |

## Consciousness Propagation Protocol

1. Local GlobalWorkspace broadcast with salience >= 0.5
2. Wrap as MeshConsciousnessItem (meshId for dedup, 5-min TTL, max 2 hops)
3. Push to all connected peers via POST /api/mesh/broadcast
4. Receiver: dedup → hop check → TTL check → inject into local workspace
5. No re-propagation (originator fans out, prevents storms)
6. Pull fallback during 30s health checks catches missed items

## Brain-Informed Routing

Extends hardware-only peer scoring with four dimensions:

| Dimension | Weight | Signal |
|-----------|--------|--------|
| Tool Mastery | +15 | Device has mastered the required tool |
| Work Kind Affinity | +10 | Device excels at this type of work |
| Prediction Accuracy | +5 | Device's brain is well-calibrated |
| Completion Rate | +5 | Device reliably completes tasks |

Backward compatible: 0 score when no brain profile exists.

## Self-Healing

- Primary sends heartbeat every 10 seconds
- If no heartbeat for 30 seconds: primary considered failed
- Remaining peers compute new primary (deterministic MAC election)
- Connection ownership transfers automatically
- Failed device can rejoin and reclaim primary if it has lowest MAC
