/**
 * Workspace-level default filesystem paths.
 *
 * Single source of truth for "what /tmp-like paths are always allowed for
 * any agent in this workspace." Both engine.ts (per-agent task execution)
 * and orchestrator/tools/filesystem.ts (orchestrator chat) read the same
 * column so the model sees a consistent FS surface no matter which path
 * dispatched the tool call.
 *
 * Stored as a JSON array string in agent_workforce_workspaces.default_filesystem_paths
 * to avoid a separate join table for what is fundamentally a small list.
 */

import type { DatabaseAdapter } from './adapter-types.js';
import { logger } from '../lib/logger.js';

const FALLBACK_PATHS = ['/tmp'];

/**
 * Load the default filesystem paths configured for a workspace.
 * Falls back to ['/tmp'] if the workspace row is missing, the column is
 * null, or the JSON is malformed — matching the migration default and
 * the prior orchestrator-only baseline.
 */
export async function loadWorkspaceDefaultPaths(
  db: DatabaseAdapter,
  workspaceId: string,
): Promise<string[]> {
  try {
    const { data, error } = await db
      .from<{ default_filesystem_paths: string | null }>('agent_workforce_workspaces')
      .select('default_filesystem_paths')
      .eq('id', workspaceId)
      .maybeSingle();

    if (error || !data) return [...FALLBACK_PATHS];

    const raw = (data as { default_filesystem_paths: string | null }).default_filesystem_paths;
    if (!raw) return [...FALLBACK_PATHS];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...FALLBACK_PATHS];

    const paths = parsed.filter((p): p is string => typeof p === 'string' && p.length > 0);
    return paths.length > 0 ? paths : [...FALLBACK_PATHS];
  } catch (err) {
    logger.warn({ err, workspaceId }, '[workspace-paths] Failed to load default fs paths, using fallback');
    return [...FALLBACK_PATHS];
  }
}
