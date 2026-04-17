/**
 * Action Dispatcher Registry
 *
 * Manages a collection of action dispatchers, keyed by action_type.
 * Replaces the switch statement in ActionExecutor.
 */

import type { ActionDispatcher } from './action-dispatcher.js';
import type { DispatcherDeps } from './action-dispatcher.js';
import type { LocalTrigger } from '../webhooks/ghl-types.js';
import type { ExecutionContext, ActionOutput } from './automation-types.js';
import { runAgentDispatcher } from './dispatchers/run-agent.js';
import { saveContactDispatcher } from './dispatchers/save-contact.js';
import { updateContactDispatcher } from './dispatchers/update-contact.js';
import { logContactEventDispatcher } from './dispatchers/log-contact-event.js';
import { webhookForwardDispatcher } from './dispatchers/webhook-forward.js';
import { transformDataDispatcher } from './dispatchers/transform-data.js';
import { conditionalDispatcher } from './dispatchers/conditional.js';
import { runWorkflowDispatcher } from './dispatchers/run-workflow.js';
import { createTaskDispatcher } from './dispatchers/create-task.js';
import { sendNotificationDispatcher } from './dispatchers/send-notification.js';
import { fillPdfDispatcher } from './dispatchers/fill-pdf.js';
import { saveAttachmentDispatcher } from './dispatchers/save-attachment.js';
import { takeScreenshotDispatcher } from './dispatchers/take-screenshot.js';
import { agentPromptDispatcher } from './dispatchers/agent-prompt.js';
import { a2aCallDispatcher } from './dispatchers/a2a-call.js';
import { generateChartDispatcher } from './dispatchers/generate-chart.js';
import { shellScriptDispatcher } from './dispatchers/shell-script.js';

export class ActionDispatcherRegistry {
  private dispatchers = new Map<string, ActionDispatcher>();

  register(dispatcher: ActionDispatcher): void {
    this.dispatchers.set(dispatcher.actionType, dispatcher);
  }

  has(actionType: string): boolean {
    return this.dispatchers.has(actionType);
  }

  async execute(
    actionType: string,
    config: Record<string, unknown>,
    context: ExecutionContext,
    deps: DispatcherDeps,
    trigger: LocalTrigger,
  ): Promise<ActionOutput> {
    const dispatcher = this.dispatchers.get(actionType);
    if (!dispatcher) {
      throw new Error(`Unknown action type: ${actionType}`);
    }
    return dispatcher.execute(config, context, deps, trigger);
  }
}

/** Create a registry with all default dispatchers */
export function createDefaultRegistry(): ActionDispatcherRegistry {
  const registry = new ActionDispatcherRegistry();
  registry.register(runAgentDispatcher);
  registry.register(saveContactDispatcher);
  registry.register(updateContactDispatcher);
  registry.register(logContactEventDispatcher);
  registry.register(webhookForwardDispatcher);
  registry.register(transformDataDispatcher);
  registry.register(conditionalDispatcher);
  registry.register(runWorkflowDispatcher);
  registry.register(createTaskDispatcher);
  registry.register(sendNotificationDispatcher);
  registry.register(fillPdfDispatcher);
  registry.register(saveAttachmentDispatcher);
  registry.register(takeScreenshotDispatcher);
  registry.register(agentPromptDispatcher);
  registry.register(a2aCallDispatcher);
  registry.register(generateChartDispatcher);
  registry.register(shellScriptDispatcher);
  return registry;
}
