/**
 * Action Dispatcher Interface
 *
 * Contract for individual action dispatchers in the registry pattern.
 * Each dispatcher handles one action_type.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { RuntimeEngine } from '../execution/engine.js';
import type { ChannelRegistry } from '../integrations/channel-registry.js';
import type { LocalTrigger } from '../webhooks/ghl-types.js';
import type { AutomationAction, ExecutionContext, ActionOutput } from './automation-types.js';

/** Dependencies injected into every dispatcher */
export interface DispatcherDeps {
  db: DatabaseAdapter;
  engine: RuntimeEngine;
  workspaceId: string;
  channels: ChannelRegistry | null;
  /** Callback for recursive execution (used by conditional dispatcher) */
  executeAction: (
    trigger: LocalTrigger,
    action: AutomationAction,
    context: ExecutionContext,
  ) => Promise<ActionOutput>;
}

/** A stateless action dispatcher that handles one action type */
export interface ActionDispatcher {
  readonly actionType: string;
  execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
    deps: DispatcherDeps,
    trigger: LocalTrigger,
  ): Promise<ActionOutput>;
}
