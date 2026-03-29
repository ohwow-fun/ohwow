/**
 * MQTT Connection Backend — IoT Standard Protocol
 *
 * Connects to an MQTT broker (e.g., Mosquitto) for pub/sub communication
 * with IoT devices. The most scalable backend for multiple wireless devices.
 *
 * Topic convention:
 * - Sensors publish to: ohwow/{deviceId}/sensors/{sensorId}
 * - Actuators subscribe to: ohwow/{deviceId}/actuators/{actuatorId}
 */

import type { ConnectionBackendInstance, SensorDataCallback, MqttConfig } from '../types.js';
import type { MqttClient, IClientOptions } from 'mqtt';
import { logger } from '../../lib/logger.js';

export class MqttBackend implements ConnectionBackendInstance {
  private client: MqttClient | null = null;
  private connected = false;
  private dataCallbacks: SensorDataCallback[] = [];
  private config: MqttConfig;

  constructor(config: MqttConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      // Dynamic import: mqtt is an optional dependency
      const mqtt = await import('mqtt');

      const connectOptions: IClientOptions = {
        clientId: this.config.clientId ?? `ohwow_${Date.now()}`,
        username: this.config.username,
        password: this.config.password,
        reconnectPeriod: 5000,
        connectTimeout: 10000,
      };

      this.client = mqtt.connect(this.config.broker, connectOptions);

      this.client.on('connect', () => {
        this.connected = true;
        logger.info({ broker: this.config.broker }, '[MqttBackend] Connected');

        // Subscribe to configured topics
        for (const topic of this.config.topics) {
          this.client!.subscribe(topic, (err: Error | null) => {
            if (err) {
              logger.error({ err, topic }, '[MqttBackend] Subscribe failed');
            } else {
              logger.debug({ topic }, '[MqttBackend] Subscribed');
            }
          });
        }
      });

      this.client.on('message', (topic: string, payload: Buffer) => {
        this.handleMessage(topic, payload.toString());
      });

      this.client.on('error', (err: unknown) => {
        logger.error({ err }, '[MqttBackend] Connection error');
      });

      this.client.on('offline', () => {
        this.connected = false;
        logger.warn('[MqttBackend] Went offline');
      });

      this.client.on('reconnect', () => {
        logger.debug('[MqttBackend] Reconnecting');
      });

      // Wait for initial connection
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('MQTT connection timeout')), 10000);
        this.client!.once('connect', () => { clearTimeout(timeout); resolve(); });
        this.client!.once('error', (err: unknown) => { clearTimeout(timeout); reject(err); });
      });
    } catch (err) {
      logger.error({ err, broker: this.config.broker }, '[MqttBackend] Failed to connect');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await new Promise<void>((resolve) => {
        this.client!.end(false, () => resolve());
      });
    }
    this.client = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected && (this.client?.connected ?? false);
  }

  onData(callback: SensorDataCallback): void {
    this.dataCallbacks.push(callback);
  }

  async sendCommand(actuatorId: string, command: unknown): Promise<void> {
    if (!this.client?.connected) {
      throw new Error('MQTT client not connected');
    }

    // Publish to the actuator topic
    // Convention: ohwow/{deviceId}/actuators/{actuatorId}
    // Since we don't have deviceId here, publish to a generic topic
    const topic = `ohwow/actuators/${actuatorId}`;
    const payload = typeof command === 'string' ? command : JSON.stringify(command);

    await new Promise<void>((resolve, reject) => {
      this.client!.publish(topic, payload, { qos: 1 }, (err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  private handleMessage(topic: string, payload: string): void {
    // Extract sensor ID from topic convention: ohwow/{deviceId}/sensors/{sensorId}
    const parts = topic.split('/');
    const sensorIdx = parts.indexOf('sensors');
    const sensorId = sensorIdx >= 0 && parts[sensorIdx + 1]
      ? parts[sensorIdx + 1]
      : topic; // fallback to full topic as sensor ID

    // Try to parse as number or JSON
    let value: unknown = payload;
    const num = Number(payload);
    if (!isNaN(num) && payload.trim() !== '') {
      value = num;
    } else {
      try { value = JSON.parse(payload); } catch { /* keep as string */ }
    }

    for (const cb of this.dataCallbacks) {
      cb(sensorId, value);
    }
  }
}
