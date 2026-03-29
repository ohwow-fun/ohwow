/**
 * Body — Public API
 *
 * The embodiment layer for the ohwow local runtime.
 * Formalizes the agent's digital body (wrapping existing services)
 * and prepares the foundation for physical body (hardware).
 *
 * Phase 1: Types + Digital Body (wrapping existing services)
 * Phase 2: Digital Nervous System (background monitoring)
 * Phase 3: Physical Body + Connection Backends (serial, MQTT, etc.)
 * Phase 4: Physical Nervous System (sensor loops, PID, reflexes)
 * Phase 5: Unified Nervous System (cross-domain affordances)
 */

// Types
export type {
  BodyPart,
  BodyDomain,
  OrganHealth,
  Affordance,
  AffordanceRisk,
  UmweltDimension,
  Proprioception,
  NervousSignal,
  NervousSignalType,
  ReflexRule,
  PhysicalDeviceConfig,
  SensorDefinition,
  ActuatorDefinition,
  ConnectionBackendType,
  ConnectionBackendInstance,
  SensorDataCallback,
  SerialConfig,
  MqttConfig,
  HttpConfig,
  WebSocketConfig,
  GpioConfig,
  McpHardwareConfig,
  PIDConfig,
  PIDState,
} from './types.js';

// Digital Body
export {
  DigitalBody,
  createBrowserOrgan,
  createDesktopOrgan,
  createChannelsOrgan,
  createMcpOrgan,
} from './digital-body.js';
export type {
  DigitalBodyOptions,
  BrowserServiceLike,
  DesktopServiceLike,
  ChannelRegistryLike,
  McpManagerLike,
} from './digital-body.js';

// Phase 2: Digital Nervous System
export { DigitalNervousSystem } from './digital-nervous-system.js';
export type { DigitalNervousSystemOptions } from './digital-nervous-system.js';

// Phase 3: Physical Body + Connection Backends
export { PhysicalBody } from './physical-body.js';
export type { PhysicalSensorCallback } from './physical-body.js';

// Phase 4: Physical Nervous System
export { PhysicalNervousSystem } from './physical-nervous-system.js';
export type { PhysicalNervousSystemOptions } from './physical-nervous-system.js';

// Phase 5: Unified Nervous System
export { NervousSystem } from './nervous-system.js';
export type { NervousSystemOptions } from './nervous-system.js';
