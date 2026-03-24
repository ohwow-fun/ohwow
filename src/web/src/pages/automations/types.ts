/**
 * Local automation types for the flow builder.
 * Mirrors the backend types from automation-service.ts with
 * front-end additions for the canvas builder.
 */

// ─── Core types ──────────────────────────────────────────────────────────

export type AutomationTriggerType = 'webhook' | 'schedule' | 'event' | 'manual';

export type AutomationStepType =
  | 'agent_prompt'
  | 'run_agent'
  | 'save_contact'
  | 'update_contact'
  | 'log_contact_event'
  | 'webhook_forward'
  | 'transform_data'
  | 'conditional';

export interface AutomationStep {
  id: string;
  step_type: AutomationStepType;
  label?: string;
  agent_id?: string;
  agent_name?: string;
  prompt?: string;
  image_url?: string;
  required_integrations?: string[];
  connection_id?: string;
  action_config?: Record<string, unknown>;
}

export interface AutomationVariable {
  name: string;
  description: string;
  default_value?: string;
}

export interface Automation {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger_type: AutomationTriggerType;
  trigger_config: Record<string, unknown>;
  steps: AutomationStep[];
  variables?: AutomationVariable[];
  node_positions?: Record<string, { x: number; y: number }>;
  cooldown_seconds: number;
  last_fired_at: string | null;
  fire_count: number;
  sample_payload?: Record<string, unknown> | null;
  sample_fields?: string[] | null;
  status: 'draft' | 'active' | 'paused' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface CreateAutomationInput {
  name: string;
  description?: string;
  trigger_type: AutomationTriggerType;
  trigger_config?: Record<string, unknown>;
  steps: AutomationStep[];
  variables?: AutomationVariable[];
  cooldown_seconds?: number;
  node_positions?: Record<string, { x: number; y: number }>;
  event_type?: string;
  source?: string;
  sample_payload?: Record<string, unknown> | null;
  sample_fields?: string[] | null;
}

export interface UpdateAutomationInput {
  name?: string;
  description?: string;
  trigger_type?: AutomationTriggerType;
  trigger_config?: Record<string, unknown>;
  steps?: AutomationStep[];
  variables?: AutomationVariable[];
  cooldown_seconds?: number;
  node_positions?: Record<string, { x: number; y: number }>;
  event_type?: string;
  source?: string;
  sample_payload?: Record<string, unknown> | null;
  sample_fields?: string[] | null;
}

// ─── Run types ──────────────────────────────────────────────────────────

export interface AutomationStepResult {
  step_index: number;
  step_id: string;
  step_type: string;
  label?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  output: Record<string, unknown> | null;
  text_output?: string;
  tokens_used?: number;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

export interface AutomationRun {
  id: string;
  automation_id: string;
  workspace_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  current_step_index: number;
  total_steps: number;
  step_results: AutomationStepResult[];
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  failed_step_index: number | null;
  created_at: string;
}

// ─── Action type (used by flow-converters and StepPanel) ────────────────

export interface AutomationAction {
  id: string;
  action_type: string;
  action_config: Record<string, unknown>;
  label?: string;
}

// ─── Step type metadata ─────────────────────────────────────────────────

export const STEP_TYPE_LABELS: Record<AutomationStepType, string> = {
  agent_prompt: 'AI Agent',
  run_agent: 'Run Agent',
  save_contact: 'Save Contact',
  update_contact: 'Update Contact',
  log_contact_event: 'Log Event',
  webhook_forward: 'Forward Webhook',
  transform_data: 'Transform Data',
  conditional: 'Conditional',
};

export const STEP_TYPE_DESCRIPTIONS: Record<AutomationStepType, string> = {
  agent_prompt: 'Have an AI agent process data and generate a response',
  run_agent: 'Assign a task to an AI agent with context from the trigger',
  save_contact: 'Create or update a contact from the data',
  update_contact: 'Find and update an existing contact',
  log_contact_event: 'Add a timeline event to an existing contact',
  webhook_forward: 'Forward the data to an external URL',
  transform_data: 'Transform and reshape data between steps',
  conditional: 'Branch execution based on a condition',
};
