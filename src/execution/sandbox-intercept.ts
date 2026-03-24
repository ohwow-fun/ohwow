/**
 * Sandbox Intercept — Local Runtime
 * Wraps tool dispatch to return mock results from historical recordings
 * or static defaults. Used for digital twin testing.
 */

import crypto from 'crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { ToolCallResult } from './tool-dispatch/index.js';
import { logger } from '../lib/logger.js';

interface Recording {
  tool_output: string;
  is_error: number;
}

/**
 * Create a sandbox tool dispatcher that intercepts all tool calls.
 */
export function createSandboxDispatcher(
  db: DatabaseAdapter,
  agentId: string,
): (toolName: string, input: Record<string, unknown>) => Promise<ToolCallResult> {
  return async (toolName: string, input: Record<string, unknown>): Promise<ToolCallResult> => {
    const inputHash = crypto.createHash('md5')
      .update(`${toolName}:${JSON.stringify(input)}`)
      .digest('hex');

    // Try record-replay
    try {
      const { data: recordings } = await db
        .from('agent_workforce_tool_recordings')
        .select('tool_output, is_error')
        .eq('agent_id', agentId)
        .eq('tool_name', toolName)
        .eq('input_hash', inputHash)
        .order('created_at', { ascending: false })
        .limit(1);

      if (recordings && recordings.length > 0) {
        const rec = recordings[0] as unknown as Recording;
        return {
          content: String(rec.tool_output),
          is_error: !!rec.is_error,
        };
      }
    } catch (err) {
      logger.debug({ err, tool: toolName }, 'Sandbox recording lookup failed');
    }

    // Static default
    return {
      content: JSON.stringify({ success: true, message: `[Sandbox] Tool "${toolName}" simulated` }),
      is_error: false,
    };
  };
}
