/**
 * Filesystem Tool Handlers for the Orchestrator
 * Loads file access paths for '__orchestrator__' and delegates to the shared executor.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { FileAccessGuard, executeFilesystemTool } from '../../execution/filesystem/index.js';

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
export function invalidateFileAccessCache(): void {
  cachedGuard = null;
  cachedKey = null;
}

async function handleFilesystemTool(
  ctx: LocalToolContext,
  toolName: string,
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
    const result = await executeFilesystemTool(guard, toolName, input);
    if (result.is_error) {
      if (result.content.includes('Path is outside the allowed directories.')) {
        const requestedPath = input.path as string | undefined;
        return { success: false, error: result.content, needsPermission: requestedPath || '' };
      }
      return { success: false, error: result.content };
    }
    return { success: true, data: result.content };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Filesystem tool failed',
    };
  }
}

export function localListDirectory(ctx: LocalToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  return handleFilesystemTool(ctx, 'local_list_directory', input);
}

export function localReadFile(ctx: LocalToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  return handleFilesystemTool(ctx, 'local_read_file', input);
}

export function localSearchFiles(ctx: LocalToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  return handleFilesystemTool(ctx, 'local_search_files', input);
}

export function localSearchContent(ctx: LocalToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  return handleFilesystemTool(ctx, 'local_search_content', input);
}

export function localWriteFile(ctx: LocalToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  return handleFilesystemTool(ctx, 'local_write_file', input);
}

export function localEditFile(ctx: LocalToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  return handleFilesystemTool(ctx, 'local_edit_file', input);
}
