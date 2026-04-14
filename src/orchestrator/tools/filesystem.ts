/**
 * Filesystem Tool Handlers for the Orchestrator
 * Loads file access paths for '__orchestrator__' and delegates to the shared executor.
 */

import { basename, isAbsolute, resolve as resolvePath } from 'path';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { FileAccessGuard, executeFilesystemTool } from '../../execution/filesystem/index.js';
import { recordDeliverable, type DeliverableType } from '../deliverables-recorder.js';
import { loadWorkspaceDefaultPaths } from '../../db/workspace-paths.js';
import { DEFAULT_CONFIG_DIR } from '../../config.js';

/** Cached guard per workspace+cwd combination to avoid re-querying on every tool call. */
let cachedGuard: FileAccessGuard | null = null;
let cachedKey: string | null = null;

async function getGuard(ctx: LocalToolContext): Promise<FileAccessGuard | null> {
  const key = ctx.workspaceId;
  if (cachedGuard && cachedKey === key) {
    return cachedGuard;
  }

  // Workspace-level defaults (default_filesystem_paths, e.g. /tmp) are the
  // single source of truth shared with engine.ts agent execution. Admins
  // can extend it per-workspace; per-orchestrator overrides still extend
  // the union via the legacy agent_file_access_paths rows keyed on the
  // '__orchestrator__' pseudo-agent.
  const workspacePaths = await loadWorkspaceDefaultPaths(ctx.db, ctx.workspaceId);

  const { data } = await ctx.db
    .from('agent_file_access_paths')
    .select('path')
    .eq('agent_id', '__orchestrator__')
    .eq('workspace_id', ctx.workspaceId);

  const configuredPaths = data ? (data as Array<{ path: string }>).map((p) => p.path) : [];
  // Always allow the orchestrator to read/write its own data directory
  // (~/.ohwow by default). Without this, any self-management task that
  // touches config.json, workspace layout, logs, or skills has to go
  // through a permission prompt that doesn't exist in async-dispatch mode.
  // The path is resolved from config.ts (which honors OHWOW_HOME), so it
  // stays portable across machines and CI — never a hardcoded home path.
  const paths = Array.from(new Set([...workspacePaths, ...configuredPaths, DEFAULT_CONFIG_DIR]));
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

/**
 * Map a file extension to the deliverable_type the dashboard activity
 * timeline knows how to render. Conservative defaults keep us from
 * over-claiming "code" for every .md or .txt — the dashboard renders
 * documents and code differently (download vs preview vs syntax-
 * highlighted block).
 */
function deliverableTypeForPath(filePath: string): DeliverableType {
  const lower = filePath.toLowerCase();
  if (/\.(ts|tsx|js|jsx|py|rb|go|rs|java|sql|sh|c|cpp|h|html|css|json|yml|yaml|toml)$/.test(lower)) {
    return 'code';
  }
  if (/\.(png|jpg|jpeg|gif|webp|svg|mp4|webm|mov|wav|mp3|ogg|m4a)$/.test(lower)) {
    return 'media';
  }
  return 'document';
}

export async function localWriteFile(ctx: LocalToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const result = await handleFilesystemTool(ctx, 'local_write_file', input);
  if (result.success) {
    // Auto-record a deliverable so the dashboard activity timeline
    // sees the artifact. Fire-and-forget — never blocks the caller.
    const path = (input.path as string | undefined) ?? '';
    const content = (input.content as string | undefined) ?? '';
    void recordDeliverable(ctx, {
      title: path ? basename(path) : 'Untitled file',
      type: deliverableTypeForPath(path),
      content: { file_path: path, byte_size: content.length, body: content.slice(0, 4000) },
      provider: 'local-fs',
    });
  }
  return result;
}

export function localEditFile(ctx: LocalToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  return handleFilesystemTool(ctx, 'local_edit_file', input);
}
