/**
 * GoHighLevel Webhook Types
 *
 * GHL sends webhooks with a generic structure. Event types are strings
 * (e.g., "ContactCreate", "OpportunityCreate") so new events work automatically
 * without code changes.
 */

export interface GhlWebhookPayload {
  /** Event type string, e.g. "ContactCreate", "OpportunityCreate" */
  type: string;
  /** ISO timestamp of the event */
  timestamp: string;
  /** GHL webhook ID */
  webhookId: string;
  /** Event-specific data (varies by event type) */
  data: Record<string, unknown>;
}

export interface WebhookEvent {
  id: string;
  source: string;
  event_type: string;
  payload: string;
  headers: string;
  processed: number;
  created_at: string;
}

export interface LocalTrigger {
  id: string;
  name: string;
  description: string;
  enabled: number;
  source: string;
  event_type: string;
  conditions: string;
  action_type: string;
  action_config: string;
  cooldown_seconds: number;
  last_fired_at: string | null;
  fire_count: number;
  last_error: string | null;
  webhook_token: string | null;
  sample_payload: string | null;
  sample_fields: string | null;
  /** JSON array of AutomationAction[]. Null = legacy single-action mode. */
  actions: string | null;
  trigger_type: string;
  trigger_config: string;
  variables: string | null;
  node_positions: string | null;
  /** JSON containing { steps, variables, node_positions } in unified AutomationStep format. */
  definition: string | null;
  /** Trigger status: draft/active/paused/archived */
  status: string | null;
  created_at: string;
  updated_at: string;
}

export interface LocalTriggerExecution {
  id: string;
  trigger_id: string;
  source_event: string;
  source_metadata: string;
  action_type: string;
  action_result: string | null;
  status: string;
  error_message: string | null;
  step_index: number | null;
  step_id: string | null;
  created_at: string;
}
