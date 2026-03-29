/**
 * Serial Connection Backend — USB Hardware Bridge
 *
 * Connects to Arduino/ESP32 via USB serial port using the `serialport` npm package.
 * The simplest hardware connection: plug in a USB cable and go.
 *
 * Expected device protocol:
 * - Device sends JSON lines: {"sensorId": "temp", "value": 25.3}
 * - Device receives JSON commands: {"actuatorId": "servo", "command": 90}
 */

import type { ConnectionBackendInstance, SensorDataCallback, SerialConfig } from '../types.js';
import type { SerialPort as SerialPortType } from 'serialport';
import { logger } from '../../lib/logger.js';

export class SerialBackend implements ConnectionBackendInstance {
  private port: SerialPortType | null = null;
  private connected = false;
  private dataCallbacks: SensorDataCallback[] = [];
  private config: SerialConfig;

  constructor(config: SerialConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      // Dynamic import: serialport is an optional peer dependency
      const { SerialPort } = await import('serialport');
      const { ReadlineParser } = await import('@serialport/parser-readline');

      this.port = new SerialPort({
        path: this.config.port,
        baudRate: this.config.baudRate,
        autoOpen: false,
      });

      // Set up parser based on config
      const parser = this.config.parser === 'json' || this.config.parser === 'readline'
        ? this.port.pipe(new ReadlineParser({ delimiter: '\n' }))
        : this.port;

      parser.on('data', (line: string | Buffer) => {
        this.handleData(typeof line === 'string' ? line : line.toString());
      });

      this.port.on('error', (err: unknown) => {
        logger.error({ err, port: this.config.port }, '[SerialBackend] Port error');
        this.connected = false;
      });

      this.port.on('close', () => {
        logger.info({ port: this.config.port }, '[SerialBackend] Port closed');
        this.connected = false;
      });

      // Open the port
      await new Promise<void>((resolve, reject) => {
        this.port!.open((err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });

      this.connected = true;
      logger.info({ port: this.config.port, baudRate: this.config.baudRate }, '[SerialBackend] Connected');
    } catch (err) {
      logger.error({ err, port: this.config.port }, '[SerialBackend] Failed to connect');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.port?.isOpen) {
      await new Promise<void>((resolve) => {
        this.port!.close(() => resolve());
      });
    }
    this.port = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected && (this.port?.isOpen ?? false);
  }

  onData(callback: SensorDataCallback): void {
    this.dataCallbacks.push(callback);
  }

  async sendCommand(actuatorId: string, command: unknown): Promise<void> {
    if (!this.port?.isOpen) {
      throw new Error('Serial port not open');
    }

    const payload = JSON.stringify({ actuatorId, command }) + '\n';
    await new Promise<void>((resolve, reject) => {
      this.port!.write(payload, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  private handleData(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      if (this.config.parser === 'json' || this.config.parser === 'readline') {
        const parsed = JSON.parse(trimmed);
        const sensorId = parsed.sensorId ?? parsed.sensor ?? parsed.id ?? 'unknown';
        const value = parsed.value ?? parsed.data ?? parsed;
        for (const cb of this.dataCallbacks) {
          cb(String(sensorId), value);
        }
      } else {
        // Raw mode: emit the whole line with a generic sensor ID
        for (const cb of this.dataCallbacks) {
          cb('raw', trimmed);
        }
      }
    } catch {
      // Non-JSON line — emit as raw
      for (const cb of this.dataCallbacks) {
        cb('raw', trimmed);
      }
    }
  }
}
