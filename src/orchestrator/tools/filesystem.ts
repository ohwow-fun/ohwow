/**
 * Filesystem Tool Handlers for the Orchestrator
 * Loads file access paths for '__orchestrator__' and delegates to the shared executor.
 */

import { isAbsolute, resolve as resolvePath } from 'path';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { FileAccessGuard, executeFilesystemTool } from '../../execution/filesystem/index.js';

/** Cached guard per workspace+cwd combination to avoid re-querying on every tool call. */
let cachedGuard: FileAccessGuard | null = null;
let cachedKey: string | null = null;

/**
 * Paths that are always allowed for orchestrator file ops on top of
 * whatever the workspace has configured. /tmp is ephemeral per-user
 * scratch space that ops tasks routinely need for reading CLI output,
 * writing intermediate artifacts, or staging files before upload. Not
 * including it by default means simple dogfood loops (read /tmp/foo.md
 * to stage a knowledge doc) silently fail with "Path is outside allowed
 * directories" even though every shell user already has full access.
 */
const BASELINE_ORCHESTRATOR_PATHS = ['/tmp'];

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

  const configuredPaths = data ? (data as Array<{ path: string }>).map((p) => p.path) : [];
  // Deduplicate baseline + configured paths.
  const paths = Array.from(new Set([...BASELINE_ORCHESTRATOR_PATHS, ...configuredPaths]));
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

/**
 * Normalize a path input so relative paths resolve against the agent's
 * working directory instead of silently resolving against the daemon
 * process cwd (which is almost never what the model wanted). A relative
 * path that the model typed hoping it was "next to the file on disk"
 * would otherwise land inside /Users/jesus/Documents/ohwow/ohwow/ and
 * return ENOENT for paths that obviously exist.
 */
function normalizePathInput(
  input: Record<string, unknown>,
  ctx: LocalToolContext,
): Record<string, unknown> {
  const rawPath = input.path;
  if (typeof rawPath !== 'string' || !rawPath) return input;
  if (isAbsolute(rawPath)) return input;
  const base = ctx.workingDirectory || process.cwd();
  return { ...input, path: resolvePath(base, rawPath) };
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

  const normalizedInput = normalizePathInput(input, ctx);

  try {
    const result = await executeFilesystemTool(guard, toolName, normalizedInput);
    if (result.is_error) {
      if (result.content.includes('Path is outside the allowed directories.')) {
        const requestedPath = normalizedInput.path as string | undefined;
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
