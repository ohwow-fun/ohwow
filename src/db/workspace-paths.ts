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

import fs from 'node:fs';
import { join } from 'node:path';
import type { DatabaseAdapter } from './adapter-types.js';
import { DEFAULT_CONFIG_DIR } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * ohwow-managed scratch directories that are always writable for agents,
 * regardless of workspace configuration. These are the runtime's own sandbox
 * (living-docs for agent-authored notes/diaries, media for generated assets,
 * workspaces for per-workspace state) — not the user's files. Any agent in
 * any workspace can read/write here by design.
 *
 * Kept separate from user-configured paths so an admin can never accidentally
 * revoke them and brick diary/journal/document-authoring agents.
 */
const OHWOW_MANAGED_PATHS = [
  join(DEFAULT_CONFIG_DIR, 'living-docs'),
  join(DEFAULT_CONFIG_DIR, 'media'),
  join(DEFAULT_CONFIG_DIR, 'workspaces'),
];

/**
 * Ensure ohwow-managed scratch dirs exist on disk so the guard's realpath
 * resolution doesn't drop them. Safe to call repeatedly.
 */
function ensureManagedPaths(): void {
  for (const p of OHWOW_MANAGED_PATHS) {
    try {
      fs.mkdirSync(p, { recursive: true });
    } catch (err) {
      logger.warn({ err, path: p }, '[workspace-paths] Failed to create managed dir');
    }
  }
}

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
  ensureManagedPaths();

  const withManaged = (configured: string[]): string[] => {
    const merged = [...OHWOW_MANAGED_PATHS, ...configured];
    return Array.from(new Set(merged));
  };

  try {
    const { data, error } = await db
      .from<{ default_filesystem_paths: string | string[] | null }>('agent_workforce_workspaces')
      .select('default_filesystem_paths')
      .eq('id', workspaceId)
      .maybeSingle();

    if (error || !data) return withManaged(FALLBACK_PATHS);

    // The SQLite adapter auto-parses JSON-shaped strings (`["..."]` / `{...}`)
    // back into arrays/objects. The Supabase cloud adapter returns the raw
    // text. Handle both: if it's already an array, use it; if it's a string,
    // JSON.parse it.
    const raw = (data as { default_filesystem_paths: string | string[] | null }).default_filesystem_paths;
    if (!raw) return withManaged(FALLBACK_PATHS);

    let parsed: unknown;
    if (Array.isArray(raw)) {
      parsed = raw;
    } else if (typeof raw === 'string') {
      parsed = JSON.parse(raw);
    } else {
      return withManaged(FALLBACK_PATHS);
    }

    if (!Array.isArray(parsed)) return withManaged(FALLBACK_PATHS);

    const paths = parsed.filter((p): p is string => typeof p === 'string' && p.length > 0);
    return withManaged(paths.length > 0 ? paths : FALLBACK_PATHS);
  } catch (err) {
    logger.warn({ err, workspaceId }, '[workspace-paths] Failed to load default fs paths, using fallback');
    return withManaged(FALLBACK_PATHS);
  }
}
