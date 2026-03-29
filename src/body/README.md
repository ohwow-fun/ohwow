# Body — Embodiment Layer

**Layer 2: How agents interact with the world.**

Agents have bodies, not just tools. A browser session is an eye. A WhatsApp connection is a voice. A temperature sensor is touch. The Body formalizes these as organs with health, affordances, and proprioception.

## Modules

| Module | Philosophy | What it does |
|--------|-----------|-------------|
| `digital-body.ts` | Merleau-Ponty | Wraps existing services (browser, desktop, channels, MCP) as organs |
| `physical-body.ts` | Enactivism (Varela) | Hardware connection manager. Each device is an organ with sensors + actuators |
| `digital-nervous-system.ts` | Cybernetics (Wiener) | Background monitoring per organ. Reflex rules. Health change detection |
| `physical-nervous-system.ts` | Cybernetics | Sensor polling, PID controllers, safety reflexes (<10ms) |
| `nervous-system.ts` | Spinoza (Parallelism) | Unified integrator. Cross-domain affordances. Brain bridge |

## Connection Backends (`connections/`)

| Backend | Package | Use case |
|---------|---------|----------|
| `serial-backend.ts` | `serialport` | Arduino/ESP32 via USB |
| `mqtt-backend.ts` | `mqtt` | WiFi IoT devices via Mosquitto |
| `http-backend.ts` | built-in fetch | ESP32 HTTP servers, REST devices |

## Speed Hierarchy

| Layer | Speed | Examples |
|-------|-------|---------|
| Physical Reflex | <10ms | Emergency stop, thermal protection |
| PID Controller | 50ms | Temperature regulation, motor speed |
| Digital NS | 100ms-60s | Connection monitoring, health checks |
| Brain Integration | 1-30s | Conscious decisions about sensor data |

## Cross-Domain Affordances

Physical + digital capabilities combine:
- Temperature sensor + calendar API → smart climate control
- Motion sensor + messaging → presence-based notifications
- Camera + analysis tools → visual perception
