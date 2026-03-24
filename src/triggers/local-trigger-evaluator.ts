/**
 * Local Trigger Evaluator
 *
 * Fire-and-forget evaluation: finds matching triggers for an incoming event
 * and dispatches the configured actions (single or multi-step chains).
 *
 * Follows the pattern from src/lib/agents/services/trigger-evaluator.ts.
 * All errors are caught internally (never throws).
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { RuntimeEngine } from '../execution/engine.js';
import type { ChannelRegistry } from '../integrations/channel-registry.js';
import type { LocalTrigger } from '../webhooks/ghl-types.js';
import type { AutomationAction, ExecutionContext } from './automation-types.js';
import { LocalTriggerService } from './local-trigger-service.js';
import { LoopDetector } from './loop-detector.js';
import { ActionExecutor } from './action-executor.js';
import { logger } from '../lib/logger.js';

export class LocalTriggerEvaluator {
  private triggerService: LocalTriggerService;
  private loopDetector: LoopDetector;
  private actionExecutor: ActionExecutor;

  constructor(
    private db: DatabaseAdapter,
    private engine: RuntimeEngine,
    private workspaceId: string,
    channels?: ChannelRegistry,
  ) {
    this.triggerService = new LocalTriggerService(db);
    this.loopDetector = new LoopDetector();
    this.actionExecutor = new ActionExecutor(db, engine, workspaceId, channels ?? null, this.triggerService);
  }

  /**
   * Evaluate an incoming event against all matching triggers.
   * Dispatches actions for each match. Never throws.
   */
  async evaluate(
    source: string,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      // Circuit breaker: prevent automation self-loops (cross-chat relay loops)
      const chatId = (data.chatId as string) || '';
      if (chatId && this.loopDetector.isLooping(source, chatId)) {
        logger.warn(`[TriggerEvaluator] Loop detected for ${source}:${chatId}, skipping evaluation`);
        return;
      }

      const triggers = await this.triggerService.findMatchingTriggers(source, eventType, data);

      for (const trigger of triggers) {
        await this.dispatchTrigger(trigger, source, eventType, data);
      }
    } catch (err) {
      logger.error(`[TriggerEvaluator] Evaluation error: ${err}`);
    }
  }

  /**
   * Evaluate a custom webhook trigger directly (already matched by token).
   * Dispatches the action without query-based matching. Never throws.
   */
  async evaluateCustom(
    trigger: LocalTrigger,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      // Check cooldown
      if (trigger.last_fired_at) {
        const elapsed = Date.now() - new Date(trigger.last_fired_at).getTime();
        if (elapsed < trigger.cooldown_seconds * 1000) {
          logger.info(`[TriggerEvaluator] Custom trigger ${trigger.name} skipped (cooldown)`);
          return;
        }
      }

      await this.dispatchTrigger(trigger, 'custom', 'custom', data);
    } catch (err) {
      logger.error(`[TriggerEvaluator] Custom evaluation error: ${err}`);
    }
  }

  /**
   * Execute a trigger by its ID (for manual execution and workflow_execute commands).
   * Looks up the trigger in SQLite, then dispatches its action chain.
   */
  async executeById(
    triggerId: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const trigger = await this.triggerService.getById(triggerId);
      if (!trigger) {
        logger.error(`[TriggerEvaluator] Trigger not found: ${triggerId}`);
        return;
      }
      if (!trigger.enabled) {
        logger.info(`[TriggerEvaluator] Trigger ${trigger.name} is disabled, skipping`);
        return;
      }
      await this.dispatchTrigger(trigger, 'manual', 'manual', data || {});
    } catch (err) {
      logger.error(`[TriggerEvaluator] executeById error for ${triggerId}: ${err}`);
    }
  }

  /**
   * Get the list of actions for a trigger.
   * If trigger has an `actions` JSON array, parse and return it.
   * Otherwise, fall back to a single-action array from legacy fields.
   */
  private getActions(trigger: LocalTrigger): AutomationAction[] {
    // New format: read from definition.steps (unified AutomationStep schema)
    if (trigger.definition) {
      try {
        const def = JSON.parse(trigger.definition) as { steps?: Array<{ id: string; step_type: string; label?: string; action_config?: Record<string, unknown>; agent_id?: string; agent_name?: string; prompt?: string; connection_id?: string; required_integrations?: string[]; image_url?: string }> };
        if (def.steps && Array.isArray(def.steps) && def.steps.length > 0) {
          return def.steps.map((step) => ({
            id: step.id,
            action_type: step.step_type,
            action_config: step.action_config || {
              ...(step.agent_id ? { agent_id: step.agent_id } : {}),
              ...(step.agent_name ? { agent_name: step.agent_name } : {}),
              ...(step.prompt ? { task_prompt: step.prompt } : {}),
              ...(step.connection_id ? { connection_id: step.connection_id } : {}),
              ...(step.required_integrations ? { required_integrations: step.required_integrations } : {}),
              ...(step.image_url ? { image_url: step.image_url } : {}),
            },
            label: step.label,
          }));
        }
      } catch { /* fall through */ }
    }

    // Existing format: actions JSON array
    if (trigger.actions) {
      try {
        const parsed = JSON.parse(trigger.actions) as AutomationAction[];
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch { /* fall through to legacy */ }
    }

    // Legacy single-action fallback
    const config = (typeof trigger.action_config === 'object' && trigger.action_config !== null)
      ? trigger.action_config as unknown as Record<string, unknown>
      : JSON.parse(trigger.action_config) as Record<string, unknown>;

    return [{
      id: 'step_1',
      action_type: trigger.action_type,
      action_config: config,
      label: trigger.action_type,
    }];
  }

  private async dispatchTrigger(
    trigger: LocalTrigger,
    source: string,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const actions = this.getActions(trigger);
    const context: ExecutionContext = { trigger: data };

    try {
      // Mark trigger as fired BEFORE execution to prevent cooldown race condition
      // (a second webhook arriving during a long chain would slip through otherwise)
      await this.triggerService.markFired(trigger.id);

      await this.actionExecutor.executeActionChain(trigger, actions, context, source, eventType);

      // Log overall success
      await this.triggerService.logExecution({
        trigger_id: trigger.id,
        source_event: eventType,
        source_metadata: data,
        action_type: actions.length === 1 ? actions[0].action_type : `chain(${actions.length})`,
        status: 'completed',
      });

      // Log activity
      const firstConfig = actions[0]?.action_config || {};
      await this.db.rpc('create_agent_activity', {
        p_workspace_id: this.workspaceId,
        p_activity_type: 'trigger_fired',
        p_title: `Trigger fired: ${trigger.name}`,
        p_description: `${source}:${eventType} (${actions.length} ${actions.length === 1 ? 'action' : 'actions'})`,
        p_agent_id: (firstConfig.agent_id as string) || null,
        p_task_id: null,
        p_metadata: {
          triggerId: trigger.id,
          triggerEvent: eventType,
          source,
          actionCount: actions.length,
        },
      });

      logger.info(`[TriggerEvaluator] Trigger fired: ${trigger.name} (${source}:${eventType}, ${actions.length} actions)`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`[TriggerEvaluator] Dispatch error for trigger ${trigger.id}: ${err}`);

      await this.triggerService.markFired(trigger.id, errorMessage).catch(() => {});
      await this.triggerService.logExecution({
        trigger_id: trigger.id,
        source_event: eventType,
        source_metadata: data,
        action_type: actions.length === 1 ? actions[0].action_type : `chain(${actions.length})`,
        status: 'failed',
        error_message: errorMessage,
      }).catch(() => {});
    }
  }
}
