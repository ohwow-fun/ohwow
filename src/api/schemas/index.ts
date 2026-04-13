/**
 * Zod validation schemas for API request bodies.
 */

import { z } from 'zod';

/** POST /api/triggers */
export const createTriggerSchema = z.object({
  name: z.string().min(1, 'name is required'),
  event_type: z.string().min(1, 'event_type is required'),
  action_type: z.string().min(1, 'action_type is required'),
  action_config: z.record(z.string(), z.unknown()),
  description: z.string().optional(),
  source: z.string().optional(),
  conditions: z.array(z.record(z.string(), z.unknown())).optional(),
  cooldown_seconds: z.number().optional(),
  actions: z.array(z.record(z.string(), z.unknown())).optional(),
  trigger_type: z.string().optional(),
  trigger_config: z.record(z.string(), z.unknown()).optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  sample_payload: z.record(z.string(), z.unknown()).optional(),
  sample_fields: z.array(z.string()).optional(),
  node_positions: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

/** POST /api/workflows */
export const createWorkflowSchema = z.object({
  name: z.string().min(1, 'name is required').trim(),
  description: z.string().optional(),
  definition: z.record(z.string(), z.unknown()).optional(),
});

/** POST /api/workflows/generate */
export const generateWorkflowSchema = z.object({
  description: z.string().min(1, 'description is required'),
});

/** POST /api/agents */
export const createAgentSchema = z.object({
  name: z.string().min(1, 'name is required'),
  role: z.string().optional(),
  system_prompt: z.string().min(1, 'system_prompt is required'),
  description: z.string().optional(),
  department_id: z.string().optional(),
  display_name: z.string().optional(),
  enabled: z.boolean().optional(),
  scheduled: z
    .object({
      cron: z.string(),
      timezone: z.string().optional(),
    })
    .optional(),
  config: z.object({
    model: z.string().optional(),
    temperature: z.number().optional(),
    max_tokens: z.number().optional(),
    tools_enabled: z.array(z.string()).optional(),
    tools_mode: z.enum(['inherit', 'allowlist']).optional(),
    approval_required: z.boolean().optional(),
    web_search_enabled: z.boolean().optional(),
  }).optional(),
});

/** POST /api/tasks (dispatched via orchestrator) */
export const createTaskSchema = z.object({
  agentId: z.string().min(1, 'agentId is required'),
  title: z.string().min(1, 'title is required'),
  description: z.string().optional(),
});

/** POST /api/automations */
export const createAutomationSchema = z.object({
  name: z.string().min(1, 'name is required'),
  steps: z.array(z.record(z.string(), z.unknown())).min(1, 'at least one step is required'),
}).passthrough();

/** POST /api/contacts */
export const createContactSchema = z.object({
  name: z.string().min(1, 'name is required'),
}).passthrough();
