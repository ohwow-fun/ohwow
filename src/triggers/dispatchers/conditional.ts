/**
 * conditional dispatcher: evaluate a condition and execute one of two sub-chains.
 */

import type { ActionDispatcher, DispatcherDeps } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput, ActionCondition, AutomationAction } from '../automation-types.js';
import type { LocalTrigger } from '../../webhooks/ghl-types.js';
import { resolveContextValue, evaluateCondition } from '../action-utils.js';

export const conditionalDispatcher: ActionDispatcher = {
  actionType: 'conditional',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
    deps: DispatcherDeps,
    trigger: LocalTrigger,
  ): Promise<ActionOutput> {
    const condition = config.condition as ActionCondition;
    if (!condition || !condition.field || !condition.operator) {
      throw new Error('conditional requires a condition with field and operator');
    }

    const fieldValue = resolveContextValue(condition.field, context);
    const conditionMet = evaluateCondition(fieldValue, condition.operator, condition.value);

    const branch = conditionMet ? 'then' : 'else';
    const subActions = (conditionMet
      ? config.then_actions
      : config.else_actions) as AutomationAction[] | undefined;

    if (subActions && Array.isArray(subActions) && subActions.length > 0) {
      for (const action of subActions) {
        const output = await deps.executeAction(trigger, action, context);
        context[action.id] = output;
      }

      const lastAction = subActions[subActions.length - 1];
      return { branch, branch_output: context[lastAction.id] || {} };
    }

    return { branch, branch_output: {} };
  },
};
