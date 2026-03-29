/**
 * Physical Nervous System — Real-Time Hardware Control (Cybernetics)
 *
 * "The purpose of a system is what it does." — Stafford Beer
 *
 * The fastest layer of the agent's intelligence. Operates at 10-100ms
 * timescales with:
 * - Sensor polling loops (configurable per-sensor intervals)
 * - PID controllers (classic cybernetic feedback for continuous control)
 * - Safety reflexes (non-overridable, <10ms response)
 *
 * Safety reflexes are the non-negotiable core. No Brain deliberation,
 * no Noosphere consultation, no model inference. If temperature exceeds
 * the max, the heater turns off. Period. These are hard-wired survival
 * instincts, not cognitive decisions.
 */

import crypto from 'crypto';
import type {
  NervousSignal,
  ReflexRule,
  PIDConfig,
  PIDState,
  SensorDefinition,
} from './types.js';
import type { PhysicalBody } from './physical-body.js';
import type { ExperienceStream } from '../brain/experience-stream.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// PHYSICAL NERVOUS SYSTEM
// ============================================================================

export interface PhysicalNervousSystemOptions {
  body: PhysicalBody;
  experienceStream?: ExperienceStream;
}

export class PhysicalNervousSystem {
  private body: PhysicalBody;
  private experienceStream: ExperienceStream | null;

  private sensorLoops: Map<string, ReturnType<typeof setInterval>> = new Map();
  private pidControllers: Map<string, { state: PIDState; timer: ReturnType<typeof setInterval> }> = new Map();
  private reflexes: ReflexRule[] = [];
  private listeners: Array<(signal: NervousSignal) => void> = [];
  private running = false;

  constructor(options: PhysicalNervousSystemOptions) {
    this.body = options.body;
    this.experienceStream = options.experienceStream ?? null;
  }

  // --------------------------------------------------------------------------
  // LIFECYCLE
  // --------------------------------------------------------------------------

  /** Start sensor polling for all devices. */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Subscribe to all sensor data from the physical body
    this.body.onSensorData((deviceId, sensorId, value) => {
      this.handleSensorData(deviceId, sensorId, value);
    });

    logger.info('[PhysicalNS] Started');
  }

  /** Stop all loops and controllers. */
  stop(): void {
    this.running = false;

    for (const loop of this.sensorLoops.values()) clearInterval(loop);
    this.sensorLoops.clear();

    for (const { timer } of this.pidControllers.values()) clearInterval(timer);
    this.pidControllers.clear();

    logger.info('[PhysicalNS] Stopped');
  }

  // --------------------------------------------------------------------------
  // REFLEXES — Safety-critical, non-overridable
  // --------------------------------------------------------------------------

  /**
   * Register a safety reflex.
   * Reflexes fire synchronously on sensor data, before any brain processing.
   * Must complete in <10ms.
   */
  addReflex(rule: ReflexRule): void {
    this.reflexes.push(rule);
    logger.info({ reflexId: rule.id, description: rule.description }, '[PhysicalNS] Reflex registered');
  }

  /** Remove a reflex by ID. */
  removeReflex(id: string): void {
    this.reflexes = this.reflexes.filter(r => r.id !== id);
  }

  /**
   * Create standard safety reflexes for a device based on sensor thresholds.
   * Called automatically when a device with threshold-defined sensors is added.
   */
  createThresholdReflexes(deviceId: string, sensors: SensorDefinition[]): void {
    for (const sensor of sensors) {
      if (!sensor.thresholds) continue;

      if (sensor.thresholds.max !== undefined) {
        const maxThreshold = sensor.thresholds.max;
        this.addReflex({
          id: `${deviceId}:${sensor.id}:max`,
          trigger: {
            organId: deviceId,
            signalType: 'sensation',
            condition: (signal) => {
              const data = signal.data as { sensorId?: string; value?: number } | undefined;
              return data?.sensorId === sensor.id && typeof data?.value === 'number' && data.value > maxThreshold;
            },
          },
          action: (signal) => {
            logger.warn(
              { deviceId, sensorId: sensor.id, value: (signal.data as { value: number }).value, max: maxThreshold },
              '[PhysicalNS] MAX THRESHOLD EXCEEDED — reflex triggered',
            );
          },
          description: `Safety: ${sensor.name} exceeds max ${maxThreshold}${sensor.unit}`,
          enabled: true,
        });
      }

      if (sensor.thresholds.min !== undefined) {
        const minThreshold = sensor.thresholds.min;
        this.addReflex({
          id: `${deviceId}:${sensor.id}:min`,
          trigger: {
            organId: deviceId,
            signalType: 'sensation',
            condition: (signal) => {
              const data = signal.data as { sensorId?: string; value?: number } | undefined;
              return data?.sensorId === sensor.id && typeof data?.value === 'number' && data.value < minThreshold;
            },
          },
          action: (signal) => {
            logger.warn(
              { deviceId, sensorId: sensor.id, value: (signal.data as { value: number }).value, min: minThreshold },
              '[PhysicalNS] MIN THRESHOLD BREACHED — reflex triggered',
            );
          },
          description: `Safety: ${sensor.name} below min ${minThreshold}${sensor.unit}`,
          enabled: true,
        });
      }
    }
  }

  // --------------------------------------------------------------------------
  // PID CONTROLLERS — Cybernetic feedback loops
  // --------------------------------------------------------------------------

  /**
   * Add a PID control loop.
   *
   * The simplest form of cybernetic intelligence: measure error between
   * desired and actual, adjust output to minimize it. Runs at the configured
   * sampleTimeMs interval.
   */
  addPIDLoop(config: PIDConfig): void {
    const state: PIDState = {
      config,
      lastError: 0,
      integral: 0,
      lastOutput: 0,
      lastTimestamp: Date.now(),
      running: true,
    };

    const timer = setInterval(() => this.runPIDStep(state), config.sampleTimeMs);
    this.pidControllers.set(config.sensorId, { state, timer });

    logger.info(
      { sensorId: config.sensorId, actuatorId: config.actuatorId, setpoint: config.setpoint },
      '[PhysicalNS] PID controller started',
    );
  }

  /** Remove a PID control loop. */
  removePIDLoop(sensorId: string): void {
    const controller = this.pidControllers.get(sensorId);
    if (controller) {
      clearInterval(controller.timer);
      controller.state.running = false;
      this.pidControllers.delete(sensorId);
    }
  }

  /** Update a PID setpoint at runtime. */
  updateSetpoint(sensorId: string, newSetpoint: number): void {
    const controller = this.pidControllers.get(sensorId);
    if (controller) {
      controller.state.config.setpoint = newSetpoint;
      controller.state.integral = 0; // Reset integral to avoid windup
    }
  }

  // --------------------------------------------------------------------------
  // SIGNAL LISTENERS
  // --------------------------------------------------------------------------

  onSignal(listener: (signal: NervousSignal) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  private handleSensorData(deviceId: string, sensorId: string, value: unknown): void {
    const signal: NervousSignal = {
      id: crypto.randomUUID(),
      type: 'sensation',
      organId: deviceId,
      domain: 'physical',
      data: { sensorId, value, deviceId },
      timestamp: Date.now(),
      salience: 0.1,
    };

    // Fire reflexes first (synchronous, highest priority)
    let reflexFired = false;
    for (const reflex of this.reflexes) {
      if (!reflex.enabled) continue;
      if (reflex.trigger.organId && reflex.trigger.organId !== deviceId) continue;
      if (reflex.trigger.signalType !== 'sensation') continue;

      try {
        if (reflex.trigger.condition(signal)) {
          reflex.action(signal);
          reflexFired = true;
          signal.reflexHandled = true;
          signal.salience = 0.8; // Bump salience for reflex triggers

          // Emit reflex event
          const reflexSignal: NervousSignal = {
            ...signal,
            id: crypto.randomUUID(),
            type: 'reflex_triggered',
            data: { ...signal.data as object, reflexId: reflex.id, reflexDescription: reflex.description },
            salience: 0.8,
          };
          this.notifyListeners(reflexSignal);
        }
      } catch (err) {
        logger.error({ err, reflexId: reflex.id }, '[PhysicalNS] Reflex execution error');
      }
    }

    // Notify listeners (including the unified nervous system)
    this.notifyListeners(signal);

    // Log to experience stream
    if (this.experienceStream) {
      const type = reflexFired ? 'body_reflex' as const : 'body_sensation' as const;
      this.experienceStream.append(type, signal.data, 'engine');
    }
  }

  private runPIDStep(state: PIDState): void {
    if (!state.running) return;

    const { config } = state;

    // Read current sensor value
    let currentValue: number;
    try {
      const raw = this.body.readSensor(
        // Find the device that owns this sensor
        this.findDeviceForSensor(config.sensorId) ?? '',
        config.sensorId,
      );
      currentValue = typeof raw === 'number' ? raw : Number(raw);
      if (isNaN(currentValue)) return; // Can't control without valid reading
    } catch {
      return; // Sensor read failed, skip this step
    }

    // PID computation
    const now = Date.now();
    const dt = (now - state.lastTimestamp) / 1000; // in seconds
    if (dt <= 0) return;

    const error = config.setpoint - currentValue;
    state.integral += error * dt;
    const derivative = (error - state.lastError) / dt;

    let output = config.kp * error + config.ki * state.integral + config.kd * derivative;

    // Clamp output
    output = Math.max(config.outputMin, Math.min(config.outputMax, output));

    // Anti-windup: if output is saturated, stop integrating
    if (output === config.outputMin || output === config.outputMax) {
      state.integral -= error * dt;
    }

    // Send to actuator
    const deviceId = this.findDeviceForSensor(config.sensorId) ?? '';
    this.body.actuate(deviceId, config.actuatorId, output).catch(err => {
      logger.error({ err, actuatorId: config.actuatorId }, '[PhysicalNS] PID actuator command failed');
    });

    state.lastError = error;
    state.lastOutput = output;
    state.lastTimestamp = now;
  }

  private findDeviceForSensor(sensorId: string): string | undefined {
    for (const organ of this.body.getOrgans()) {
      const umwelt = organ.getUmwelt();
      if (umwelt.some(d => d.modality.includes(sensorId))) {
        return organ.id;
      }
    }
    return undefined;
  }

  private notifyListeners(signal: NervousSignal): void {
    for (const listener of this.listeners) {
      try { listener(signal); } catch { /* non-fatal */ }
    }
  }
}
