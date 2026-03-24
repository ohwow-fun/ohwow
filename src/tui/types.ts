/**
 * TUI Types
 * Shared types for the terminal UI.
 */

export enum Screen {
  Dashboard = 'dashboard',
  Agents = 'agents',
  Tasks = 'tasks',
  Contacts = 'contacts',
  Approvals = 'approvals',
  Activity = 'activity',
  Settings = 'settings',
  Chat = 'chat',
  // Detail views
  AgentDetail = 'agent-detail',
  TaskDetail = 'task-detail',
  ContactDetail = 'contact-detail',
  TaskDispatch = 'task-dispatch',
  // Settings detail screens
  Schedules = 'schedules',
  Workflows = 'workflows',
  // A2A screens
  A2AConnections = 'a2a-connections',
  A2ASetup = 'a2a-setup',
  // Peer screens
  Peers = 'peers',
  // WhatsApp screens
  WhatsApp = 'whatsapp',
  WhatsAppSetup = 'whatsapp-setup',
  // Notifications
  Notifications = 'notifications',
  // Agent creation
  AgentCreate = 'agent-create',
  // Automations screens
  Automations = 'automations',
  AutomationDetail = 'automation-detail',
  AutomationCreate = 'automation-create',
  // Local model setup
  LocalModelSetup = 'local-model-setup',
  // Tunnel setup
  TunnelSetup = 'tunnel-setup',
  // License key setup
  LicenseKeySetup = 'license-key-setup',
  // GHL Webhook
  GhlWebhook = 'ghl-webhook',
  // Model Manager
  ModelManager = 'model-manager',
  // MCP screens
  McpServers = 'mcp-servers',
  McpServerSetup = 'mcp-server-setup',
  // Media gallery
  MediaGallery = 'media-gallery',
  // People management
  People = 'people',
  // Session management
  Sessions = 'sessions',
  // Device stats
  Device = 'device',
}

import type { RuntimeTier } from '../config.js';
import type { AgentId, WorkspaceId, TaskId, ContactId } from '../lib/branded-types.js';
import type { DiscoveredPeer } from '../peers/discovery.js';

export const TAB_SCREENS = [
  Screen.Dashboard,
  Screen.Agents,
  Screen.Tasks,
  Screen.Contacts,
  Screen.Approvals,
  Screen.Activity,
  Screen.Automations,
  Screen.Settings,
] as const;

/** Screens shown in the home grid menu (Chat is home, not a grid item). */
export const GRID_SCREENS = [
  Screen.Dashboard,
  Screen.Agents,
  Screen.Tasks,
  Screen.Contacts,
  Screen.Activity,
  Screen.Settings,
] as const;

/** Returns grid screens. Automations always included. */
export function getGridScreens(_tier?: RuntimeTier): Screen[] {
  const base = [...GRID_SCREENS] as Screen[];
  // Insert Automations before Settings
  const settingsIdx = base.indexOf(Screen.Settings);
  base.splice(settingsIdx, 0, Screen.Automations);
  return base;
}

/** Returns all tab screens. */
export function getTabScreens(_tier?: RuntimeTier): Screen[] {
  return [...TAB_SCREENS];
}

export const TAB_LABELS: Record<string, string> = {
  [Screen.Dashboard]: 'Dashboard',
  [Screen.Agents]: 'Agents',
  [Screen.Tasks]: 'Tasks',
  [Screen.Contacts]: 'Contacts',
  [Screen.Approvals]: 'Approvals',
  [Screen.Activity]: 'Activity',
  [Screen.Automations]: 'Automations',
  [Screen.Settings]: 'Settings',
  [Screen.Chat]: 'Chat',
  [Screen.MediaGallery]: 'Media',
  [Screen.People]: 'People',
};

/** Events emitted by the runtime engine for TUI consumption */
export interface RuntimeEvents {
  // Task lifecycle
  'task:queued': { taskId: string; agentId: string; position: number };
  'task:started': { taskId: string; agentId: string; title: string };
  'task:progress': { taskId: string; tokensUsed: number };
  'task:completed': { taskId: string; agentId: string; status: string; tokensUsed: number; costCents: number };
  'task:failed': { taskId: string; agentId: string; error: string };
  'task:retried': { taskId: string; agentId: string; retryCount: number; maxRetries: number };
  'task:delegated': { taskId: string; agentId: string; peerId: string; peerName: string };
  'task:react_step': { taskId: string; step: Record<string, unknown> };
  'task:warning': { taskId: string; warning: string; tools: string[] };
  'task:needs_approval': { taskId: string; agentId: string; agentName: string; taskTitle: string; deliverableType?: string; workspaceId: string };
  'task:upserted': Record<string, unknown>;
  'task:removed': { id: string };

  // Agent events
  'agent:upserted': Record<string, unknown>;
  'agent:removed': { id: string };

  // Memory
  'memory:extracted': { agentId: string; count: number };

  // Cloud / control plane
  'cloud:connected': { workspaceId: string; agentCount: number };
  'cloud:disconnected': { reason: string };
  'cloud:device-conflict': { currentHostname: string; connectedAt: string };
  'cloud:replaced': { sameDevice?: boolean };
  'cloud:error': { error: string };

  // Activity
  'activity:created': Record<string, unknown>;

  // Contacts
  'contact:upserted': Record<string, unknown>;
  'contact:removed': { id: string };

  // Departments
  'department:upserted': Record<string, unknown>;
  'department:removed': { id: string };

  // WhatsApp
  'whatsapp:qr': { qr: string };
  'whatsapp:connected': { phoneNumber: string };
  'whatsapp:disconnected': { reason: string };
  'whatsapp:message': { chatId: string; from: string; text: string };
  'whatsapp:blocked-message': { chatId: string; sender: string };

  // Telegram
  'telegram:connected': { botUsername: string; connectionId: string };
  'telegram:disconnected': { connectionId: string };
  'telegram:message': { chatId: string; from: string; text: string; connectionId: string };

  // Ollama / models
  'ollama:models-changed': Record<string, never>;
  'ollama:model-changed': { model: string };

  // OpenRouter
  'openrouter:key-changed': { key: string };
  'openrouter:model-changed': { model: string };

  // Projects
  'project:created': Record<string, unknown>;
  'project:updated': Record<string, unknown>;

  // Webhooks
  'webhook:received': { source: string; eventType: string; payload: Record<string, unknown>; triggerId?: string };

  // Peers
  'peer:discovered': DiscoveredPeer;
  'peer:lost': DiscoveredPeer;
  'peer:unhealthy': { peerId: string; name: string; missedCount: number };
  'peer:failover': { peerId: string; machineId: string; connectionIds: string[] };

  // MCP
  'mcp:elicitation': { requestId: string; taskId: string; serverName: string; message: string; schema: Record<string, unknown> };

  // Messages
  'message:stored': Record<string, unknown>;

  // Tunnel
  'tunnel:url': string;

  // Daemon lifecycle
  'daemon:disconnected': Record<string, never>;
  'shutdown': undefined;

  // Credits
  'credits:exhausted': Record<string, never>;
}

export type RuntimeEventName = keyof RuntimeEvents;

/** Agent row shape from SQLite */
export interface AgentRow {
  id: AgentId;
  workspace_id: WorkspaceId;
  name: string;
  role: string;
  description: string | null;
  system_prompt: string;
  config: string | Record<string, unknown>;
  status: string;
  stats: string | Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Task row shape from SQLite */
export interface TaskRow {
  id: TaskId;
  agent_id: AgentId;
  workspace_id: WorkspaceId;
  title: string;
  description: string | null;
  input: string | unknown;
  output: string | unknown;
  status: string;
  model_used: string | null;
  tokens_used: number | null;
  cost_cents: number | null;
  duration_seconds: number | null;
  error_message: string | null;
  priority: string | null;
  due_date: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Activity row shape from SQLite */
export interface ActivityRow {
  id: string;
  workspace_id: WorkspaceId;
  activity_type: string;
  title: string;
  description: string | null;
  agent_id: string | null;
  task_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** Contact row shape from SQLite */
export interface ContactRow {
  id: ContactId;
  workspace_id: WorkspaceId;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  contact_type: string;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Contact event row shape from SQLite */
export interface ContactEventRow {
  id: string;
  contact_id: ContactId;
  event_type: string;
  title: string;
  description: string | null;
  metadata: string | Record<string, unknown>;
  created_at: string;
}

/** Attachment row shape from SQLite */
export interface AttachmentRow {
  id: string;
  workspace_id: WorkspaceId;
  entity_type: string;
  entity_id: string;
  filename: string;
  file_type: string;
  file_size: number;
  storage_path: string;
  uploaded_by: string | null;
  created_at: string;
}

/** Health metrics for the dashboard */
export interface HealthMetrics {
  uptime: number;
  memoryPercent: number;
  totalAgents: number;
  totalTasks: number;
  activeTasks: number;
  totalTokens: number;
  totalCostCents: number;
  cloudConnected: boolean;
}
