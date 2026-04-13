/**
 * get_daemon_info
 *
 * Returns the canonical paths and runtime identifiers the ohwow daemon
 * is using on this machine. Exists because models kept guessing paths
 * like "~/.ohwow/ohwow.sqlite" (wrong) when writing sqlite3 commands,
 * or "ops-monitoring-playbook.md" (relative, resolves to daemon cwd)
 * when reading files. One canonical source of truth prevents all of it.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';

export const DAEMON_INFO_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'get_daemon_info',
    description: 'Return canonical paths, database location, and key table names for the running ohwow daemon. Call this BEFORE guessing file paths or sqlite commands — it gives you the absolute runtime.db path, auth token path, screenshots dir, repo locations, and an example sqlite3 command. Always available regardless of intent. Use it whenever an agent task involves local filesystem reads, sqlite queries, or anything that depends on where the daemon keeps its state.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

export async function getDaemonInfo(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  const ohwowDir = join(homedir(), '.ohwow');
  const dataDir = join(ohwowDir, 'data');
  const runtimeDb = join(dataDir, 'runtime.db');
  const daemonToken = join(dataDir, 'daemon.token');
  const configPath = join(ohwowDir, 'config.json');
  const screenshotsDir = join(dataDir, 'screenshots');
  const mediaDir = join(ohwowDir, 'media');
  const daemonLog = join(dataDir, 'daemon.log');

  // Repo paths (best-effort — daemon might be running from anywhere)
  const cwd = ctx.workingDirectory || process.cwd();
  const ohwowRepo = findAncestorWithFile(cwd, 'package.json', 'ohwow') ?? cwd;
  const ohwowFunRepo = findSiblingRepo(ohwowRepo, 'ohwow.fun');

  return {
    success: true,
    data: {
      workspaceId: ctx.workspaceId,
      daemonPort: 7700,
      daemonBaseUrl: 'http://localhost:7700',
      daemonHealthUrl: 'http://localhost:7700/health',
      daemonTokenPath: daemonToken,
      configPath,
      paths: {
        ohwowDir,
        dataDir,
        mediaDir,
        screenshotsDir,
        runtimeDb,
        daemonLog,
        ohwowRepo,
        ohwowFunRepo,
      },
      sqliteCliExample: `sqlite3 ${runtimeDb} "SELECT name FROM sqlite_master WHERE type='table' LIMIT 20;"`,
      authHeaderExample:
        'Authorization: Bearer $(cat ~/.ohwow/data/daemon.token)',
      keyTables: [
        'agent_workforce_agents',
        'agent_workforce_tasks',
        'agent_workforce_contacts',
        'agent_workforce_activity',
        'agent_workforce_knowledge_documents',
        'agent_workforce_knowledge_chunks',
        'llm_calls',
        'outbound_queue',
      ],
      notes: [
        'Local queries: always use the absolute runtime.db path above, not guesses like ~/.ohwow/ohwow.sqlite.',
        'Filesystem tool paths should be absolute. Relative paths resolve against the agent working directory.',
        'Cloud Supabase queries go through the cloud-data proxy: use cloud_list_contacts, cloud_list_tasks, cloud_list_agents, cloud_get_analytics, cloud_list_members, cloud_list_schedules.',
        'Knowledge docs: use get_knowledge_document (semantic fallback supported) instead of guessing file paths.',
      ],
    },
  };
}

/** Walk up from `start` until a directory contains `marker`. Returns
 * null if not found. When `expectedName` is provided, the returned
 * directory's basename must match. */
function findAncestorWithFile(
  start: string,
  marker: string,
  expectedName?: string,
): string | null {
  let current = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(current, marker))) {
      if (!expectedName || basename(current) === expectedName) return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] ?? p;
}

/** Look for a sibling repo (e.g. "ohwow.fun") next to `repoPath`. */
function findSiblingRepo(repoPath: string, siblingName: string): string | null {
  const parent = dirname(repoPath);
  const candidate = join(parent, siblingName);
  return existsSync(join(candidate, 'package.json')) ? candidate : null;
}
