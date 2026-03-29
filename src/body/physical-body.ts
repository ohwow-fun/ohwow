/**
 * Physical Body — Hardware Connection Manager (Enactivism)
 *
 * "Cognition is not the representation of a pregiven world by a pregiven
 * mind but is rather the enactment of a world and a mind on the basis
 * of a history of the variety of actions that a being performs."
 * — Francisco Varela, The Embodied Mind
 *
 * The physical body manages connections to hardware devices (Arduino,
 * ESP32, Raspberry Pi, IoT sensors, actuators) through pluggable
 * connection backends (serial, MQTT, HTTP, WebSocket, GPIO, MCP).
 *
 * Each connected device becomes an organ in the body, providing
 * sensors (perception) and actuators (action) that extend the
 * agent's Umwelt into the physical world.
 */

import crypto from 'crypto';
import type {
  BodyPart,
  Affordance,
  UmweltDimension,
  OrganHealth,
  PhysicalDeviceConfig,
  ConnectionBackendInstance,
  ConnectionBackendType,
  SensorDataCallback,
} from './types.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// PHYSICAL DEVICE — A connected hardware device as a BodyPart
// ============================================================================

class PhysicalDeviceOrgan implements BodyPart {
  readonly id: string;
  readonly name: string;
  readonly domain = 'physical' as const;

  private backend: ConnectionBackendInstance;
  private config: PhysicalDeviceConfig;
  private sensorValues: Map<string, { value: unknown; timestamp: number }> = new Map();

  constructor(config: PhysicalDeviceConfig, backend: ConnectionBackendInstance) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
    this.backend = backend;

    // Register sensor data listener
    this.backend.onData((sensorId, value) => {
      this.sensorValues.set(sensorId, { value, timestamp: Date.now() });
    });
  }

  getHealth(): OrganHealth {
    if (!this.backend.isConnected()) return 'failed';
    // Check if any sensor has stale data (no update in 5x poll interval)
    for (const sensor of this.config.sensors) {
      if (sensor.pollIntervalMs > 0) {
        const data = this.sensorValues.get(sensor.id);
        if (data && Date.now() - data.timestamp > sensor.pollIntervalMs * 5) {
          return 'degraded';
        }
      }
    }
    return 'healthy';
  }

  getAffordances(): Affordance[] {
    const connected = this.backend.isConnected();
    const affordances: Affordance[] = [];

    // Sensor affordances (read)
    for (const sensor of this.config.sensors) {
      affordances.push({
        action: `read_${sensor.id}`,
        organId: this.id,
        domain: 'physical',
        readiness: connected ? 1 : 0,
        estimatedLatencyMs: sensor.pollIntervalMs || 100,
        risk: 'none',
        prerequisites: connected ? [] : [`device ${this.name} disconnected`],
      });
    }

    // Actuator affordances (command)
    for (const actuator of this.config.actuators) {
      affordances.push({
        action: `command_${actuator.id}`,
        organId: this.id,
        domain: 'physical',
        readiness: connected ? 1 : 0,
        estimatedLatencyMs: 100,
        risk: 'medium',
        prerequisites: connected ? [] : [`device ${this.name} disconnected`],
      });
    }

    return affordances;
  }

  getUmwelt(): UmweltDimension[] {
    return this.config.sensors.map(sensor => {
      const data = this.sensorValues.get(sensor.id);
      return {
        modality: `${sensor.name} (${sensor.unit})`,
        organId: this.id,
        currentValue: data?.value ?? null,
        lastUpdated: data?.timestamp ?? 0,
        updateFrequencyMs: sensor.pollIntervalMs,
      };
    });
  }

  isActive(): boolean {
    return this.backend.isConnected();
  }

  /** Read the latest value from a sensor. */
  readSensor(sensorId: string): unknown {
    return this.sensorValues.get(sensorId)?.value ?? null;
  }

  /** Send a command to an actuator. */
  async actuate(actuatorId: string, command: unknown): Promise<void> {
    return this.backend.sendCommand(actuatorId, command);
  }

  /** Get the underlying backend for lifecycle management. */
  getBackend(): ConnectionBackendInstance {
    return this.backend;
  }
}

// ============================================================================
// PHYSICAL BODY
// ============================================================================

/** Callback for sensor data events from any device. */
export type PhysicalSensorCallback = (deviceId: string, sensorId: string, value: unknown) => void;

export class PhysicalBody {
  private devices: Map<string, PhysicalDeviceOrgan> = new Map();
  private sensorCallbacks: PhysicalSensorCallback[] = [];

  // --------------------------------------------------------------------------
  // DEVICE MANAGEMENT
  // --------------------------------------------------------------------------

  /**
   * Add a new physical device.
   * Creates the connection backend and connects to the hardware.
   */
  async addDevice(config: PhysicalDeviceConfig): Promise<void> {
    if (this.devices.has(config.id)) {
      throw new Error(`Device ${config.id} already exists`);
    }

    const backend = await this.createBackend(config.backend, config.config);

    // Register global sensor listener for cross-device events
    backend.onData((sensorId, value) => {
      for (const cb of this.sensorCallbacks) {
        cb(config.id, sensorId, value);
      }
    });

    try {
      await backend.connect();
    } catch (err) {
      if (!config.autoReconnect) throw err;
      // If auto-reconnect, register the device anyway (will retry later)
      logger.warn({ deviceId: config.id, err }, '[PhysicalBody] Initial connection failed, will retry');
    }

    const organ = new PhysicalDeviceOrgan(config, backend);
    this.devices.set(config.id, organ);
    logger.info({ deviceId: config.id, name: config.name, backend: config.backend }, '[PhysicalBody] Device added');
  }

  /**
   * Remove a device and close its connection.
   */
  async removeDevice(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) return;

    try {
      await device.getBackend().disconnect();
    } catch (err) {
      logger.error({ err, deviceId }, '[PhysicalBody] Disconnect failed');
    }

    this.devices.delete(deviceId);
    logger.info({ deviceId }, '[PhysicalBody] Device removed');
  }

  // --------------------------------------------------------------------------
  // SENSOR / ACTUATOR ACCESS
  // --------------------------------------------------------------------------

  /** Read a sensor value from a specific device. */
  readSensor(deviceId: string, sensorId: string): unknown {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not found`);
    return device.readSensor(sensorId);
  }

  /** Send a command to an actuator on a specific device. */
  async actuate(deviceId: string, actuatorId: string, command: unknown): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not found`);
    if (!device.isActive()) throw new Error(`Device ${deviceId} is not connected`);
    return device.actuate(actuatorId, command);
  }

  /** Subscribe to sensor data from all devices. */
  onSensorData(callback: PhysicalSensorCallback): () => void {
    this.sensorCallbacks.push(callback);
    return () => {
      const idx = this.sensorCallbacks.indexOf(callback);
      if (idx >= 0) this.sensorCallbacks.splice(idx, 1);
    };
  }

  // --------------------------------------------------------------------------
  // BODY PART INTERFACE
  // --------------------------------------------------------------------------

  /** Get all connected devices as BodyParts. */
  getOrgans(): BodyPart[] {
    return Array.from(this.devices.values());
  }

  /** Get a specific device. */
  getDevice(deviceId: string): PhysicalDeviceOrgan | undefined {
    return this.devices.get(deviceId);
  }

  /** Get all affordances across all physical devices. */
  getAllAffordances(): Affordance[] {
    const affordances: Affordance[] = [];
    for (const device of this.devices.values()) {
      affordances.push(...device.getAffordances());
    }
    return affordances;
  }

  /** Get the combined physical Umwelt. */
  getUmwelt(): UmweltDimension[] {
    const dimensions: UmweltDimension[] = [];
    for (const device of this.devices.values()) {
      dimensions.push(...device.getUmwelt());
    }
    return dimensions;
  }

  /** Disconnect all devices. */
  async disconnectAll(): Promise<void> {
    const deviceIds = Array.from(this.devices.keys());
    for (const id of deviceIds) {
      await this.removeDevice(id);
    }
  }

  // --------------------------------------------------------------------------
  // BACKEND FACTORY
  // --------------------------------------------------------------------------

  private async createBackend(
    type: ConnectionBackendType,
    config: PhysicalDeviceConfig['config'],
  ): Promise<ConnectionBackendInstance> {
    switch (type) {
      case 'serial': {
        const { SerialBackend } = await import('./connections/serial-backend.js');
        return new SerialBackend(config as import('./types.js').SerialConfig);
      }
      case 'mqtt': {
        const { MqttBackend } = await import('./connections/mqtt-backend.js');
        return new MqttBackend(config as import('./types.js').MqttConfig);
      }
      case 'http': {
        const { HttpBackend } = await import('./connections/http-backend.js');
        return new HttpBackend(config as import('./types.js').HttpConfig);
      }
      default:
        throw new Error(`Unsupported backend: ${type}. Available: serial, mqtt, http`);
    }
  }
}
