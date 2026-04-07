/**
 * Control Plane Client
 * Manages communication between the local runtime and the cloud.
 *
 * - connect() — Authenticates with cloud, receives agent configs
 * - startPolling() — Long-polls for commands (task_dispatch, config_sync, etc.)
 * - sendHeartbeat() — Periodic health metrics
 * - reportTask() — Sends task operational data (titles, status, costs — no prompts or outputs) to cloud
 * - disconnect() — Graceful shutdown
 *
 * Device locking: handles 409 conflicts on connect (device change detection)
 * and 'replaced' signals on poll/heartbeat (another device took over).
 */

import os, { hostname, cpus } from 'os';
import { statSync } from 'fs';
import { VERSION } from '../version.js';
import type { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type {
  ConnectRequest,
  ConnectResponse,
  DeviceLimitResponse,
  PollMessage,
  PollResponse,
  HeartbeatPayload,
  LocalModelSummary,
  TaskReportPayload,
  AgentConfigPayload,
  ExecuteDeferredActionRequest,
  ExecuteDeferredActionResponse,
  WebhookRelayPayload,
  DeviceCapabilities,
  MemorySyncPayload,
  StateSyncEntry,
  PresenceEventPayload,
} from './types.js';
import { dirname } from 'path';
import type { OllamaMonitor } from '../lib/ollama-monitor.js';
import type { RuntimeConfig } from '../config.js';
import { writeReplacedMarker } from '../daemon/lifecycle.js';
import { logger } from '../lib/logger.js';
import { detectDevice, getMemoryTier, estimateTotalVramGb, getVramInfo, getFleetSensingData } from '../lib/device-info.js';
import { getMachineId } from '../lib/machine-id.js';
import { OutboundQueue } from './outbound-queue.js';
import type { OutboundQueueItem } from './outbound-queue.js';
import type { ConsciousnessBridge, CloudConsciousnessItem } from '../brain/consciousness-bridge.js';
import type { AffectEngine } from '../affect/affect-engine.js';
import type { EndocrineSystem } from '../endocrine/endocrine-system.js';
import type { HomeostasisController } from '../homeostasis/homeostasis-controller.js';
import type { ImmuneSystem } from '../immune/immune-system.js';
import type { NarrativeEngine } from '../narrative/narrative-engine.js';
import type { EthicsEngine } from '../ethos/ethics-engine.js';
import type { HabitEngine } from '../hexis/habit-engine.js';

export interface BppModules {
  affect?: AffectEngine | null;
  endocrine?: EndocrineSystem | null;
  homeostasis?: HomeostasisController | null;
  immune?: ImmuneSystem | null;
  narrative?: NarrativeEngine | null;
  ethics?: EthicsEngine | null;
  habits?: HabitEngine | null;
}

export interface ControlPlaneCallbacks {
  onTaskDispatch: (agentId: string, taskId: string, taskPayload: Record<string, unknown>) => void;
  onConfigSync: (agents: AgentConfigPayload[]) => void;
  onTaskCancel: (taskId: string) => void;
  onWebhookRelay?: (payload: WebhookRelayPayload) => void;
  onWorkflowExecute?: (workflowId: string, variables?: Record<string, unknown>) => void;
  onReplaced?: () => Promise<void>;
  onDesktopEmergencyStop?: () => void;
  onDesktopConfirmationRequired?: (agentId: string, agentName: string) => void;
  onPresenceEvent?: (payload: PresenceEventPayload) => void;
}

export class ControlPlaneClient {
  private sessionToken: string | null = null;
  private workspaceId: string | null = null;
  private deviceId: string | null = null;

  /** Public accessor for the connected workspace ID */
  get connectedWorkspaceId(): string | null {
    return this.workspaceId;
  }

  /** Public accessor for the connected device ID (local_runtime_status row UUID) */
  get connectedDeviceId(): string | null {
    return this.deviceId;
  }

  /** Public accessor for the cloud session token (for device-to-device auth) */
  get cloudSessionToken(): string | null {
    return this.sessionToken;
  }
  private polling = false;
  private replaced = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startTime: number;
  private lastSequence = 0;
  private emitter: TypedEventBus<RuntimeEvents> | null;
  private tunnelUrl: string | null = null;
  private ollamaMonitor: OllamaMonitor | null = null;
  private prevCpuTimes: { idle: number; total: number } | null = null;
  private _contentPublicKey: JsonWebKey | null = null;
  /** Public key for verifying content tokens (ES256). Received from cloud during connect. */
  get contentPublicKey(): JsonWebKey | null {
    return this._contentPublicKey;
  }
  private outboundQueue: OutboundQueue;
  private consciousnessBridge: ConsciousnessBridge | null = null;
  private bppModules: BppModules | null = null;

  constructor(
    private config: RuntimeConfig,
    private db: DatabaseAdapter,
    private callbacks: ControlPlaneCallbacks,
    emitter?: TypedEventBus<RuntimeEvents>,
  ) {
    this.startTime = Date.now();
    this.emitter = emitter ?? null;
    this.outboundQueue = new OutboundQueue(db);
  }

  /**
   * Set the tunnel URL so heartbeats report it to the cloud.
   */
  setTunnelUrl(url: string): void {
    this.tunnelUrl = url;
  }

  /**
   * Set the OllamaMonitor so heartbeats include local model summaries.
   */
  setOllamaMonitor(monitor: OllamaMonitor): void {
    this.ollamaMonitor = monitor;
  }

  /**
   * Set the ConsciousnessBridge for bidirectional consciousness sync.
   * Items broadcast locally are sent to cloud; cloud items are merged locally.
   */
  setConsciousnessBridge(bridge: ConsciousnessBridge): void {
    this.consciousnessBridge = bridge;
  }

  /**
   * Set BPP modules for periodic state sync to cloud.
   * Call after philosophical layers finish async initialization.
   */
  setBppModules(modules: BppModules): void {
    this.bppModules = modules;
  }

  /** Late-bind a handler for presence events from the phone eye. */
  setPresenceHandler(handler: (event: PresenceEventPayload) => void): void {
    this.callbacks.onPresenceEvent = handler;
  }

  /**
   * Connect to the cloud control plane.
   * Validates license, receives session token and agent configs.
   * On 409 device limit, throws with a descriptive error message.
   * Multiple devices coexist; no force-switch needed.
   */
  async connect(): Promise<ConnectResponse> {
    // Detect device capabilities for cloud registration
    const device = detectDevice();
    const memoryTier = getMemoryTier(device);
    const totalVramGb = estimateTotalVramGb();
    const deviceCapabilities: DeviceCapabilities = {
      totalMemoryGb: device.totalMemoryGB,
      cpuCores: device.cpuCores,
      cpuModel: device.cpuModel,
      isAppleSilicon: device.isAppleSilicon,
      hasNvidiaGpu: device.hasNvidiaGpu,
      gpuName: device.gpuName,
      memoryTier,
      ...(totalVramGb > 0 ? { totalVramGb } : {}),
    };

    const body: ConnectRequest = {
      licenseKey: this.config.licenseKey,
      runtimeVersion: VERSION,
      hostname: hostname(),
      osPlatform: process.platform,
      nodeVersion: process.version,
      localUrl: this.config.localUrl,
      machineId: getMachineId(),
      deviceCapabilities,
    };

    const response = await fetch(`${this.config.cloudUrl}/api/local-runtime/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // Handle device limit (multi-device: 409 now means "at capacity")
    if (response.status === 409) {
      const limitResponse = await response.json() as DeviceLimitResponse;

      if (limitResponse.error === 'device_limit') {
        const deviceNames = limitResponse.connectedDevices
          .map((d) => d.deviceName || d.hostname || d.id)
          .join(', ');
        logger.warn(`[ControlPlane] Device limit reached (${limitResponse.maxRuntimes}). Connected: ${deviceNames}`);
        throw new Error(
          `You've reached the device limit (${limitResponse.connectedDevices.length}/${limitResponse.maxRuntimes}). Disconnect one from the dashboard first.`
        );
      }
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`Connect failed (${response.status}): ${(error as Record<string, string>).error}`);
    }

    const data = await response.json() as ConnectResponse;
    this.sessionToken = data.sessionToken;
    this.workspaceId = data.workspaceId;
    this.deviceId = data.deviceId;
    this._contentPublicKey = data.contentPublicKey ?? null;

    // Sync agent configs to local DB
    await this.syncAgentConfigs(data.agents);

    // Sync memories from cloud if memory sync is enabled
    if (data.memorySyncEnabled && data.memories?.byAgent) {
      await this.syncMemoriesFromCloud(data.memories.byAgent);
    }

    // Sync agent state from cloud for multi-device continuity
    if (data.stateSync?.byAgent) {
      await this.syncStateFromCloud(data.stateSync.byAgent);
    }

    // Store memory sync setting locally
    if (data.memorySyncEnabled !== undefined) {
      await this.db.from('runtime_settings').update({
        value: String(data.memorySyncEnabled),
        updated_at: new Date().toISOString(),
      }).eq('key', 'memory_sync_enabled').then(() => {}, () => {});
    }

    logger.info(`[ControlPlane] Connected. Workspace: ${data.workspaceId}, Device: ${data.deviceId}, Agents: ${data.agents.length}${data.memorySyncEnabled ? ', Memory sync: on' : ''}`);

    // Drain any reports that were queued while offline
    this.drainOutboundQueue().catch(() => {});

    return data;
  }

  /**
   * Start long-polling for commands from cloud.
   */
  startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    this.pollLoop();
  }

  /**
   * Stop polling and heartbeats.
   */
  stop(): void {
    this.polling = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Send a single heartbeat immediately (e.g., after tunnel URL changes).
   */
  async sendHeartbeatNow(): Promise<void> {
    return this.sendHeartbeat();
  }

  /** Whether a desktop control session is currently active */
  private _desktopSessionActive = false;
  private _desktopActiveAgentId: string | null = null;

  /**
   * Start sending periodic heartbeats (every 15s, or 5s during active desktop).
   */
  startHeartbeats(): void {
    // Send first heartbeat immediately
    this.sendHeartbeat().catch(err => {
      logger.error(`[ControlPlane] Heartbeat failed: ${err}`);
    });

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch(err => {
        logger.error(`[ControlPlane] Heartbeat failed: ${err}`);
      });
    }, this._desktopSessionActive ? 5_000 : 15_000);
  }

  /**
   * Set the desktop session state (active/inactive) and adjust heartbeat interval.
   * Called by the orchestrator when desktop control is activated/deactivated.
   */
  setDesktopSessionActive(active: boolean, agentId?: string): void {
    const changed = this._desktopSessionActive !== active;
    this._desktopSessionActive = active;
    this._desktopActiveAgentId = active ? (agentId ?? null) : null;

    if (changed && this.heartbeatTimer) {
      // Restart heartbeat with new interval
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        this.sendHeartbeat().catch(err => {
          logger.error(`[ControlPlane] Heartbeat failed: ${err}`);
        });
      }, active ? 5_000 : 15_000);
      logger.info(`[ControlPlane] Heartbeat interval adjusted to ${active ? '5s' : '15s'} (desktop ${active ? 'active' : 'inactive'})`);
    }
  }

  /**
   * Confirm desktop access for an agent after local user approval.
   * Updates the local config to enable desktop_enabled.
   */
  async confirmDesktopAccess(agentId: string, confirmed: boolean): Promise<void> {
    if (!confirmed) {
      logger.info({ agentId }, '[ControlPlane] Desktop access denied locally');
      return;
    }

    // Enable desktop in local agent config
    const { data: configRow } = await this.db
      .from('local_agent_configs')
      .select('config')
      .eq('id', agentId)
      .limit(1);

    if (configRow && configRow.length > 0) {
      const row = configRow[0] as { config: string };
      const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
      config.desktop_enabled = true;
      await this.db.from('local_agent_configs').update({
        config: JSON.stringify(config),
      }).eq('id', agentId);

      // Also update the agents table
      await this.db.from('agent_workforce_agents').update({
        config: JSON.stringify(config),
      }).eq('id', agentId);
    }

    logger.info({ agentId }, '[ControlPlane] Desktop access confirmed locally');
  }

  /**
   * Report task operational data to cloud (no prompts or outputs).
   * Always sent even if replaced — in-flight work shouldn't be lost.
   */
  async reportTask(report: TaskReportPayload): Promise<void> {
    if (!this.sessionToken) {
      logger.warn('[ControlPlane] Not connected, queuing report');
      await this.outboundQueue.enqueue('task_report', report);
      return;
    }

    try {
      const response = await fetch(`${this.config.cloudUrl}/api/local-runtime/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.sessionToken}`,
        },
        body: JSON.stringify(report),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        logger.error(`[ControlPlane] Report failed: ${response.status} ${JSON.stringify(error)}`);
        await this.outboundQueue.enqueue('task_report', report);
      }
    } catch (err) {
      logger.error(`[ControlPlane] Report error (queued): ${err}`);
      await this.outboundQueue.enqueue('task_report', report);
    }
  }

  /**
   * Execute a deferred action via the cloud control plane.
   * The cloud has OAuth tokens and integration tool pipelines; the runtime delegates.
   */
  async executeDeferredAction(
    taskId: string,
    deferredAction: ExecuteDeferredActionRequest['deferredAction'],
  ): Promise<ExecuteDeferredActionResponse> {
    if (!this.sessionToken) {
      return { success: false, error: 'Not connected to cloud' };
    }

    try {
      const response = await fetch(`${this.config.cloudUrl}/api/local-runtime/execute-deferred-action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.sessionToken}`,
        },
        body: JSON.stringify({ taskId, deferredAction } satisfies ExecuteDeferredActionRequest),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        return { success: false, error: (error as Record<string, string>).error || `HTTP ${response.status}` };
      }

      return await response.json() as ExecuteDeferredActionResponse;
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Network error' };
    }
  }

  /**
   * Sync workspace settings (e.g., notification channel preferences) to cloud.
   */
  async reportSettings(settings: Record<string, unknown>): Promise<void> {
    if (!this.sessionToken) {
      logger.warn('[ControlPlane] Not connected, skipping settings sync');
      return;
    }

    try {
      const response = await fetch(`${this.config.cloudUrl}/api/local-runtime/settings`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.sessionToken}`,
        },
        body: JSON.stringify(settings),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        logger.error(`[ControlPlane] Settings sync failed: ${response.status} ${JSON.stringify(error)}`);
      }
    } catch (err) {
      logger.error(`[ControlPlane] Settings sync error: ${err}`);
    }
  }

  /**
   * Proxy a GET request to the cloud API.
   * Used by daemon routes that need to fetch data from ohwow.fun on behalf of MCP clients.
   */
  async proxyCloudGet(path: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    if (!this.sessionToken) {
      return { ok: false, error: 'Not connected to cloud' };
    }

    try {
      const response = await fetch(`${this.config.cloudUrl}${path}`, {
        headers: {
          'Authorization': `Bearer ${this.sessionToken}`,
        },
      });

      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
    }
  }

  /**
   * Proxy a POST request to the cloud API with session auth.
   * Used for cross-environment Sequential step dispatch.
   */
  async proxyCloudPost(path: string, body: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    if (!this.sessionToken) {
      return { ok: false, error: 'Not connected to cloud' };
    }

    try {
      const response = await fetch(`${this.config.cloudUrl}${path}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
    }
  }

  /**
   * Graceful disconnect — notifies cloud, cancels pending commands.
   */
  async disconnect(): Promise<void> {
    if (!this.sessionToken) return;

    try {
      await fetch(`${this.config.cloudUrl}/api/local-runtime/disconnect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.sessionToken}`,
        },
      });
      logger.info('[ControlPlane] Disconnected gracefully');
    } catch (err) {
      logger.error(`[ControlPlane] Disconnect error: ${err}`);
    }

    this.stop();
  }

  // ==========================================================================
  // PRIVATE
  // ==========================================================================

  private async handleReplaced(sameDevice = false): Promise<void> {
    if (this.replaced) return;
    this.replaced = true;

    this.stop();

    // Only write the marker when a *different* device took over.
    // Same-device replacement (restart, crash recovery) is benign — the TUI
    // should be free to respawn the daemon immediately.
    if (!sameDevice) {
      const dataDir = dirname(this.config.dbPath);
      writeReplacedMarker(dataDir);
    }

    // TUI mode: emit event so UI can show the replacement notice
    if (this.emitter) {
      this.emitter.emit('cloud:replaced', { sameDevice });
      return;
    }

    // Headless mode: log and exit
    if (sameDevice) {
      logger.warn('');
      logger.warn('[ControlPlane] Replaced by a new session on this device. Shutting down...');
      logger.warn('');
    } else {
      logger.warn('');
      logger.warn('⚠️  This runtime has been replaced by another device.');
      logger.warn('   Finishing in-flight tasks, then shutting down...');
      logger.warn('');
    }

    if (this.callbacks.onReplaced) {
      await this.callbacks.onReplaced();
    }

    process.exit(0);
  }

  private async pollLoop(): Promise<void> {
    let backoff = 1000;
    const maxBackoff = 30_000;
    let consecutiveAuthFailures = 0;

    while (this.polling) {
      try {
        if (!this.sessionToken) {
          // Try reconnecting
          await this.connect();
        }

        const response = await fetch(
          `${this.config.cloudUrl}/api/local-runtime/poll`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.sessionToken}`,
            },
            body: JSON.stringify({ lastSequence: this.lastSequence }),
            signal: AbortSignal.timeout(30_000), // 30s timeout (server holds for 25s)
          },
        );

        if (response.status === 401) {
          const body = await response.json().catch(() => ({}));
          consecutiveAuthFailures++;
          if (consecutiveAuthFailures >= 5) {
            logger.warn('[ControlPlane] 5 auth failures, cooling down for 5 minutes...');
            if (this.emitter) {
              this.emitter.emit('cloud:error', { error: 'Auth failed, retrying in 5 minutes' });
            }
            await this.sleep(300_000); // 5 minutes
            consecutiveAuthFailures = 0;
            this.sessionToken = null; // Force reconnect
            continue;
          }
          logger.warn(`[ControlPlane] Poll auth failed (${consecutiveAuthFailures}/5): ${JSON.stringify(body)}`);
          this.sessionToken = null;
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, maxBackoff);
          continue;
        }

        if (!response.ok) {
          throw new Error(`Poll failed: ${response.status}`);
        }

        const data = await response.json() as PollResponse;

        // Check for replaced signal
        if (data.signal === 'replaced') {
          await this.handleReplaced(data.sameDevice ?? false);
          return;
        }

        // Track sequence for next poll
        if (data.lastSequence != null) {
          this.lastSequence = data.lastSequence;
        }

        // Process messages (skip stale commands older than 1 hour)
        const COMMAND_TTL_MS = 60 * 60 * 1000;
        for (const msg of data.messages) {
          if (msg.createdAt) {
            const age = Date.now() - new Date(msg.createdAt).getTime();
            if (age > COMMAND_TTL_MS) {
              logger.warn(`[ControlPlane] Skipping stale command ${msg.commandType} (${Math.round(age / 60000)}m old)`);
              continue;
            }
          }
          await this.handleCommand(msg);
        }

        // Reset backoff on success
        backoff = 1000;
        consecutiveAuthFailures = 0;
      } catch (err) {
        if (!this.polling) break;

        // Timeout is normal for long-poll
        if (err instanceof Error && err.name === 'TimeoutError') {
          continue;
        }

        logger.error(`[ControlPlane] Poll error: ${err}`);
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, maxBackoff);
      }
    }
  }

  private async handleCommand(msg: PollMessage): Promise<void> {
    logger.info(`[ControlPlane] Command: ${msg.commandType} (seq: ${msg.sequenceNumber})`);

    switch (msg.commandType) {
      case 'task_dispatch': {
        const { agentId, taskId, task, ...rest } = msg.payload as {
          agentId: string;
          taskId: string;
          task?: { title: string; description?: string; input?: string; priority?: string; status?: string; goal_id?: string; goal_context?: string };
        };
        // Sync task to local SQLite before dispatching so the engine can find it
        if (task) {
          await this.syncTaskToLocal(taskId, agentId, task);
        }
        this.callbacks.onTaskDispatch(agentId, taskId, rest);
        break;
      }
      case 'config_sync': {
        const { agents } = msg.payload as { agents: AgentConfigPayload[] };
        this.callbacks.onConfigSync(agents);
        break;
      }
      case 'task_cancel': {
        const { taskId } = msg.payload as { taskId: string };
        this.callbacks.onTaskCancel(taskId);
        break;
      }
      case 'webhook_relay': {
        const relayPayload: WebhookRelayPayload = {
          webhookType: msg.payload.webhookType as 'ghl' | 'custom',
          webhookToken: msg.payload.webhookToken as string | undefined,
          rawBody: msg.payload.rawBody as string,
          headers: msg.payload.headers as Record<string, string>,
        };
        if (this.callbacks.onWebhookRelay) {
          this.callbacks.onWebhookRelay(relayPayload);
        } else {
          logger.warn('[ControlPlane] Received webhook_relay but no handler registered');
        }
        break;
      }
      case 'workflow_execute': {
        const { workflowId, variables } = msg.payload as {
          workflowId: string;
          variables?: Record<string, unknown>;
        };
        if (this.callbacks.onWorkflowExecute) {
          this.callbacks.onWorkflowExecute(workflowId, variables);
        } else {
          logger.warn('[ControlPlane] Received workflow_execute but no handler registered');
        }
        break;
      }
      case 'desktop_emergency_stop': {
        logger.warn('[ControlPlane] Desktop emergency stop command received');
        if (this.callbacks.onDesktopEmergencyStop) {
          this.callbacks.onDesktopEmergencyStop();
        } else {
          logger.warn('[ControlPlane] No desktop emergency stop handler registered');
        }
        break;
      }
      case 'presence_event': {
        const presencePayload = msg.payload as unknown as PresenceEventPayload;
        if (this.callbacks.onPresenceEvent) {
          this.callbacks.onPresenceEvent(presencePayload);
        } else {
          logger.warn('[ControlPlane] Received presence_event but no handler registered');
        }
        break;
      }
      case 'sequence_step_dispatch': {
        const stepPayload = msg.payload as {
          stepId: string;
          agentId: string;
          taskInput: string;
          sequenceRunId?: string;
          predecessorContext?: string;
        };
        // Sequence steps reuse the task_dispatch pathway
        // Create a task and dispatch like a regular agent task
        const stepTask = {
          title: `[Sequence Step] ${stepPayload.stepId}`,
          input: stepPayload.taskInput,
          status: 'pending',
        };
        const stepTaskId = `seq_step_${stepPayload.stepId}_${Date.now()}`;
        await this.syncTaskToLocal(stepTaskId, stepPayload.agentId, stepTask);
        this.callbacks.onTaskDispatch(stepPayload.agentId, stepTaskId, {
          source: 'sequence_step',
          sequenceRunId: stepPayload.sequenceRunId,
        });
        break;
      }
      case 'runtime_replaced': {
        // runtime_replaced is only queued during a different-device force-connect,
        // so sameDevice is always false here. Explicit for clarity.
        await this.handleReplaced(false);
        break;
      }
      default:
        logger.warn(`[ControlPlane] Unknown command: ${msg.commandType}`);
    }
  }

  /**
   * Verify the Cloudflare tunnel is reachable by hitting its /health endpoint.
   * Returns true if the tunnel responds with an OK status, false otherwise.
   */
  private async checkTunnelHealth(): Promise<boolean> {
    if (!this.tunnelUrl) return false;

    try {
      const response = await fetch(`${this.tunnelUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.sessionToken) return;

    const uptimeSeconds = Math.round((Date.now() - this.startTime) / 1000);

    // System RAM metrics (not Node heap)
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memoryPercent = Math.round((usedMem / totalMem) * 100);
    const totalMemoryGb = Math.round((totalMem / (1024 ** 3)) * 10) / 10;
    const usedMemoryGb = Math.round((usedMem / (1024 ** 3)) * 10) / 10;
    const freeMemoryGb = Math.round((freeMem / (1024 ** 3)) * 10) / 10;

    // GPU/VRAM metrics (cached, refreshed every 5 min)
    const vramInfo = await getVramInfo();

    // Fleet sensing (battery, power, network, user presence — cached 30s)
    const fleetSensing = await getFleetSensingData();

    // Get local model summaries if monitor is available
    let localModels: LocalModelSummary[] | undefined;
    if (this.ollamaMonitor) {
      try {
        const summaries = await this.ollamaMonitor.getModelSummaries();
        localModels = summaries.map(s => ({
          modelName: s.modelName,
          status: s.status,
          processor: s.processor,
          family: s.family,
          totalRequests: s.totalRequests,
          totalInputTokens: s.totalInputTokens,
          totalOutputTokens: s.totalOutputTokens,
          avgDurationMs: s.avgDurationMs,
        }));
      } catch {
        // Non-critical
      }
    }

    // Verify tunnel health before reporting it
    const tunnelHealthy = this.tunnelUrl ? await this.checkTunnelHealth() : undefined;

    const payload: HeartbeatPayload = {
      uptimeSeconds,
      cpuPercent: this.getCpuPercent(),
      memoryPercent,
      totalMemoryGb,
      usedMemoryGb,
      freeMemoryGb,
      ...(vramInfo ? {
        totalVramGb: vramInfo.totalGb,
        usedVramGb: vramInfo.usedGb,
        freeVramGb: vramInfo.freeGb,
      } : {}),
      dbSizeMb: this.getDbSizeMb(),
      totalTasksExecuted: 0,
      totalTokensUsed: 0,
      activeTaskCount: 0,
      ...(this.tunnelUrl ? { tunnelUrl: this.tunnelUrl, tunnelHealthy } : {}),
      ...(localModels && localModels.length > 0 ? { localModels } : {}),
      browserAvailable: true,
      desktopAvailable: process.platform === 'darwin',
      desktopSessionActive: this._desktopSessionActive,
      desktopActiveAgentId: this._desktopActiveAgentId ?? undefined,
      ...fleetSensing,
    };

    // Try to get stats from DB
    try {
      const { count: totalCount } = await this.db
        .from('agent_workforce_tasks')
        .select('*', { count: 'exact', head: true });

      const { count: activeCount } = await this.db
        .from('agent_workforce_tasks')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'in_progress');

      payload.totalTasksExecuted = totalCount ?? 0;
      payload.activeTaskCount = activeCount ?? 0;

      // Sum tokens from completed tasks
      const { data: tokenData } = await this.db
        .from('agent_workforce_tasks')
        .select('total_tokens');

      if (tokenData) {
        const rows = tokenData as Array<{ total_tokens: number | null }>;
        payload.totalTokensUsed = rows.reduce((sum, r) => sum + (r.total_tokens || 0), 0);
      }
    } catch {
      // Stats not critical
    }

    const response = await fetch(`${this.config.cloudUrl}/api/local-runtime/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.sessionToken}`,
      },
      body: JSON.stringify(payload),
    });

    // Handle replaced signal from heartbeat
    if (response.status === 410) {
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (data.signal === 'replaced') {
        await this.handleReplaced(!!data.sameDevice);
      }
    }

    // Sync session metadata every 5th heartbeat (~75s)
    this.heartbeatCount++;
    if (this.heartbeatCount % 5 === 0) {
      this.syncSessionMetadata().catch(() => {});
      this.syncConversations().catch(() => {});
      this.syncManifest().catch(() => {});
    }

    // Sync memories every 10th heartbeat (~150s)
    if (this.heartbeatCount % 10 === 0) {
      this.syncMemories().catch(() => {});
    }

    // Sync consciousness items every 3rd heartbeat (~45s)
    if (this.consciousnessBridge && this.heartbeatCount % 3 === 0) {
      this.syncConsciousness().catch(() => {});
    }

    // Sync BPP state every 6th heartbeat (~90s)
    if (this.bppModules && this.heartbeatCount % 6 === 0) {
      this.syncBpp().catch(() => {});
    }

    // Piggyback drain on successful heartbeats
    this.drainOutboundQueue().catch(() => {});
  }

  /**
   * Bidirectional consciousness sync:
   * 1. Send unsynced local items to cloud
   * 2. Receive cloud items and merge locally
   */
  private async syncConsciousness(): Promise<void> {
    if (!this.consciousnessBridge || !this.sessionToken) return;

    try {
      // Outbound: send unsynced local items
      const unsynced = await this.consciousnessBridge.getUnsyncedItems();
      if (unsynced.length > 0) {
        const response = await fetch(`${this.config.cloudUrl}/api/local-runtime/consciousness`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.sessionToken}`,
          },
          body: JSON.stringify({ items: unsynced }),
        });

        if (response.ok) {
          await this.consciousnessBridge.markSynced(unsynced.map(i => i.id));
          logger.debug({ count: unsynced.length }, '[ControlPlane] Consciousness items synced to cloud');
        }

        // Inbound: cloud may return its own items in the response
        const data = await response.json().catch(() => ({})) as Record<string, unknown>;
        const cloudItems = data.items as CloudConsciousnessItem[] | undefined;
        if (cloudItems && cloudItems.length > 0) {
          await this.consciousnessBridge.mergeCloudItems(cloudItems);
        }
      }
    } catch (err) {
      logger.debug({ err }, '[ControlPlane] Consciousness sync failed');
    }
  }

  /**
   * Send BPP state summary to cloud for cross-environment awareness.
   * Lightweight sync: endocrine tone, immune level, narratives, habits, moral profile.
   */
  private async syncBpp(): Promise<void> {
    if (!this.bppModules || !this.sessionToken) return;

    try {
      const payload: Record<string, unknown> = {};

      // Endocrine tone
      if (this.bppModules.endocrine) {
        const profile = this.bppModules.endocrine.getProfile();
        payload.endocrineTone = profile.overallTone;
      }

      // Immune alert level
      if (this.bppModules.immune) {
        const state = this.bppModules.immune.getInflammatoryState();
        payload.immuneAlertLevel = state.alertLevel;
      }

      // Active narrative episodes
      if (this.bppModules.narrative) {
        const state = this.bppModules.narrative.getState();
        payload.activeNarrativeEpisodes = state.activeEpisodes.map(ep => ep.title);
      }

      // Habit library (top 10 by strength)
      if (this.bppModules.habits) {
        const habits = this.bppModules.habits.getHabits();
        payload.habits = habits
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 10)
          .map(h => ({
            name: h.name,
            cue: h.cue,
            routine: h.routine,
            reward: h.reward,
            strength: h.strength,
            automaticity: h.automaticity,
          }));
      }

      // Moral profile
      if (this.bppModules.ethics) {
        const profile = this.bppModules.ethics.getMoralProfile();
        payload.moralProfile = {
          stage: profile.stage,
          consistencyScore: profile.consistencyScore,
        };
      }

      // Only sync if there's something to send
      const hasData = Object.keys(payload).length > 0;
      if (!hasData) return;

      await fetch(`${this.config.cloudUrl}/api/local-runtime/bpp-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.sessionToken}`,
        },
        body: JSON.stringify(payload),
      });

      logger.debug({ tone: payload.endocrineTone, immune: payload.immuneAlertLevel }, '[ControlPlane] BPP state synced to cloud');
    } catch (err) {
      logger.debug({ err }, '[ControlPlane] BPP sync failed');
    }
  }

  private async syncAgentConfigs(agents: AgentConfigPayload[]): Promise<void> {
    // Batch: fetch all existing IDs in one query per table to avoid N check queries
    const agentIds = agents.map(a => a.id);

    const { data: existingConfigs } = await this.db
      .from('local_agent_configs')
      .select('id')
      .in('id', agentIds);
    const existingConfigIds = new Set(
      ((existingConfigs || []) as Array<{ id: string }>).map(r => r.id)
    );

    const { data: existingAgents } = await this.db
      .from('agent_workforce_agents')
      .select('id')
      .in('id', agentIds);
    const existingAgentIds = new Set(
      ((existingAgents || []) as Array<{ id: string }>).map(r => r.id)
    );

    const now = new Date().toISOString();

    // Load existing configs to detect desktop_enabled changes
    const { data: existingFullConfigs } = await this.db
      .from('local_agent_configs')
      .select('id, config')
      .in('id', agentIds);
    const existingConfigMap = new Map<string, Record<string, unknown>>();
    for (const row of (existingFullConfigs || []) as Array<{ id: string; config: string }>) {
      try {
        existingConfigMap.set(row.id, typeof row.config === 'string' ? JSON.parse(row.config) : row.config as Record<string, unknown>);
      } catch { /* skip */ }
    }

    for (const agent of agents) {
      // Desktop confirmation: if desktop_enabled changed to true, check local confirmation
      const prevConfig = existingConfigMap.get(agent.id);
      const prevDesktopEnabled = (prevConfig as Record<string, unknown> | undefined)?.desktop_enabled === true;
      const newDesktopEnabled = agent.config.desktop_enabled === true;

      if (newDesktopEnabled && !prevDesktopEnabled) {
        // Desktop was just enabled from cloud — emit event for TUI confirmation
        logger.info({ agentId: agent.id, agentName: agent.name }, '[ControlPlane] Desktop enabled for agent, awaiting local confirmation');
        if (this.callbacks.onDesktopConfirmationRequired) {
          this.callbacks.onDesktopConfirmationRequired(agent.id, agent.name);
        }
        // Override: keep desktop_enabled as false locally until confirmed
        agent.config.desktop_enabled = false;
      }

      const configPayload = {
        name: agent.name,
        role: agent.role,
        description: agent.description || null,
        system_prompt: agent.systemPrompt,
        config: JSON.stringify(agent.config),
        memory_sync_policy: agent.memorySyncPolicy || 'none',
      };

      // Upsert into local_agent_configs
      if (existingConfigIds.has(agent.id)) {
        await this.db.from('local_agent_configs').update({
          ...configPayload,
          synced_at: now,
        }).eq('id', agent.id);
      } else {
        await this.db.from('local_agent_configs').insert({
          id: agent.id,
          workspace_id: this.workspaceId!,
          ...configPayload,
        });
      }

      // Upsert into agent_workforce_agents
      if (existingAgentIds.has(agent.id)) {
        await this.db.from('agent_workforce_agents').update({
          ...configPayload,
          updated_at: now,
        }).eq('id', agent.id);
      } else {
        await this.db.from('agent_workforce_agents').insert({
          id: agent.id,
          workspace_id: this.workspaceId!,
          ...configPayload,
          status: 'idle',
          stats: '{}',
        });
      }

      // Sync file access paths if provided
      if (agent.fileAccessPaths) {
        await this.db.from('agent_file_access_paths')
          .delete()
          .eq('agent_id', agent.id)
          .eq('workspace_id', this.workspaceId!);

        // Batch insert all paths for this agent
        for (const p of agent.fileAccessPaths) {
          await this.db.from('agent_file_access_paths').insert({
            agent_id: agent.id,
            workspace_id: this.workspaceId!,
            path: p.path,
            label: p.label || null,
          });
        }
      }
    }
  }

  /**
   * Import memories received from cloud during connect.
   * Performs dedup check to avoid re-inserting memories that already exist locally.
   */
  private async syncMemoriesFromCloud(
    memoriesByAgent: Record<string, MemorySyncPayload[]>,
  ): Promise<void> {
    let totalImported = 0;

    for (const [agentId, memories] of Object.entries(memoriesByAgent)) {
      if (!memories || memories.length === 0) continue;

      // Get existing memory contents for this agent to dedup
      const { data: existingData } = await this.db
        .from('agent_workforce_agent_memory')
        .select('id, content')
        .eq('agent_id', agentId)
        .eq('is_active', 1);

      const existingContents = new Set(
        ((existingData || []) as Array<{ content: string }>).map(
          (m) => m.content.toLowerCase().trim(),
        ),
      );

      for (const mem of memories) {
        // Skip if already exists locally (exact match)
        if (existingContents.has(mem.content.toLowerCase().trim())) {
          continue;
        }

        try {
          await this.db.from('agent_workforce_agent_memory').insert({
            id: mem.id,
            agent_id: agentId,
            workspace_id: this.workspaceId!,
            memory_type: mem.memoryType,
            content: mem.content,
            source_type: mem.sourceType,
            relevance_score: mem.relevanceScore,
            times_used: mem.timesUsed,
            token_count: mem.tokenCount,
            trust_level: mem.trustLevel,
            confidentiality_level: mem.confidentialityLevel,
            source_device_id: mem.sourceDeviceId || null,
            is_active: 1,
            is_local_only: 0,
          });
          existingContents.add(mem.content.toLowerCase().trim());
          totalImported++;
        } catch {
          // Likely duplicate ID, skip
        }
      }
    }

    if (totalImported > 0) {
      logger.info(`[ControlPlane] Imported ${totalImported} memories from cloud`);
    }
  }

  /**
   * Sync agent state from cloud for multi-device continuity.
   * Cloud wins when its updatedAt is newer than local; local wins otherwise.
   */
  private async syncStateFromCloud(
    byAgent: Record<string, StateSyncEntry[]>,
  ): Promise<void> {
    let totalImported = 0;

    for (const [agentId, entries] of Object.entries(byAgent)) {
      if (!entries || entries.length === 0) continue;

      for (const entry of entries) {
        try {
          // Check if key exists locally
          const { data: existing } = await this.db
            .from('agent_workforce_task_state')
            .select('id, updated_at')
            .eq('workspace_id', this.workspaceId!)
            .eq('agent_id', agentId)
            .eq('scope', entry.scope)
            .eq('key', entry.key)
            .maybeSingle();

          if (existing) {
            const local = existing as { id: string; updated_at: string };
            // Cloud wins only if its data is newer
            if (entry.updatedAt > local.updated_at) {
              await this.db
                .from('agent_workforce_task_state')
                .update({
                  value: entry.value,
                  value_type: entry.valueType,
                  updated_at: entry.updatedAt,
                })
                .eq('id', local.id);
              totalImported++;
            }
          } else {
            // Insert new entry from cloud
            const { randomUUID } = await import('node:crypto');
            await this.db
              .from('agent_workforce_task_state')
              .insert({
                id: randomUUID(),
                workspace_id: this.workspaceId!,
                agent_id: agentId,
                scope: entry.scope,
                scope_id: entry.scopeId || null,
                key: entry.key,
                value: entry.value,
                value_type: entry.valueType,
                created_at: entry.updatedAt,
                updated_at: entry.updatedAt,
              });
            totalImported++;
          }
        } catch {
          // Non-fatal: skip individual entries that fail
        }
      }
    }

    if (totalImported > 0) {
      logger.info(`[ControlPlane] Synced ${totalImported} state entries from cloud`);
    }
  }

  private async syncTaskToLocal(
    taskId: string,
    agentId: string,
    task: { title: string; description?: string; input?: string; priority?: string; status?: string; goal_id?: string; goal_context?: string },
  ): Promise<void> {
    try {
      const { data: existing } = await this.db
        .from('agent_workforce_tasks')
        .select('id')
        .eq('id', taskId)
        .maybeSingle();

      const now = new Date().toISOString();

      if (existing) {
        await this.db.from('agent_workforce_tasks').update({
          title: task.title,
          description: task.description || null,
          input: task.input || null,
          priority: task.priority || 'normal',
          status: task.status || 'pending',
          goal_id: task.goal_id || null,
          updated_at: now,
        }).eq('id', taskId);
      } else {
        await this.db.from('agent_workforce_tasks').insert({
          id: taskId,
          workspace_id: this.workspaceId!,
          agent_id: agentId,
          title: task.title,
          description: task.description || null,
          input: task.input || null,
          priority: task.priority || 'normal',
          status: task.status || 'pending',
          goal_id: task.goal_id || null,
          created_at: now,
          updated_at: now,
        });
      }

      // If a goal_id was dispatched, ensure the goal exists locally
      if (task.goal_id && task.goal_context) {
        const { data: existingGoal } = await this.db
          .from('agent_workforce_goals')
          .select('id')
          .eq('id', task.goal_id)
          .maybeSingle();

        if (!existingGoal) {
          // Create a minimal local goal record for prompt injection
          await this.db.from('agent_workforce_goals').insert({
            id: task.goal_id,
            workspace_id: this.workspaceId!,
            title: task.goal_context,
            status: 'active',
            priority: 'normal',
            color: '#6366f1',
            position: 0,
            created_at: now,
            updated_at: now,
          });
        }
      }

      logger.info(`[ControlPlane] Synced task ${taskId} ("${task.title}") to local DB`);
    } catch (err) {
      logger.error(`[ControlPlane] Failed to sync task ${taskId} to local DB: ${err}`);
    }
  }

  private heartbeatCount = 0;

  /**
   * Sync recent session metadata to cloud for offline visibility.
   * Sends titles, message counts, and device names (no message content).
   */
  private async syncSessionMetadata(): Promise<void> {
    try {
      const { data } = await this.db
        .from('orchestrator_chat_sessions')
        .select('id, title, message_count, device_name, target_type, target_id, updated_at')
        .order('updated_at', { ascending: false })
        .limit(20);

      if (!data || (data as unknown[]).length === 0) return;

      const sessionsPayload = { sessions: data };
      try {
        const response = await fetch(`${this.config.cloudUrl}/api/local-runtime/sync-sessions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.sessionToken}`,
          },
          body: JSON.stringify(sessionsPayload),
        });
        if (!response.ok) {
          await this.outboundQueue.enqueue('session_sync', sessionsPayload);
        }
      } catch {
        await this.outboundQueue.enqueue('session_sync', sessionsPayload);
      }
    } catch {
      // DB query failed, nothing to enqueue
    }
  }

  private lastConversationSyncAt: string | null = null;

  /**
   * Sync conversations (metadata + messages) to cloud.
   * Sends conversations updated since last sync.
   */
  private async syncConversations(): Promise<void> {
    try {
      // Get recently updated conversations (exclude device-pinned and sealed)
      let query = this.db
        .from('orchestrator_conversations')
        .select('id, title, source, channel, message_count, last_message_at')
        .eq('locality_policy', 'sync')
        .order('last_message_at', { ascending: false })
        .limit(10);

      if (this.lastConversationSyncAt) {
        query = query.gt('last_message_at', this.lastConversationSyncAt);
      }

      const { data: conversations } = await query;
      if (!conversations || (conversations as unknown[]).length === 0) return;

      // For each conversation, get new messages
      const syncPayload: Array<Record<string, unknown>> = [];

      for (const conv of conversations as Array<{
        id: string; title: string | null; source: string; channel: string | null;
        message_count: number; last_message_at: string;
      }>) {
        const { data: messages } = await this.db
          .from('orchestrator_messages')
          .select('id, role, content, model, created_at')
          .eq('conversation_id', conv.id)
          .order('created_at', { ascending: true })
          .limit(50); // Last 50 messages per conversation, chronological order

        syncPayload.push({
          id: conv.id,
          title: conv.title,
          source: conv.source,
          channel: conv.channel,
          message_count: conv.message_count,
          last_message_at: conv.last_message_at,
          messages: messages ?? [],
        });
      }

      try {
        const response = await fetch(`${this.config.cloudUrl}/api/local-runtime/sync-conversations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.sessionToken}`,
          },
          body: JSON.stringify({ conversations: syncPayload }),
        });

        if (response.ok) {
          this.lastConversationSyncAt = new Date().toISOString();
        } else {
          await this.outboundQueue.enqueue('conversation_sync', { conversations: syncPayload });
        }
      } catch {
        await this.outboundQueue.enqueue('conversation_sync', { conversations: syncPayload });
      }
    } catch {
      // DB query failed
    }
  }

  private lastMemorySyncAt: string | null = null;
  private lastManifestSyncAt: string | null = null;

  /**
   * Bidirectional memory sync with cloud.
   * Pushes locally extracted memories, pulls cloud memories from other devices.
   */
  private async syncMemories(): Promise<void> {
    try {
      // Get unsynced memories (active, not local-only, not secret, not device-pinned/sealed)
      let query = this.db
        .from('agent_workforce_agent_memory')
        .select('id, agent_id, memory_type, content, source_type, relevance_score, times_used, token_count, trust_level, confidentiality_level, source_conversation_id, created_at, updated_at')
        .eq('is_active', 1)
        .eq('is_local_only', 0)
        .eq('locality_policy', 'sync')
        .not('confidentiality_level', 'eq', 'secret')
        .order('updated_at', { ascending: false })
        .limit(50);

      if (this.lastMemorySyncAt) {
        query = query.gt('updated_at', this.lastMemorySyncAt);
      }

      const { data: memories } = await query;

      const memoryPayload = ((memories ?? []) as Array<Record<string, unknown>>).map(m => ({
        id: m.id,
        agentId: m.agent_id,
        memoryType: m.memory_type,
        content: m.content,
        sourceType: m.source_type,
        relevanceScore: m.relevance_score,
        timesUsed: m.times_used,
        tokenCount: m.token_count,
        trustLevel: m.trust_level,
        confidentialityLevel: m.confidentiality_level,
        sourceConversationId: m.source_conversation_id,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
      }));

      try {
        const response = await fetch(`${this.config.cloudUrl}/api/local-runtime/sync-memories`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.sessionToken}`,
          },
          body: JSON.stringify({
            memories: memoryPayload,
            lastSyncAt: this.lastMemorySyncAt,
          }),
        });

        if (response.ok) {
          const result = await response.json() as {
            accepted: number;
            cloudMemories: Array<Record<string, unknown>>;
          };

          // Import cloud memories locally
          if (result.cloudMemories?.length > 0) {
            await this.importCloudMemories(result.cloudMemories);
          }

          this.lastMemorySyncAt = new Date().toISOString();
        }
      } catch {
        // Network failure, will retry next cycle
      }
    } catch {
      // DB query failed
    }
  }

  /**
   * Import memories from cloud into local database.
   * Deduplicates by content similarity.
   */
  private async importCloudMemories(cloudMemories: Array<Record<string, unknown>>): Promise<void> {
    if (!this.connectedWorkspaceId) return;

    // Load existing memories once for batch dedup
    const { data: recentLocal } = await this.db
      .from('agent_workforce_agent_memory')
      .select('id, content')
      .eq('is_active', 1)
      .order('created_at', { ascending: false })
      .limit(200);
    const localMemories = (recentLocal ?? []) as Array<{ id: string; content: string }>;
    const localIds = new Set(localMemories.map(m => m.id));

    for (const mem of cloudMemories) {
      // Check if already exists locally (by ID or content prefix)
      if (localIds.has(mem.id as string)) continue;

      const contentLower = (mem.content as string).toLowerCase().trim();
      const isDuplicate = localMemories
        .some(local => local.content.toLowerCase().trim().startsWith(contentLower.slice(0, 50)));
      if (isDuplicate) continue;

      await this.db.from('agent_workforce_agent_memory').insert({
        id: mem.id,
        agent_id: mem.agentId ?? null,
        workspace_id: this.connectedWorkspaceId!,
        memory_type: mem.memoryType,
        content: mem.content,
        source_type: mem.sourceType,
        source_conversation_id: mem.sourceConversationId ?? null,
        relevance_score: mem.relevanceScore ?? 0.5,
        times_used: mem.timesUsed ?? 0,
        token_count: mem.tokenCount ?? 0,
        trust_level: mem.trustLevel ?? 'inferred',
        is_active: 1,
        confidentiality_level: mem.confidentialityLevel ?? 'workspace',
        source_device_id: (mem as Record<string, unknown>).sourceDeviceId ?? 'cloud',
        is_local_only: 0,
      });

      // Track for dedup within this batch
      localIds.add(mem.id as string);
      localMemories.push({ id: mem.id as string, content: mem.content as string });
    }
  }

  /**
   * Sync device-pinned data manifest to cloud.
   * Pushes local manifest entries, receives entries from other devices.
   */
  private async syncManifest(): Promise<void> {
    try {
      const { data } = await this.db
        .from('device_data_manifest')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (!data || (data as unknown[]).length === 0) return;

      const response = await fetch(`${this.config.cloudUrl}/api/local-runtime/sync-manifest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.sessionToken}`,
        },
        body: JSON.stringify({
          entries: data,
          deviceId: this.deviceId,
        }),
      });

      if (response.ok) {
        const result = await response.json() as {
          synced: number;
          otherDeviceEntries: Array<Record<string, unknown>>;
        };

        // Store other devices' manifest entries locally for offline lookup
        if (result.otherDeviceEntries?.length > 0 && this.connectedWorkspaceId) {
          for (const entry of result.otherDeviceEntries) {
            const dataId = (entry.dataId ?? entry.data_id) as string;
            const deviceId = (entry.deviceId ?? entry.device_id) as string;

            // Skip our own entries
            if (deviceId === this.deviceId) continue;

            const { data: existing } = await this.db
              .from('device_data_manifest')
              .select('id')
              .eq('data_id', dataId)
              .eq('device_id', deviceId)
              .maybeSingle();

            if (!existing) {
              await this.db.from('device_data_manifest').insert({
                id: crypto.randomUUID(),
                workspace_id: this.connectedWorkspaceId!,
                device_id: deviceId,
                data_type: entry.dataType ?? entry.data_type,
                data_id: dataId,
                title: entry.title,
                tags: typeof entry.tags === 'string' ? entry.tags : JSON.stringify(entry.tags ?? []),
                size_bytes: entry.sizeBytes ?? entry.size_bytes ?? 0,
                access_policy: entry.accessPolicy ?? entry.access_policy ?? 'ephemeral',
                requires_approval: (entry.requiresApproval ?? entry.requires_approval) ? 1 : 0,
                owner_user_id: entry.ownerUserId ?? entry.owner_user_id ?? null,
                pinned_at: entry.pinnedAt ?? entry.pinned_at ?? new Date().toISOString(),
                fetch_count: 0,
                created_at: new Date().toISOString(),
              });
            }
          }
        }

        this.lastManifestSyncAt = new Date().toISOString();
      }
    } catch {
      // Network failure, will retry next cycle
    }
  }

  /**
   * Compute CPU usage percentage since last call using os.cpus() delta.
   * Returns null on first call (no previous sample to compare against).
   */
  private getCpuPercent(): number | null {
    const cores = cpus();
    let idle = 0;
    let total = 0;
    for (const core of cores) {
      idle += core.times.idle;
      total += core.times.user + core.times.nice + core.times.sys + core.times.irq + core.times.idle;
    }

    if (!this.prevCpuTimes) {
      this.prevCpuTimes = { idle, total };
      return null;
    }

    const idleDelta = idle - this.prevCpuTimes.idle;
    const totalDelta = total - this.prevCpuTimes.total;
    this.prevCpuTimes = { idle, total };

    if (totalDelta === 0) return 0;
    return Math.round(((totalDelta - idleDelta) / totalDelta) * 100);
  }

  /**
   * Get the SQLite database file size in megabytes.
   */
  private getDbSizeMb(): number {
    try {
      const stats = statSync(this.config.dbPath);
      return Math.round((stats.size / (1024 * 1024)) * 100) / 100;
    } catch {
      return 0;
    }
  }

  /**
   * Drain the outbound queue, sending buffered reports to cloud.
   * Called after successful connect() and on each successful heartbeat.
   */
  private async drainOutboundQueue(): Promise<void> {
    if (!this.sessionToken) return;

    const pending = await this.outboundQueue.pendingCount();
    if (pending === 0) return;

    logger.info(`[ControlPlane] Draining outbound queue (${pending} pending)`);

    await this.outboundQueue.drain(async (type: OutboundQueueItem['type'], payload: string) => {
      if (type === 'task_report') {
        const response = await fetch(`${this.config.cloudUrl}/api/local-runtime/report`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.sessionToken}`,
          },
          body: payload,
        });
        return response.ok;
      }

      if (type === 'session_sync') {
        const response = await fetch(`${this.config.cloudUrl}/api/local-runtime/sync-sessions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.sessionToken}`,
          },
          body: payload,
        });
        return response.ok;
      }

      logger.warn(`[OutboundQueue] Unknown queue item type: ${type}`);
      return false;
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
