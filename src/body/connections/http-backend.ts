/**
 * HTTP Connection Backend — REST Device Bridge
 *
 * Polls an HTTP endpoint for sensor data and POSTs commands to actuators.
 * The simplest wireless backend — works with any ESP32 running a web server.
 *
 * Expected endpoints:
 * - GET {baseUrl}/sensors → { "temp": 25.3, "motion": true }
 * - POST {baseUrl}/actuators → { "actuatorId": "servo", "command": 90 }
 */

import type { ConnectionBackendInstance, SensorDataCallback, HttpConfig } from '../types.js';
import { logger } from '../../lib/logger.js';

export class HttpBackend implements ConnectionBackendInstance {
  private connected = false;
  private dataCallbacks: SensorDataCallback[] = [];
  private config: HttpConfig;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: HttpConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    // Verify the device is reachable
    const pollUrl = this.config.pollEndpoint
      ? `${this.config.baseUrl}${this.config.pollEndpoint}`
      : `${this.config.baseUrl}/sensors`;

    try {
      const response = await fetch(pollUrl, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.connected = true;
      logger.info({ baseUrl: this.config.baseUrl }, '[HttpBackend] Connected');

      // Start polling loop
      const interval = this.config.pollIntervalMs ?? 1000;
      this.pollTimer = setInterval(() => this.poll(pollUrl), interval);

      // Do an initial poll
      await this.poll(pollUrl);
    } catch (err) {
      logger.error({ err, baseUrl: this.config.baseUrl }, '[HttpBackend] Failed to connect');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onData(callback: SensorDataCallback): void {
    this.dataCallbacks.push(callback);
  }

  async sendCommand(actuatorId: string, command: unknown): Promise<void> {
    const commandUrl = this.config.commandEndpoint
      ? `${this.config.baseUrl}${this.config.commandEndpoint}`
      : `${this.config.baseUrl}/actuators`;

    const response = await fetch(commandUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actuatorId, command }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Actuator command failed: HTTP ${response.status}`);
    }
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  private async poll(url: string): Promise<void> {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) {
        this.connected = false;
        return;
      }

      this.connected = true;
      const data = await response.json();

      // Emit each key-value pair as a sensor reading
      if (data && typeof data === 'object') {
        for (const [sensorId, value] of Object.entries(data)) {
          for (const cb of this.dataCallbacks) {
            cb(sensorId, value);
          }
        }
      }
    } catch {
      this.connected = false;
    }
  }
}
