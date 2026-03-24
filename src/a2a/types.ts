/**
 * A2A Protocol Types (v0.3)
 * AUTO-GENERATED: Shared section synced from ohwow.fun/src/lib/a2a/types.ts
 * Do not edit the shared section manually. Run: ohwow.fun/scripts/sync-a2a-types.sh
 */


// ============================================================================
// SCOPES & TRUST LEVELS
// ============================================================================

export const A2A_SCOPES = [
  'tasks.read',
  'tasks.create',
  'tasks.cancel',
  'tasks.stream',
  'agents.read',
  'agents.list',
  'results.read',
  'results.files',
] as const;

export type A2AScope = (typeof A2A_SCOPES)[number];

export const A2A_TRUST_LEVELS = ['read_only', 'execute', 'autonomous', 'admin'] as const;
export type A2ATrustLevel = (typeof A2A_TRUST_LEVELS)[number];

export const TRUST_LEVEL_SCOPES: Record<A2ATrustLevel, A2AScope[]> = {
  read_only: ['agents.list', 'agents.read', 'tasks.read', 'results.read'],
  execute: ['agents.list', 'agents.read', 'tasks.read', 'tasks.create', 'results.read'],
  autonomous: ['agents.list', 'agents.read', 'tasks.read', 'tasks.create', 'tasks.cancel', 'results.read', 'results.files'],
  admin: [...A2A_SCOPES],
};

// ============================================================================
// A2A AGENT CARD (/.well-known/agent-card.json)
// ============================================================================

export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  authentication: {
    schemes: string[];
    credentials?: string;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2ASkill[];
}

export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

// ============================================================================
// A2A JSON-RPC 2.0
// ============================================================================

export interface A2AJsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: A2AMethod;
  params?: Record<string, unknown>;
}

export interface A2AJsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: A2AJsonRpcError;
}

export interface A2AJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type A2AMethod =
  | 'message/send'
  | 'message/sendStream'
  | 'tasks/get'
  | 'tasks/cancel'
  | 'tasks/pushNotification/set'
  | 'tasks/pushNotification/get';

// ============================================================================
// A2A TASK & MESSAGE
// ============================================================================

export type A2ATaskStatus = 'submitted' | 'working' | 'input-required' | 'completed' | 'canceled' | 'failed';

export interface A2ATask {
  id: string;
  sessionId?: string;
  status: {
    state: A2ATaskStatus;
    message?: A2AMessage;
    timestamp?: string;
  };
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

export interface A2AMessage {
  role: 'user' | 'agent';
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export type A2APart = A2ATextPart | A2AFilePart | A2ADataPart;

export interface A2ATextPart {
  type: 'text';
  text: string;
}

export interface A2AFilePart {
  type: 'file';
  file: {
    name?: string;
    mimeType?: string;
    bytes?: string; // base64
    uri?: string;
  };
}

export interface A2ADataPart {
  type: 'data';
  data: Record<string, unknown>;
}

export interface A2AArtifact {
  name?: string;
  description?: string;
  parts: A2APart[];
  index: number;
  append?: boolean;
  lastChunk?: boolean;
}

// ============================================================================
// A2A ERROR CODES
// ============================================================================

export const A2A_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  UNAUTHORIZED: -32003,
  RATE_LIMITED: -32004,
  AGENT_NOT_FOUND: -32005,
  SCOPE_INSUFFICIENT: -32006,
  PLAN_REQUIRED: -32007,
} as const;

// ============================================================================
// DATABASE TYPES (local SQLite shapes)
// ============================================================================

export type A2AConnectionAuthType = 'api_key' | 'oauth2' | 'bearer_token' | 'mtls' | 'none';
export type A2AConnectionStatus = 'pending' | 'active' | 'error' | 'suspended' | 'disconnected';

export interface DbA2AConnection {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  agent_card_url: string;
  endpoint_url: string;
  auth_type: A2AConnectionAuthType;
  auth_config: Record<string, unknown>;
  trust_level: A2ATrustLevel;
  store_results: boolean | number;
  result_retention_hours: number;
  allowed_data_types: string[];
  rate_limit_per_minute: number;
  rate_limit_per_hour: number;
  status: A2AConnectionStatus;
  last_health_check_at: string | null;
  last_health_status: string | null;
  consecutive_failures: number;
  agent_card_cache: A2AAgentCard | null;
  agent_card_fetched_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbA2ATaskLog {
  id: string;
  workspace_id: string;
  direction: 'inbound' | 'outbound';
  a2a_task_id: string;
  method: string;
  api_key_id: string | null;
  connection_id: string | null;
  agent_id: string | null;
  status: 'pending' | 'working' | 'completed' | 'failed' | 'cancelled';
  request_summary: string | null;
  result_summary: string | null;
  tokens_used: number;
  cost_cents: number;
  duration_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}
