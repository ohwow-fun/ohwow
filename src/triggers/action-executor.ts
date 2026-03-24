/**
 * Action Executor
 *
 * Thin orchestrator for automation action chains. Delegates all action
 * execution to the ActionDispatcherRegistry. Each step's output feeds
 * into the execution context for downstream steps.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { RuntimeEngine } from '../execution/engine.js';
import type { ChannelRegistry } from '../integrations/channel-registry.js';
import type { LocalTrigger } from '../webhooks/ghl-types.js';
import type { AutomationAction, ExecutionContext, ActionOutput } from './automation-types.js';
import type { LocalTriggerService } from './local-trigger-service.js';
import { resolveContextValue, resolveMapping, applyTransform, evaluateCondition } from './action-utils.js';
import { createDefaultRegistry } from './action-registry.js';
import type { DispatcherDeps } from './action-dispatcher.js';

const STEP_TIMEOUT_MS = 120_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
    ),
  ]);
}

export class ActionExecutor {
  private registry = createDefaultRegistry();

  constructor(
    private db: DatabaseAdapter,
    private engine: RuntimeEngine,
    private workspaceId: string,
    private channels: ChannelRegistry | null,
    private triggerService: LocalTriggerService,
  ) {}

  private buildDeps(): DispatcherDeps {
    return {
      db: this.db,
      engine: this.engine,
      workspaceId: this.workspaceId,
      channels: this.channels,
      executeAction: (trigger, action, context) => this.executeAction(trigger, action, context),
    };
  }

  /**
   * Execute an action chain sequentially. Each action's output is stored
   * in the context under its step ID for downstream actions to reference.
   */
  async executeActionChain(
    trigger: LocalTrigger,
    actions: AutomationAction[],
    context: ExecutionContext,
    source: string,
    eventType: string,
  ): Promise<void> {
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      try {
        const output = await withTimeout(
          this.executeAction(trigger, action, context),
          STEP_TIMEOUT_MS,
          `Step ${action.id} (${action.action_type})`,
        );
        context[action.id] = output;

        await this.triggerService.logExecution({
          trigger_id: trigger.id,
          source_event: eventType,
          source_metadata: context.trigger,
          action_type: action.action_type,
          action_result: JSON.stringify(output),
          status: 'dispatched',
          step_index: i,
          step_id: action.id,
        }).catch(() => {});
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        await this.triggerService.logExecution({
          trigger_id: trigger.id,
          source_event: eventType,
          source_metadata: context.trigger,
          action_type: action.action_type,
          status: 'failed',
          error_message: errorMessage,
          step_index: i,
          step_id: action.id,
        }).catch(() => {});

        throw new Error(`Step ${action.id} (${action.action_type}) failed: ${errorMessage}`);
      }
    }
  }

  /**
   * Execute a single action via the dispatcher registry.
   */
  async executeAction(
    trigger: LocalTrigger,
    action: AutomationAction,
    context: ExecutionContext,
  ): Promise<ActionOutput> {
    return this.registry.execute(
      action.action_type,
      action.action_config,
      context,
      this.buildDeps(),
      trigger,
    );
  }

  // ============================================================================
  // PUBLIC HELPERS (kept for backward compat with tests/callers)
  // ============================================================================

  resolveContextValue(path: string, context: ExecutionContext): unknown {
    return resolveContextValue(path, context);
  }

  resolveMapping(
    mapping: Record<string, string>,
    context: ExecutionContext,
  ): Record<string, unknown> {
    return resolveMapping(mapping, context);
  }

  applyTransform(value: unknown, transform: string): unknown {
    return applyTransform(value, transform);
  }

  evaluateCondition(fieldValue: unknown, operator: string, conditionValue?: string): boolean {
    return evaluateCondition(fieldValue, operator, conditionValue);
  }
}
