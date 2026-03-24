/**
 * Local Trigger Service
 *
 * CRUD operations for local_triggers table and matching logic.
 * Follows the pattern from src/lib/agents/services/triggers.service.ts.
 */

import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { LocalTrigger, LocalTriggerExecution } from '../webhooks/ghl-types.js';
import type { AutomationAction } from './automation-types.js';
import { getNestedValue } from './field-mapper.js';

export interface CreateTriggerInput {
  name: string;
  description?: string;
  source?: string;
  event_type: string;
  conditions?: Record<string, unknown>;
  action_type: string;
  action_config: Record<string, unknown>;
  cooldown_seconds?: number;
  /** Multi-step action chain. When provided, action_type/action_config are set from the first action for backward compat. */
  actions?: AutomationAction[];
  trigger_type?: string;
  trigger_config?: Record<string, unknown>;
  variables?: unknown[];
  sample_payload?: string | null;
  sample_fields?: string[] | null;
  node_positions?: string | null;
}

export interface UpdateTriggerInput {
  name?: string;
  description?: string;
  enabled?: boolean;
  event_type?: string;
  conditions?: Record<string, unknown>;
  action_type?: string;
  action_config?: Record<string, unknown>;
  cooldown_seconds?: number;
  /** Multi-step action chain. When provided, action_type/action_config are synced from the first action. */
  actions?: AutomationAction[];
  trigger_type?: string;
  trigger_config?: Record<string, unknown>;
  variables?: unknown[];
  sample_payload?: string | null;
  sample_fields?: string[] | null;
  node_positions?: string | null;
  source?: string;
}

export class LocalTriggerService {
  constructor(private db: DatabaseAdapter) {}

  /** List all triggers, ordered by creation date */
  async list(): Promise<LocalTrigger[]> {
    const { data } = await this.db.from<LocalTrigger>('local_triggers')
      .select('*')
      .order('created_at', { ascending: false });
    return data ?? [];
  }

  /** Get a single trigger by ID */
  async getById(id: string): Promise<LocalTrigger | null> {
    const { data } = await this.db.from<LocalTrigger>('local_triggers')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    return data ?? null;
  }

  /** Get a single trigger by webhook token */
  async getByWebhookToken(token: string): Promise<LocalTrigger | null> {
    const { data } = await this.db.from<LocalTrigger>('local_triggers')
      .select('*')
      .eq('webhook_token', token)
      .maybeSingle();
    return data ?? null;
  }

  /** Create a new trigger */
  async create(input: CreateTriggerInput): Promise<LocalTrigger> {
    // If actions array is provided, sync legacy fields from first action
    let actionType = input.action_type;
    let actionConfig = input.action_config;
    if (input.actions && input.actions.length > 0) {
      actionType = input.actions[0].action_type;
      actionConfig = input.actions[0].action_config;
    }

    const insertData: Record<string, unknown> = {
      name: input.name,
      description: input.description || '',
      source: input.source || 'ghl',
      event_type: input.event_type,
      conditions: JSON.stringify(input.conditions || {}),
      action_type: actionType,
      action_config: JSON.stringify(actionConfig),
      cooldown_seconds: input.cooldown_seconds ?? 60,
      actions: input.actions ? JSON.stringify(input.actions) : null,
      trigger_type: input.trigger_type || 'webhook',
      trigger_config: JSON.stringify(input.trigger_config || {}),
      variables: input.variables ? JSON.stringify(input.variables) : null,
      sample_payload: input.sample_payload ?? null,
      sample_fields: input.sample_fields ? JSON.stringify(input.sample_fields) : null,
      node_positions: input.node_positions ?? null,
    };

    // Auto-generate webhook token for custom event type
    if (input.event_type === 'custom') {
      insertData.webhook_token = crypto.randomBytes(16).toString('hex'); // 32 chars
    }

    const { data } = await this.db.from<LocalTrigger>('local_triggers')
      .insert(insertData)
      .select('*')
      .single();
    return data!;
  }

  /** Update an existing trigger */
  async update(id: string, input: UpdateTriggerInput): Promise<LocalTrigger | null> {
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;
    if (input.enabled !== undefined) updates.enabled = input.enabled ? 1 : 0;
    if (input.event_type !== undefined) updates.event_type = input.event_type;
    if (input.conditions !== undefined) updates.conditions = JSON.stringify(input.conditions);
    if (input.cooldown_seconds !== undefined) updates.cooldown_seconds = input.cooldown_seconds;

    // If actions array is provided, sync legacy fields from first action
    if (input.actions !== undefined) {
      updates.actions = input.actions ? JSON.stringify(input.actions) : null;
      if (input.actions && input.actions.length > 0) {
        updates.action_type = input.actions[0].action_type;
        updates.action_config = JSON.stringify(input.actions[0].action_config);
      }
    } else {
      if (input.action_type !== undefined) updates.action_type = input.action_type;
      if (input.action_config !== undefined) updates.action_config = JSON.stringify(input.action_config);
    }

    if (input.trigger_type !== undefined) updates.trigger_type = input.trigger_type;
    if (input.trigger_config !== undefined) updates.trigger_config = JSON.stringify(input.trigger_config);
    if (input.variables !== undefined) updates.variables = input.variables ? JSON.stringify(input.variables) : null;
    if (input.sample_payload !== undefined) updates.sample_payload = input.sample_payload;
    if (input.sample_fields !== undefined) updates.sample_fields = input.sample_fields ? JSON.stringify(input.sample_fields) : null;
    if (input.node_positions !== undefined) updates.node_positions = input.node_positions;
    if (input.source !== undefined) updates.source = input.source;

    await this.db.from('local_triggers').update(updates).eq('id', id);
    return this.getById(id);
  }

  /** Delete a trigger */
  async delete(id: string): Promise<void> {
    await this.db.from('local_triggers').delete().eq('id', id);
  }

  /**
   * Find triggers that match an incoming event.
   * Checks: source, event_type, enabled, cooldown elapsed, conditions match.
   */
  async findMatchingTriggers(
    source: string,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<LocalTrigger[]> {
    const { data: triggers } = await this.db.from<LocalTrigger>('local_triggers')
      .select('*')
      .eq('source', source)
      .eq('event_type', eventType)
      .eq('enabled', 1);

    if (!triggers) return [];

    const now = Date.now();
    return (triggers ?? []).filter((trigger) => {
      // Check cooldown
      if (trigger.last_fired_at) {
        const elapsed = now - new Date(trigger.last_fired_at).getTime();
        if (elapsed < trigger.cooldown_seconds * 1000) return false;
      }

      // Check conditions (all keys must match)
      const conditions = JSON.parse(trigger.conditions) as Record<string, unknown>;
      for (const [key, value] of Object.entries(conditions)) {
        if (getNestedValue(data, key) !== value) return false;
      }

      return true;
    });
  }

  /** Update trigger fire stats */
  async markFired(id: string, error?: string): Promise<void> {
    const trigger = await this.getById(id);
    if (!trigger) return;

    await this.db.from('local_triggers').update({
      last_fired_at: new Date().toISOString(),
      fire_count: trigger.fire_count + 1,
      last_error: error || null,
      updated_at: new Date().toISOString(),
    }).eq('id', id);
  }

  /** Log a trigger execution */
  async logExecution(input: {
    trigger_id: string;
    source_event: string;
    source_metadata: Record<string, unknown>;
    action_type: string;
    action_result?: string;
    status: string;
    error_message?: string;
    step_index?: number;
    step_id?: string;
  }): Promise<void> {
    await this.db.from('local_trigger_executions').insert({
      trigger_id: input.trigger_id,
      source_event: input.source_event,
      source_metadata: JSON.stringify(input.source_metadata),
      action_type: input.action_type,
      action_result: input.action_result || null,
      status: input.status,
      error_message: input.error_message || null,
      step_index: input.step_index ?? null,
      step_id: input.step_id ?? null,
    });
  }

  /** Get recent executions for a trigger */
  async getExecutions(triggerId: string, limit = 20): Promise<LocalTriggerExecution[]> {
    const { data } = await this.db.from<LocalTriggerExecution>('local_trigger_executions')
      .select('*')
      .eq('trigger_id', triggerId)
      .order('created_at', { ascending: false })
      .limit(limit);
    return data ?? [];
  }

  /** Get recent executions across all triggers */
  async getRecentExecutions(limit = 50): Promise<LocalTriggerExecution[]> {
    const { data } = await this.db.from<LocalTriggerExecution>('local_trigger_executions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    return data ?? [];
  }

  /** Get sample payload and discovered fields for a trigger */
  async getSampleData(triggerId: string): Promise<{
    samplePayload: Record<string, unknown> | null;
    sampleFields: string[];
  }> {
    const trigger = await this.getById(triggerId);
    if (!trigger) return { samplePayload: null, sampleFields: [] };

    let samplePayload: Record<string, unknown> | null = null;
    let sampleFields: string[] = [];

    if (trigger.sample_payload) {
      try { samplePayload = JSON.parse(trigger.sample_payload); } catch { /* empty */ }
    }
    if (trigger.sample_fields) {
      try { sampleFields = JSON.parse(trigger.sample_fields); } catch { /* empty */ }
    }

    return { samplePayload, sampleFields };
  }

  /** Update sample payload and discovered fields on a trigger */
  async updateSampleData(triggerId: string, payload: string, fields: string[]): Promise<void> {
    await this.db.from('local_triggers').update({
      sample_payload: payload,
      sample_fields: JSON.stringify(fields),
      updated_at: new Date().toISOString(),
    }).eq('id', triggerId);
  }
}

