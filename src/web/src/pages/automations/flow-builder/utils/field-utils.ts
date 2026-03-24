import type { AutomationAction } from '../../types';

// --- Types ------------------------------------------------------------------

export interface FieldEntry {
  /** Field name, e.g. "email" */
  name: string;
  /** Fully-qualified path, e.g. "trigger.email" */
  path: string;
  /** Optional sample value for preview, e.g. "jane@example.com" */
  value?: string;
}

export interface FieldGroup {
  /** Display label, e.g. "Trigger", "Step 1: Save Contact" */
  label: string;
  /** Path prefix, e.g. "trigger", "step_1" */
  prefix: string;
  /** Fields in this group */
  fields: FieldEntry[];
}

// --- Output schemas for each action type ------------------------------------

export const OUTPUT_SCHEMAS: Record<string, string[]> = {
  save_contact: ['contact_id', 'name', 'email', 'created'],
  update_contact: ['contact_id', 'updated_fields'],
  log_contact_event: ['event_id', 'contact_id'],
  run_agent: ['task_id', 'agent_id', 'status'],
  agent_prompt: ['text'],
  a2a_call: ['text', 'status'],
  create_task: ['task_id', 'title', 'status'],
  webhook_forward: ['status_code', 'response_body'],
  transform_data: [], // dynamic, read from mappings
  conditional: ['branch', 'branch_output'],
  run_workflow: ['workflow_run_id', 'status'],
  take_screenshot: ['screenshot_url', 'page_title', 'page_url'],
  generate_chart: ['chart_url', 'chart_type', 'width', 'height'],
};

// --- Human-readable hints for non-obvious output fields ---------------------

export const OUTPUT_FIELD_HINTS: Record<string, string> = {
  'agent_prompt.text': 'AI generated response, freeform',
  'a2a_call.text': 'AI generated response, freeform',
  'a2a_call.status': 'completed, failed, or pending',
  'conditional.branch': 'Name of the branch that matched',
  'conditional.branch_output': 'Output from whichever branch ran',
  'webhook_forward.response_body': 'Raw response from the target URL',
  'create_task.status': 'pending, in_progress, or completed',
  'take_screenshot.screenshot_url': 'Public URL or local path to the captured screenshot',
  'take_screenshot.page_title': 'Title of the captured page',
  'take_screenshot.page_url': 'Final URL after any redirects',
  'generate_chart.chart_url': 'Public URL of the generated chart image',
  'generate_chart.chart_type': 'Chart type (bar, line, pie, etc.)',
  'generate_chart.width': 'Chart width in pixels',
  'generate_chart.height': 'Chart height in pixels',
};

// --- Step output field helper -----------------------------------------------

/**
 * Get the output field names for a given action, with dynamic handling for transform_data.
 */
export function getStepOutputFields(action: AutomationAction): string[] {
  if (action.action_type === 'transform_data') {
    const mappings = (action.action_config?.mappings || []) as Array<{ target: string }>;
    const targets = mappings.map((m) => m.target).filter(Boolean);
    return targets;
  }
  return OUTPUT_SCHEMAS[action.action_type] || [];
}

// --- JSON flattening --------------------------------------------------------

/**
 * Recursively flatten a JSON object into dot-notation leaf paths.
 *
 * ```ts
 * flattenJson({ email: "a@b.com", order: { id: 123 } })
 * // -> { fields: ["email", "order.id"], payload: { email: "a@b.com", "order.id": 123 } }
 * ```
 */
export function flattenJson(
  obj: Record<string, unknown>,
  prefix = '',
): { fields: string[]; payload: Record<string, unknown> } {
  const payload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const nested = flattenJson(value as Record<string, unknown>, path);
      Object.assign(payload, nested.payload);
    } else {
      payload[path] = value;
    }
  }

  return { fields: Object.keys(payload), payload };
}

// --- Builder ----------------------------------------------------------------

/**
 * Build grouped field lists from trigger sample data + previous steps.
 * Used by FieldPicker and DataPreviewPanel.
 */
export function buildFieldGroups(opts: {
  sampleFields: string[];
  samplePayload?: Record<string, unknown> | null;
  eventType?: string;
  previousSteps: AutomationAction[];
}): FieldGroup[] {
  const { sampleFields, samplePayload, previousSteps } = opts;
  const groups: FieldGroup[] = [];

  // --- Trigger fields ---
  if (sampleFields.length > 0) {
    const fields: FieldEntry[] = sampleFields.map((name) => {
      let value: string | undefined;
      if (samplePayload && name in samplePayload) {
        const v = samplePayload[name];
        value = typeof v === 'string' ? v : JSON.stringify(v);
      }
      return { name, path: `trigger.${name}`, value };
    });
    groups.push({ label: 'Trigger', prefix: 'trigger', fields });
  }

  // --- Previous step outputs ---
  for (const step of previousSteps) {
    let schemaFields = OUTPUT_SCHEMAS[step.action_type] || [];

    // For transform_data, dynamically read mapping targets
    if (step.action_type === 'transform_data') {
      const mappings = (step.action_config?.mappings || []) as Array<{ target: string }>;
      schemaFields = mappings.map((m) => m.target).filter(Boolean);
    }

    if (schemaFields.length > 0) {
      const stepLabel = step.label || step.action_type;
      const fields: FieldEntry[] = schemaFields.map((name) => ({
        name,
        path: `${step.id}.${name}`,
      }));
      groups.push({
        label: `Step ${step.id.replace('step_', '')}: ${stepLabel}`,
        prefix: step.id,
        fields,
      });
    }
  }

  return groups;
}

/**
 * Flat list of all available field paths (backward-compatible with old buildAvailableFields).
 */
export function buildAvailableFieldPaths(sampleFields: string[], previousSteps: AutomationAction[]): string[] {
  const groups = buildFieldGroups({ sampleFields, previousSteps });
  return groups.flatMap((g) => g.fields.map((f) => f.path));
}

// --- Template validation ----------------------------------------------------

/**
 * Extract template variable paths from a string.
 * e.g. "Check {{trigger.photo_url}} and {{step_1.text}}" -> ["trigger.photo_url", "step_1.text"]
 */
export function extractTemplateVars(template: string): string[] {
  const matches: string[] = [];
  const re = /\{\{([^}]+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    matches.push(m[1].trim());
  }
  return matches;
}

/**
 * Return template vars that don't match any known field path.
 */
export function findUnresolvedVars(vars: string[], availablePaths: string[]): string[] {
  const pathSet = new Set(availablePaths);
  return vars.filter((v) => !pathSet.has(v));
}
