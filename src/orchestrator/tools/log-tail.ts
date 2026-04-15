/**
 * log_tail handler for the orchestrator.
 *
 * Wraps the shared `executeLogTail` executor into LocalToolContext's
 * success/error shape. No workspace state is needed — the tool reads
 * env vars and spawns provider CLIs.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { executeLogTail } from '../../execution/observability/index.js';

export async function logTailHandler(
  _ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const result = await executeLogTail(input ?? {});
    if (result.is_error) {
      return { success: false, error: result.content };
    }
    return { success: true, data: result.content };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'log_tail failed',
    };
  }
}
