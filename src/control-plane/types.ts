/**
 * Control Plane Protocol Types
 * Types for cloud ↔ runtime communication.
 * These mirror the types in src/lib/local-runtime/types.ts on the cloud side.
 */

// ============================================================================
// CONNECT
// ============================================================================

export interface DeviceCapabilities {
  totalMemoryGb: number;
  cpuCores: number;
  cpuModel: string;
  isAppleSilicon: boolean;
  hasNvidiaGpu: boolean;
  gpuName?: string;
  memoryTier: 'tiny' | 'small' | 'medium' | 'large' | 'xlarge';
  desktopControlAvailable?: boolean;
}

export interface ConnectRequest {
  licenseKey: string;
  runtimeVersion: string;
  hostname: string;
  osPlatform: string;
  nodeVersion: string;
  localUrl: string;
  machineId?: string;
  deviceCapabilities?: DeviceCapabilities;
  force?: boolean;
  acknowledgeMemoryLoss?: boolean;
}

export interface AgentConfigPayload {
  id: string;
  name: string;
  role: string;
  description?: string;
  systemPrompt: string;
  config: {
    model: string;
    temperature: number;
    max_tokens: number;
    approval_required: boolean;
    web_search_enabled: boolean;
    local_files_enabled?: boolean;
    bash_enabled?: boolean;
    desktop_enabled?: boolean;
    desktop_allowed_apps?: string[];
  };
  fileAccessPaths?: Array<{ path: string; label?: string }>;
  /** Per-agent memory sync policy. Controls which memory types can leave the device. */
  memorySyncPolicy?: MemorySyncPolicy;
}

export interface ConnectResponse {
  sessionToken: string;
  workspaceId: string;
  deviceId: string;
  agents: AgentConfigPayload[];
  businessContext: {
    businessName: string;
    businessType: string;
    businessDescription?: string;
  };
  contentPublicKey?: JsonWebKey;
  /** Plan tier for the workspace, used to set runtime feature gates. */
  planTier?: 'starter' | 'pro' | 'enterprise';
  /** Synced memories from cloud, included when memory sync is enabled. */
  memories?: ConnectMemories;
  /** Whether memory sync is enabled for this workspace. */
  memorySyncEnabled?: boolean;
  /** Synced agent state from cloud, for multi-device state continuity. */
  stateSync?: ConnectStateSync;
}

export interface DeviceLimitResponse {
  error: 'device_limit';
  connectedDevices: Array<{
    id: string;
    hostname: string | null;
    deviceName: string | null;
    connectedAt: string | null;
    lastHeartbeat: string | null;
  }>;
  maxRuntimes: number;
}

export interface DeviceConflictResponse {
  conflict: 'device_change';
  currentDevice: {
    hostname: string | null;
    connectedAt: string | null;
    lastHeartbeat: string | null;
  };
  warning: string;
  requiresForce: boolean;
}

// ============================================================================
// POLL
// ============================================================================

export type CommandType = 'config_sync' | 'task_dispatch' | 'task_cancel' | 'runtime_replaced' | 'webhook_relay' | 'workflow_execute' | 'desktop_emergency_stop';

export interface PollMessage {
  id: string;
  commandType: CommandType;
  payload: Record<string, unknown>;
  sequenceNumber: number;
  createdAt?: string;
}

export interface PollResponse {
  messages: PollMessage[];
  lastSequence: number;
  signal?: 'replaced';
  reason?: string;
  sameDevice?: boolean;
}

// ============================================================================
// HEARTBEAT
// ============================================================================

/** Summary of a local model for heartbeat reporting */
export interface LocalModelSummary {
  modelName: string;
  status: 'loaded' | 'installed' | 'unavailable';
  processor: string | null;
  family: string | null;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgDurationMs: number | null;
}

export interface HeartbeatPayload {
  uptimeSeconds: number;
  cpuPercent?: number | null;
  memoryPercent: number;
  dbSizeMb: number;
  totalTasksExecuted: number;
  totalTokensUsed: number;
  activeTaskCount: number;
  tunnelUrl?: string;
  tunnelHealthy?: boolean;
  localModels?: LocalModelSummary[];
  /** Whether this runtime can handle browser sessions via /browser/* endpoints */
  browserAvailable?: boolean;
  /** Whether this runtime can handle desktop control (macOS only) */
  desktopAvailable?: boolean;
  /** Whether a desktop control session is currently active on this device */
  desktopSessionActive?: boolean;
  /** The agent ID currently using desktop control (if any) */
  desktopActiveAgentId?: string;
}

// ============================================================================
// TASK REPORT
// ============================================================================

export interface TaskReportPayload {
  runtimeTaskId: string;
  agentId: string;
  taskTitle: string;
  status: string;
  tokensUsed: number;
  costCents: number;
  durationSeconds?: number;
  modelUsed?: string;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  /** Memories extracted from this task, filtered by agent sync policy. Only sent when memory sync is enabled. */
  memories?: TaskReportMemories;
  /** State updates from this task, for cloud-side persistence and dashboard display. */
  stateUpdates?: TaskReportStateUpdate[];
  /** Goal progress increment triggered by this task completion. */
  goalProgress?: { goalId: string; newValue: number; completed: boolean };
}

/** A state update included in a task report for cloud sync. */
export interface TaskReportStateUpdate {
  key: string;
  value: string;
  valueType: string;
  scope: string;
  scopeId?: string;
}

// ============================================================================
// MEMORY SYNC
// ============================================================================

/** Confidentiality level for a memory entry (mirrors taint tracker labels). */
export type MemoryConfidentialityLevel = 'public' | 'workspace' | 'confidential' | 'secret';

/** Per-agent sync policy controlling which memories can leave the device. */
export type MemorySyncPolicy = 'none' | 'behavioral' | 'full';

/** Memory types considered "behavioral" (safe to sync by default). */
export const BEHAVIORAL_MEMORY_TYPES = ['skill', 'feedback_positive', 'feedback_negative', 'procedure', 'efficiency'] as const;

/** A memory payload for sync (upload to cloud or download to device). */
export interface MemorySyncPayload {
  /** Memory ID (UUID) */
  id: string;
  agentId: string;
  memoryType: string;
  content: string;
  sourceType: string;
  relevanceScore: number;
  timesUsed: number;
  tokenCount: number;
  trustLevel: string;
  confidentialityLevel: MemoryConfidentialityLevel;
  sourceDeviceId?: string;
  sourceAgentId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Memories included in a task report (uploaded after local execution). */
export interface TaskReportMemories {
  /** Memories extracted from this task, filtered by sync policy. */
  extracted: MemorySyncPayload[];
}

/** Memories included in ConnectResponse (downloaded on connect). */
export interface ConnectMemories {
  /** Per-agent memories from cloud, keyed by agent ID. */
  byAgent: Record<string, MemorySyncPayload[]>;
}

// ============================================================================
// STATE SYNC
// ============================================================================

/** State entries included in ConnectResponse for multi-device state continuity. */
export interface ConnectStateSync {
  byAgent: Record<string, StateSyncEntry[]>;
}

export interface StateSyncEntry {
  key: string;
  value: string;
  valueType: string;
  scope: string;
  scopeId: string;
  updatedAt: string;
}

// ============================================================================
// WEBHOOK RELAY
// ============================================================================

export interface WebhookRelayPayload {
  webhookType: 'ghl' | 'custom';
  webhookToken?: string;
  rawBody: string;
  headers: Record<string, string>;
}

// ============================================================================
// DEFERRED ACTION EXECUTION
// ============================================================================

export interface ExecuteDeferredActionRequest {
  taskId: string;
  deferredAction: { type: string; params: Record<string, unknown>; provider: string };
}

export interface ExecuteDeferredActionResponse {
  success: boolean;
  error?: string;
  result?: string;
}
