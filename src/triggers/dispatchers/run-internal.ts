/**
 * run_internal dispatcher: invoke an in-process handler registered via
 * registerInternalHandler(). Designed for scheduler-class tick methods
 * whose deep runtime dependencies (model router, channel registry,
 * browser lane singletons) make shell_script spawning impractical.
 *
 * Handlers register at daemon boot with their deps already bound. The
 * automation step only needs to specify the handler name + any
 * per-invocation config. Unknown handler names surface as loud errors
 * so misconfigured automations fail fast instead of silently no-oping.
 */

import type { ActionDispatcher, DispatcherDeps } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import type { LocalTrigger } from '../../webhooks/ghl-types.js';
import { RunInternalConfigSchema } from '../action-config-schemas.js';
import { getInternalHandler, listInternalHandlers } from '../internal-handler-registry.js';

export const runInternalDispatcher: ActionDispatcher = {
  actionType: 'run_internal',

  async execute(
    rawConfig: Record<string, unknown>,
    _context: ExecutionContext,
    _deps: DispatcherDeps,
    _trigger: LocalTrigger,
  ): Promise<ActionOutput> {
    const parsed = RunInternalConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new Error(`run_internal: invalid config — ${parsed.error.message}`);
    }
    const { handler_name, config } = parsed.data;

    const handler = getInternalHandler(handler_name);
    if (!handler) {
      throw new Error(
        `run_internal: unknown handler "${handler_name}" (registered: ${listInternalHandlers().join(', ') || 'none'})`,
      );
    }

    const started = Date.now();
    const result = await handler({ config: config ?? {} });
    const durationMs = Date.now() - started;

    return {
      handler_name,
      duration_ms: durationMs,
      status: 'ok',
      ...result,
    };
  },
};
