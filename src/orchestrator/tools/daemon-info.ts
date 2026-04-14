/**
 * get_daemon_info
 *
 * Returns the canonical paths and runtime identifiers the ohwow daemon
 * is using on this machine. Exists because models kept guessing paths
 * like "~/.ohwow/ohwow.sqlite" (wrong) when writing sqlite3 commands,
 * or "ops-monitoring-playbook.md" (relative, resolves to daemon cwd)
 * when reading files. One canonical source of truth prevents all of it.
 *
 * Post-multi-workspace migration, the daemon's real data dir is
 * ~/.ohwow/workspaces/<name>/ — NOT the legacy ~/.ohwow/data/ path.
 * This tool calls resolveActiveWorkspace() so the paths it returns are
 * always correct for whichever workspace this daemon is running under.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { resolveActiveWorkspace, loadConfig } from '../../config.js';
import { VERSION } from '../../version.js';

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
  // Live runtime layout — always correct regardless of which workspace
  // the daemon is running under. Post-migration this is
  // ~/.ohwow/workspaces/<name>/, NOT the legacy ~/.ohwow/data/ path.
  const ohwowDir = join(homedir(), '.ohwow');
  const activeWs = resolveActiveWorkspace();
  const runtimeDb = activeWs.dbPath;
  const dataDir = activeWs.dataDir;
  const daemonToken = join(dataDir, 'daemon.token');
  const daemonLog = join(dataDir, 'daemon.log');
  const screenshotsDir = join(dataDir, 'screenshots');
  const configPath = join(ohwowDir, 'config.json');
  const mediaDir = join(ohwowDir, 'media');

  // Live config — expose the real port + model instead of hardcoding 7700
  // and guessing at the model name.
  const config = loadConfig();
  const daemonPort = config.port;
  const daemonBaseUrl = `http://localhost:${daemonPort}`;

  // Repo paths (best-effort — daemon might be running from anywhere)
  const cwd = ctx.workingDirectory || process.cwd();
  const ohwowRepo = findAncestorWithFile(cwd, 'package.json', 'ohwow') ?? cwd;
  const ohwowFunRepo = findSiblingRepo(ohwowRepo, 'ohwow.fun');

  return {
    success: true,
    data: {
      // Runtime identity
      version: VERSION,
      workspaceId: ctx.workspaceId,
      workspaceName: activeWs.name,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      // Model + provider selection
      orchestratorModel: config.orchestratorModel || null,
      cloudModel: config.cloudModel || null,
      ollamaModel: config.ollamaModel || null,
      modelSource: config.modelSource,
      cloudProvider: config.cloudProvider,
      // Network
      daemonPort,
      daemonBaseUrl,
      daemonHealthUrl: `${daemonBaseUrl}/health`,
      // Filesystem layout
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
      // Examples the model can cite verbatim without guessing paths
      sqliteCliExample: `sqlite3 ${runtimeDb} "SELECT name FROM sqlite_master WHERE type='table' LIMIT 20;"`,
      authHeaderExample: `Authorization: Bearer $(cat ${daemonToken})`,
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
