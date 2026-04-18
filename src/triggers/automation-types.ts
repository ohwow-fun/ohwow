/**
 * Automation Types
 *
 * Types for multi-step action chains in automations.
 * Each automation has a trigger and a list of sequential actions.
 * Actions can reference outputs from previous steps via ExecutionContext.
 */

import type { ActionType, ActionConfigMap } from './action-config-schemas.js';

/** A typed action step with discriminated config */
export type TypedAutomationAction<T extends ActionType = ActionType> = {
  [K in T]: {
    /** Unique step identifier, e.g. "step_1", "step_2" */
    id: string;
    /** Action type discriminant */
    action_type: K;
    /** Typed action configuration */
    action_config: ActionConfigMap[K];
    /** Optional human-readable label */
    label?: string;
  };
}[T];

/** A single step in an action chain (backward-compatible loose type) */
export interface AutomationAction {
  /** Unique step identifier, e.g. "step_1", "step_2" */
  id: string;
  /** Action type */
  action_type: string;
  /** Action-specific configuration */
  action_config: Record<string, unknown>;
  /** Optional human-readable label */
  label?: string;
}

/**
 * Execution context passed through the action chain.
 * Keys are step IDs; values are the output records from each step.
 *
 * Example:
 * {
 *   trigger: { email: "john@example.com", name: "John" },
 *   step_1: { contact_id: "abc123" },
 *   step_2: { formatted_name: "JOHN", region: "US" },
 * }
 */
export type ExecutionContext = Record<string, Record<string, unknown>>;

/** Output from a single action execution */
export type ActionOutput = Record<string, unknown>;

/** Condition for conditional actions */
export interface ActionCondition {
  field: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'greater_than' | 'less_than' | 'exists' | 'not_exists';
  value?: string;
}

/** Transform mapping for transform_data actions */
export interface TransformMapping {
  target: string;
  source: string;
  transform?: 'uppercase' | 'lowercase' | 'trim' | 'to_number' | 'to_string' | 'json_parse';
}

/** Known output schemas for FieldPicker auto-discovery */
export const ACTION_OUTPUT_SCHEMAS: Record<string, string[]> = {
  save_contact: ['contact_id', 'name', 'email', 'phone', 'created'],
  update_contact: ['contact_id', 'updated_fields'],
  log_contact_event: ['event_id', 'contact_id'],
  run_agent: ['task_id', 'agent_id', 'status'],
  webhook_forward: ['status_code', 'response_body'],
  transform_data: [], // dynamic based on mapping targets
  conditional: ['branch', 'branch_output'],
  run_workflow: ['workflow_run_id', 'status'],
  create_task: ['task_id', 'project_id', 'board_column', 'status', 'agent_id'],
  send_notification: ['sent', 'channels'],
  fill_pdf: ['filled_pdf_base64', 'fields_filled', 'warnings', 'attachment_id', 'storage_path', 'filename'],
  generate_pptx: ['pptx_base64', 'slide_count', 'warnings', 'attachment_id', 'storage_path', 'filename', 'mime_type'],
  generate_xlsx: ['xlsx_base64', 'sheet_count', 'row_count', 'warnings', 'attachment_id', 'storage_path', 'filename', 'mime_type'],
  save_attachment: ['attachment_id', 'storage_path', 'filename'],
  agent_prompt: ['text', 'tokens_used'],
  a2a_call: ['text', 'a2a_task_id', 'status'],
  generate_chart: ['chart_path', 'chart_type', 'width', 'height', 'file_size'],
};
