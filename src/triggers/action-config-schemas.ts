/**
 * Action Config Schemas
 *
 * Zod schemas for all 16 automation action types.
 * Provides runtime validation and derived TypeScript types
 * as a discriminated union keyed on action_type.
 */

import { z } from 'zod';

// ============================================================================
// INDIVIDUAL ACTION CONFIG SCHEMAS
// ============================================================================

export const RunAgentConfigSchema = z.object({
  agent_id: z.string().min(1),
  prompt: z.string().optional(),
});

export const SaveContactConfigSchema = z.object({
  field_mapping: z.record(z.string(), z.string()),
  contact_type: z.string().optional(),
  upsert_key: z.string().optional(),
});

export const UpdateContactConfigSchema = z.object({
  match_field: z.string().min(1),
  match_value_path: z.string().min(1),
  field_mapping: z.record(z.string(), z.string()),
});

export const LogContactEventConfigSchema = z.object({
  match_field: z.string().min(1),
  match_value_path: z.string().min(1),
  event_type: z.string().min(1),
  title_template: z.string().min(1),
  description_template: z.string().optional(),
});

export const WebhookForwardConfigSchema = z.object({
  url: z.url(),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body_template: z.string().optional(),
  body_mapping: z.record(z.string(), z.string()).optional(),
});

export const TransformDataConfigSchema = z.object({
  mappings: z.array(z.object({
    target: z.string().min(1),
    source: z.string().min(1),
    transform: z.enum(['uppercase', 'lowercase', 'trim', 'to_number', 'to_string', 'json_parse']).optional(),
  })),
});

export const ConditionalConfigSchema = z.object({
  condition: z.object({
    field: z.string().min(1),
    operator: z.enum([
      'equals', 'not_equals', 'contains', 'not_contains',
      'greater_than', 'less_than', 'exists', 'not_exists',
    ]),
    value: z.string().optional(),
  }),
  then_actions: z.array(z.unknown()).optional(),
  else_actions: z.array(z.unknown()).optional(),
});

export const RunWorkflowConfigSchema = z.object({
  workflow_id: z.string().min(1),
  variable_mapping: z.record(z.string(), z.string()).optional(),
});

export const CreateTaskConfigSchema = z.object({
  title_template: z.string().min(1),
  description_template: z.string().optional(),
  project_id: z.string().optional(),
  board_column: z.string().optional(),
  priority: z.string().optional(),
  agent_id: z.string().optional(),
  run_immediately: z.boolean().optional(),
  contact_id_path: z.string().optional(),
  labels: z.array(z.string()).optional(),
});

export const SendNotificationConfigSchema = z.object({
  message_template: z.string().min(1),
  channel: z.string().optional(),
  chat_id: z.string().optional(),
  recipients: z.array(z.string()).optional(),
});

export const FillPdfConfigSchema = z.object({
  template_attachment_id: z.string().min(1),
  manual_field_mapping: z.record(z.string(), z.string()).optional(),
  ai_auto_map: z.boolean().optional(),
  flatten: z.boolean().optional(),
  auto_save: z.boolean().optional(),
  save_filename_template: z.string().optional(),
});

export const SaveAttachmentConfigSchema = z.object({
  data_path: z.string().min(1),
  filename_template: z.string().min(1),
  file_type: z.string().optional(),
  entity_type: z.string().optional(),
  entity_id_path: z.string().optional(),
});

export const TakeScreenshotConfigSchema = z.object({
  url: z.string().min(1),
  wait_seconds: z.number().optional(),
});

export const AgentPromptConfigSchema = z.object({
  prompt: z.string().optional(),
  task_prompt: z.string().optional(),
  agent_id: z.string().optional(),
  model: z.string().optional(),
  max_tokens: z.number().optional(),
});

export const A2ACallConfigSchema = z.object({
  connection_id: z.string().min(1),
  prompt: z.string().optional(),
});

export const GenerateChartConfigSchema = z.object({
  mode: z.enum(['manual', 'ai']).optional(),
  data_source: z.string().optional(),
  chart_type: z.string().optional(),
  labels_source: z.string().optional(),
  dataset_label: z.string().optional(),
  colors: z.array(z.string()).optional(),
  instruction: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

export const ShellScriptConfigSchema = z.object({
  /** Path to a Node script (relative to repo root, or absolute). Run via `npx tsx`. */
  script_path: z.string().min(1),
  /** Extra env vars merged onto process.env. OHWOW_WORKSPACE + OHWOW_PORT auto-injected. */
  env: z.record(z.string(), z.string()).optional(),
  /** Wall-clock timeout in seconds. Default 900 (15 min). */
  timeout_seconds: z.number().int().positive().optional(),
  /** If set, write a JSON heartbeat to <workspace dataDir>/<filename> after the run. */
  heartbeat_filename: z.string().optional(),
  /** Override the workspace slug used for OHWOW_WORKSPACE. Default: currently-focused workspace. */
  workspace_slug: z.string().optional(),
});

export const GeneratePptxConfigSchema = z.object({
  title: z.string().optional(),
  author: z.string().optional(),
  slides: z.array(z.object({
    title: z.string().optional(),
    bullets: z.array(z.string()).optional(),
    notes: z.string().optional(),
    layout: z.enum(['TITLE', 'TITLE_AND_CONTENT', 'BLANK']).optional(),
  })).min(1),
  filename: z.string().optional(),
  auto_save: z.boolean().optional(),
});

export const GenerateXlsxConfigSchema = z.object({
  title: z.string().optional(),
  author: z.string().optional(),
  sheets: z.array(z.object({
    name: z.string().min(1),
    headers: z.array(z.string()).optional(),
    rows: z.array(z.array(z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.date(),
      z.null(),
    ]))),
    column_widths: z.array(z.number()).optional(),
  })).min(1),
  filename: z.string().optional(),
  auto_save: z.boolean().optional(),
});

export const GenerateDocxConfigSchema = z.object({
  title: z.string().optional(),
  author: z.string().optional(),
  blocks: z.array(z.union([
    z.object({
      type: z.literal('heading'),
      level: z.union([
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
        z.literal(6),
      ]),
      text: z.string(),
    }),
    z.object({
      type: z.literal('paragraph'),
      runs: z.array(z.object({
        text: z.string(),
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
        underline: z.boolean().optional(),
      })),
    }),
    z.object({
      type: z.literal('bullets'),
      items: z.array(z.string()),
    }),
  ])).min(1),
  filename: z.string().optional(),
  auto_save: z.boolean().optional(),
});

export const RunInternalConfigSchema = z.object({
  /** Name of the handler to invoke. Must be registered via registerInternalHandler() on daemon boot. */
  handler_name: z.string().min(1),
  /** Arbitrary config payload passed to the handler. */
  config: z.record(z.string(), z.unknown()).optional(),
  /** Wall-clock timeout in seconds. Default inherits from action-executor STEP_TIMEOUT_MS. */
  timeout_seconds: z.number().int().positive().optional(),
});

// ============================================================================
// DERIVED TYPES
// ============================================================================

export type RunAgentConfig = z.infer<typeof RunAgentConfigSchema>;
export type SaveContactConfig = z.infer<typeof SaveContactConfigSchema>;
export type UpdateContactConfig = z.infer<typeof UpdateContactConfigSchema>;
export type LogContactEventConfig = z.infer<typeof LogContactEventConfigSchema>;
export type WebhookForwardConfig = z.infer<typeof WebhookForwardConfigSchema>;
export type TransformDataConfig = z.infer<typeof TransformDataConfigSchema>;
export type ConditionalConfig = z.infer<typeof ConditionalConfigSchema>;
export type RunWorkflowConfig = z.infer<typeof RunWorkflowConfigSchema>;
export type CreateTaskConfig = z.infer<typeof CreateTaskConfigSchema>;
export type SendNotificationConfig = z.infer<typeof SendNotificationConfigSchema>;
export type FillPdfConfig = z.infer<typeof FillPdfConfigSchema>;
export type SaveAttachmentConfig = z.infer<typeof SaveAttachmentConfigSchema>;
export type TakeScreenshotConfig = z.infer<typeof TakeScreenshotConfigSchema>;
export type AgentPromptConfig = z.infer<typeof AgentPromptConfigSchema>;
export type A2ACallConfig = z.infer<typeof A2ACallConfigSchema>;
export type GenerateChartConfig = z.infer<typeof GenerateChartConfigSchema>;
export type ShellScriptConfig = z.infer<typeof ShellScriptConfigSchema>;
export type GeneratePptxConfig = z.infer<typeof GeneratePptxConfigSchema>;
export type GenerateXlsxConfig = z.infer<typeof GenerateXlsxConfigSchema>;
export type GenerateDocxConfig = z.infer<typeof GenerateDocxConfigSchema>;
export type RunInternalConfig = z.infer<typeof RunInternalConfigSchema>;

// ============================================================================
// ACTION CONFIG MAP
// ============================================================================

/** Maps action_type strings to their config types */
export interface ActionConfigMap {
  run_agent: RunAgentConfig;
  save_contact: SaveContactConfig;
  update_contact: UpdateContactConfig;
  log_contact_event: LogContactEventConfig;
  webhook_forward: WebhookForwardConfig;
  transform_data: TransformDataConfig;
  conditional: ConditionalConfig;
  run_workflow: RunWorkflowConfig;
  create_task: CreateTaskConfig;
  send_notification: SendNotificationConfig;
  fill_pdf: FillPdfConfig;
  save_attachment: SaveAttachmentConfig;
  take_screenshot: TakeScreenshotConfig;
  agent_prompt: AgentPromptConfig;
  a2a_call: A2ACallConfig;
  generate_chart: GenerateChartConfig;
  shell_script: ShellScriptConfig;
  generate_pptx: GeneratePptxConfig;
  generate_xlsx: GenerateXlsxConfig;
  generate_docx: GenerateDocxConfig;
  run_internal: RunInternalConfig;
}

export type ActionType = keyof ActionConfigMap;

/** Schema lookup by action type */
export const ACTION_CONFIG_SCHEMAS: Record<ActionType, z.ZodType> = {
  run_agent: RunAgentConfigSchema,
  save_contact: SaveContactConfigSchema,
  update_contact: UpdateContactConfigSchema,
  log_contact_event: LogContactEventConfigSchema,
  webhook_forward: WebhookForwardConfigSchema,
  transform_data: TransformDataConfigSchema,
  conditional: ConditionalConfigSchema,
  run_workflow: RunWorkflowConfigSchema,
  create_task: CreateTaskConfigSchema,
  send_notification: SendNotificationConfigSchema,
  fill_pdf: FillPdfConfigSchema,
  save_attachment: SaveAttachmentConfigSchema,
  take_screenshot: TakeScreenshotConfigSchema,
  agent_prompt: AgentPromptConfigSchema,
  a2a_call: A2ACallConfigSchema,
  generate_chart: GenerateChartConfigSchema,
  shell_script: ShellScriptConfigSchema,
  generate_pptx: GeneratePptxConfigSchema,
  generate_xlsx: GenerateXlsxConfigSchema,
  generate_docx: GenerateDocxConfigSchema,
  run_internal: RunInternalConfigSchema,
};
