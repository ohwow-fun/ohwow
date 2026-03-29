/**
 * Body Type System — Embodiment Abstractions
 *
 * Core types for both digital and physical embodiment.
 * Every type maps to a foundational concept:
 *
 * - BodyPart (von Uexküll): an organ in the agent's functional circle
 * - Affordance (Gibson): what the environment offers the agent to do
 * - UmweltDimension (von Uexküll): a dimension of the agent's perceptual world
 * - Proprioception (Merleau-Ponty): the body's sense of itself
 * - NervousSignal (Cybernetics): signals flowing between body and brain
 * - ReflexRule (Wiener): sub-cognitive response, bypasses brain
 * - PIDConfig (Cybernetics): classic feedback loop controller
 */

// ============================================================================
// BODY PART — Generic organ abstraction (von Uexküll)
// ============================================================================

/** Health state for any body part. */
export type OrganHealth = 'healthy' | 'degraded' | 'failed' | 'dormant';

/** The domain a body part belongs to. */
export type BodyDomain = 'digital' | 'physical';

/**
 * Every body part (digital or physical) implements this.
 *
 * Von Uexküll's "functional circle": each organ has a perceptual side
 * (what it senses — the Umwelt) and an effector side (what it can do —
 * the affordances). Together they form the organ's contribution to the
 * agent's being-in-the-world.
 */
export interface BodyPart {
  /** Unique identifier. */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /** Digital or physical domain. */
  readonly domain: BodyDomain;
  /** Current health. */
  getHealth(): OrganHealth;
  /** What actions this organ enables right now (Gibson). */
  getAffordances(): Affordance[];
  /** What this organ can perceive (von Uexküll). */
  getUmwelt(): UmweltDimension[];
  /** Whether the organ is currently active. */
  isActive(): boolean;
}

// ============================================================================
// AFFORDANCE — What the environment offers (Gibson)
// ============================================================================

/** Risk tiers for safety gating. */
export type AffordanceRisk = 'none' | 'low' | 'medium' | 'high' | 'critical';

/**
 * An action the body can take right now, given its state + environment.
 *
 * Gibson: affordances are not properties of objects. They are relationships
 * between the agent's body and the environment. A door handle "affords"
 * pulling only because the agent has a hand that can grip it.
 */
export interface Affordance {
  /** What can be done (e.g., "navigate", "read_temperature", "move_servo"). */
  action: string;
  /** Which organ provides this capability. */
  organId: string;
  /** Domain. */
  domain: BodyDomain;
  /** How ready the organ is (0-1). 1 = immediately available. */
  readiness: number;
  /** Estimated execution latency in ms. */
  estimatedLatencyMs: number;
  /** Risk tier for safety. */
  risk: AffordanceRisk;
  /** Prerequisites (e.g., "browser must be active", "WiFi required"). */
  prerequisites: string[];
  /** Whether this affordance spans digital + physical domains. */
  crossDomain?: boolean;
}

// ============================================================================
// UMWELT — Subjective perceptual world (von Uexküll)
// ============================================================================

/**
 * A dimension of the agent's perceptual world.
 *
 * Von Uexküll: a tick perceives only butyric acid, warmth, and hairlessness.
 * That's its entire universe — its Umwelt. Different bodies create different
 * worlds. An agent with a temperature sensor lives in a thermal Umwelt.
 * An agent with a browser lives in a web Umwelt.
 */
export interface UmweltDimension {
  /** What is being sensed (e.g., "web_page", "temperature", "screen_state"). */
  modality: string;
  /** The organ doing the sensing. */
  organId: string;
  /** Current value. */
  currentValue: unknown;
  /** When this was last updated. */
  lastUpdated: number;
  /** How often the nervous system polls this (ms). 0 = event-driven. */
  updateFrequencyMs: number;
}

// ============================================================================
// PROPRIOCEPTION — Body's sense of itself (Merleau-Ponty)
// ============================================================================

/**
 * The body's integrated self-awareness.
 *
 * Merleau-Ponty's "body schema": not a representation OF the body,
 * but the body's own non-representational awareness of itself.
 * Proprioception is not "I know my arm is here" but "I reach."
 */
export interface Proprioception {
  /** All organs and their health. */
  organs: Array<{ id: string; name: string; domain: BodyDomain; health: OrganHealth }>;
  /** All current affordances across both domains. */
  affordances: Affordance[];
  /** The combined Umwelt across all organs. */
  umwelt: UmweltDimension[];
  /** Resource utilization. */
  resources: Record<string, { used: number; total: number }>;
  /** Snapshot timestamp. */
  timestamp: number;
}

// ============================================================================
// NERVOUS SIGNAL — Communication between body and brain (Cybernetics)
// ============================================================================

/** Types of signals the nervous system produces. */
export type NervousSignalType =
  | 'sensation'           // Raw sensor data from an organ
  | 'reflex_triggered'    // A reflex bypassed the brain
  | 'health_change'       // An organ's health changed
  | 'affordance_change'   // Available actions changed
  | 'pain'                // Something is wrong (error, disconnect, damage)
  | 'proprioceptive';     // Periodic body state update

/**
 * A signal flowing through the nervous system.
 *
 * Signals have salience (attention priority). High-salience signals
 * (pain, reflex triggers) demand brain attention. Low-salience signals
 * (routine sensations) are logged but not broadcast to consciousness.
 */
export interface NervousSignal {
  id: string;
  type: NervousSignalType;
  organId: string;
  domain: BodyDomain;
  data: unknown;
  timestamp: number;
  /** Was this handled by a reflex without brain involvement? */
  reflexHandled?: boolean;
  /** Priority for brain attention (0-1). Higher = more urgent. */
  salience: number;
}

// ============================================================================
// REFLEX — Sub-cognitive response (Wiener's Cybernetics)
// ============================================================================

/**
 * A reflex rule: if trigger fires, execute action immediately.
 * Bypasses the brain entirely. Must complete in <10ms.
 *
 * Wiener: "the behavior of a system is controlled by its feedback loops."
 * Reflexes are the tightest feedback loops — no conscious mediation.
 */
export interface ReflexRule {
  /** Unique ID for this reflex. */
  id: string;
  /** What triggers this reflex. */
  trigger: {
    organId?: string;
    signalType: NervousSignalType;
    condition: (signal: NervousSignal) => boolean;
  };
  /** What action to take (must be fast, <10ms). */
  action: (signal: NervousSignal) => void | Promise<void>;
  /** Human-readable description. */
  description: string;
  /** Whether this reflex is currently enabled. */
  enabled: boolean;
}

// ============================================================================
// PHYSICAL DEVICE — Hardware connection configuration
// ============================================================================

/** Supported connection backends for physical devices. */
export type ConnectionBackendType = 'serial' | 'mqtt' | 'http' | 'websocket' | 'gpio' | 'mcp';

/** Configuration for a physical device (Arduino, ESP32, RPi, etc.). */
export interface PhysicalDeviceConfig {
  /** Unique device ID. */
  id: string;
  /** Human-readable name (e.g., "Living Room ESP32"). */
  name: string;
  /** Connection backend. */
  backend: ConnectionBackendType;
  /** Backend-specific configuration. */
  config: SerialConfig | MqttConfig | HttpConfig | WebSocketConfig | GpioConfig | McpHardwareConfig;
  /** Sensors this device provides. */
  sensors: SensorDefinition[];
  /** Actuators this device provides. */
  actuators: ActuatorDefinition[];
  /** Auto-reconnect on disconnect. */
  autoReconnect: boolean;
}

/** Sensor definition on a physical device. */
export interface SensorDefinition {
  id: string;
  name: string;
  unit: string;
  dataType: 'number' | 'boolean' | 'string' | 'json';
  /** Polling interval in ms. 0 = event-driven only. */
  pollIntervalMs: number;
  /** Thresholds for nervous system reflexes. */
  thresholds?: { min?: number; max?: number; onChange?: boolean };
}

/** Actuator definition on a physical device. */
export interface ActuatorDefinition {
  id: string;
  name: string;
  commandFormat: 'json' | 'text' | 'binary';
  /** Safety: max commands per second. */
  maxRateHz: number;
}

// ============================================================================
// CONNECTION BACKEND CONFIGS
// ============================================================================

export interface SerialConfig {
  port: string;
  baudRate: number;
  parser?: 'readline' | 'json' | 'raw';
}

export interface MqttConfig {
  broker: string;
  topics: string[];
  clientId?: string;
  username?: string;
  password?: string;
}

export interface HttpConfig {
  baseUrl: string;
  pollEndpoint?: string;
  commandEndpoint?: string;
  pollIntervalMs?: number;
}

export interface WebSocketConfig {
  url: string;
  protocol?: string;
}

export interface GpioConfig {
  pins: Array<{
    pin: number;
    direction: 'in' | 'out';
    edge?: 'rising' | 'falling' | 'both';
  }>;
}

export interface McpHardwareConfig {
  serverName: string;
  sensorTools: string[];
  actuatorTools: string[];
}

// ============================================================================
// CONNECTION BACKEND INSTANCE — Runtime interface
// ============================================================================

/** Callback for sensor data events. */
export type SensorDataCallback = (sensorId: string, value: unknown) => void;

/** All backends implement this interface. */
export interface ConnectionBackendInstance {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  onData(callback: SensorDataCallback): void;
  sendCommand(actuatorId: string, command: unknown): Promise<void>;
}

// ============================================================================
// PID CONTROLLER — Cybernetic feedback loop
// ============================================================================

/**
 * Configuration for a PID (Proportional-Integral-Derivative) controller.
 *
 * The simplest form of cybernetic intelligence: measure the error
 * between desired and actual, then adjust output to minimize it.
 * Predates AI by decades but remains the foundation of physical control.
 */
export interface PIDConfig {
  /** Which sensor provides the process variable. */
  sensorId: string;
  /** Which actuator receives the control output. */
  actuatorId: string;
  /** Target value (setpoint). */
  setpoint: number;
  /** Proportional gain. */
  kp: number;
  /** Integral gain. */
  ki: number;
  /** Derivative gain. */
  kd: number;
  /** Minimum output value. */
  outputMin: number;
  /** Maximum output value. */
  outputMax: number;
  /** Sample time in ms (how often the loop runs). */
  sampleTimeMs: number;
}

/** Runtime state of a PID controller. */
export interface PIDState {
  config: PIDConfig;
  lastError: number;
  integral: number;
  lastOutput: number;
  lastTimestamp: number;
  running: boolean;
}
