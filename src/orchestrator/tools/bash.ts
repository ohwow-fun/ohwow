/**
 * Bash Tool Handler for the Orchestrator
 * Reuses the filesystem guard and delegates to the shared bash executor.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { FileAccessGuard } from '../../execution/filesystem/index.js';
import { executeBashTool } from '../../execution/bash/index.js';

/** Cached guard per workspace+cwd combination to avoid re-querying on every tool call. */
let cachedGuard: FileAccessGuard | null = null;
let cachedKey: string | null = null;

async function getGuard(ctx: LocalToolContext): Promise<FileAccessGuard | null> {
  const key = ctx.workspaceId;
  if (cachedGuard && cachedKey === key) {
    return cachedGuard;
  }

  const { data } = await ctx.db
    .from('agent_file_access_paths')
    .select('path')
    .eq('agent_id', '__orchestrator__')
    .eq('workspace_id', ctx.workspaceId);

  const paths = data ? (data as Array<{ path: string }>).map((p) => p.path) : [];
  if (paths.length === 0) return null;

  cachedGuard = new FileAccessGuard(paths);
  cachedKey = key;
  return cachedGuard;
}

/** Invalidate the cached guard (call when paths change). */
export function invalidateBashAccessCache(): void {
  cachedGuard = null;
  cachedKey = null;
}

export async function localRunBash(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const guard = await getGuard(ctx);
  if (!guard) {
    return {
      success: false,
      error: 'No directories are configured for file access. Add allowed directories in Settings.',
    };
  }

  try {
    const result = await executeBashTool(guard, 'run_bash', input, { gitEnabled: true });
    if (result.is_error) {
      if (result.content.includes('outside allowed paths')) {
        const requestedPath = input.working_directory as string | undefined;
        return { success: false, error: result.content, needsPermission: requestedPath || '' };
      }
      return { success: false, error: result.content };
    }
    return { success: true, data: result.content };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Bash tool failed',
    };
  }
}
