/**
 * Task capability resolution — the ~160-LOC block inside
 * RuntimeEngine.executeTask that reads agentConfig + workspace baseline +
 * task input and produces the feature-flag set, allowlist-filtered tool
 * policy, file access guard, doc auto-mount expansion, and goal context
 * the rest of executeTask consumes.
 *
 * Extracted so executeTask stops being a 1800-LOC method. The function
 * takes `this: RuntimeEngine` so it can read `this.db`, `this.config`,
 * and `this.docMountManager` without threading them through args.
 * LocalOrchestrator stripped `private` for the same reason in Phase B;
 * Phase C3.5 did the same for RuntimeEngine.
 */

import type { RuntimeEngine } from './engine.js';
import type { DesktopServiceOptions } from './desktop/index.js';
import type { McpServerConfig } from '../mcp/types.js';
import { FileAccessGuard } from './filesystem/index.js';
import { loadWorkspaceDefaultPaths } from '../db/workspace-paths.js';
import {
  resolveAgentToolPolicy,
  allowlistPermits,
  type ResolvedAgentToolPolicy,
} from './agent-tool-policy.js';
import { logger } from '../lib/logger.js';

export interface TaskCapabilityInput {
  agentConfig: Record<string, unknown>;
  agentId: string;
  workspaceId: string;
  task: {
    input: string | unknown;
    goal_id: string | null;
  };
  /**
   * Ephemeral filesystem grants attached to this specific task run by an
   * "approve once" decision on a paused permission request. Union'd into
   * the FileAccessGuard alongside the workspace baseline + per-agent
   * paths, so the resumed child task can complete without persisting a
   * row in agent_file_access_paths.
   */
  permissionGrants?: string[];
}

export interface TaskCapabilities {
  toolPolicy: ResolvedAgentToolPolicy;
  webSearchEnabled: boolean;
  browserEnabled: boolean;
  scraplingEnabled: boolean;
  localFilesEnabled: boolean;
  bashEnabled: boolean;
  mcpEnabled: boolean;
  devopsEnabled: boolean;
  desktopEnabled: boolean;
  approvalRequired: boolean;
  autonomyLevel: number;
  agentMcpServers: McpServerConfig[];
  desktopOptions: Partial<DesktopServiceOptions>;
  /**
   * Mutable — the ReAct loop reassigns this when a doc auto-mount expands
   * the allowed-paths set mid-turn. Callers should read from the caps
   * object directly, not snapshot it.
   */
  fileAccessGuard: FileAccessGuard | null;
  goalContext: string | undefined;
}

/**
 * Resolve the full per-task capability surface: feature flags derived
 * from the agent's config + allowlist mode, the file access guard built
 * from the workspace baseline plus any per-agent path rows, doc auto-
 * mount expansion into the guard, and goal context loaded when the task
 * is linked to a strategic goal.
 */
export async function resolveTaskCapabilities(
  this: RuntimeEngine,
  { agentConfig, agentId, workspaceId, task, permissionGrants }: TaskCapabilityInput,
): Promise<TaskCapabilities> {
  const toolPolicy = resolveAgentToolPolicy(agentConfig);
  const isAllowlistMode = toolPolicy.mode === 'allowlist';

  const webSearchEnabled = isAllowlistMode
    ? allowlistPermits(toolPolicy, 'web_search')
    : agentConfig.web_search_enabled === true; // opt-in: default false (narrower than legacy)
  const browserEnabled = isAllowlistMode
    ? allowlistPermits(toolPolicy, 'request_browser')
    : agentConfig.browser_enabled !== false;
  const autonomyLevel: number = (agentConfig.autonomy_level as number) ?? 2;
  const approvalRequired = autonomyLevel === 1;

  const scraplingEnabled = isAllowlistMode
    ? allowlistPermits(toolPolicy, 'scrape_url')
    : agentConfig.scraping_enabled !== false;
  // Local file access is enabled when:
  //   1. Allowlist mode includes a filesystem tool, OR
  //   2. The agent explicitly opts in via local_files_enabled === true, OR
  //   3. The workspace has any default_filesystem_paths configured AND the
  //      agent has not explicitly opted out (local_files_enabled === false).
  //
  // The workspace-baseline branch is what actually unblocks SOP-delegated
  // agents that nobody ever set local_files_enabled on. Without it, every
  // such agent silently fails any local_write_file call because the gate
  // is closed regardless of how many paths the workspace has provided.
  // Explicit opt-out (false) still wins so admins can lock down agents.
  const explicitFsFlag = agentConfig.local_files_enabled;
  const workspaceFsBaseline = await loadWorkspaceDefaultPaths(this.db, workspaceId);
  const localFilesEnabled = isAllowlistMode
    ? allowlistPermits(toolPolicy, 'local_list_directory')
    : explicitFsFlag === true || (explicitFsFlag !== false && workspaceFsBaseline.length > 0);
  const bashEnabled = isAllowlistMode
    ? allowlistPermits(toolPolicy, 'run_bash')
    : agentConfig.bash_enabled === true;
  // MCP is enabled when the agent opts in OR when the allowlist contains
  // any `mcp__<server>__<tool>` entry. The latter is the auto-enable
  // signal documented for the MCP typed tools — adding an MCP tool name
  // to the allowlist implicitly asks the engine to load that server.
  const mcpEnabled = agentConfig.mcp_enabled === true || toolPolicy.requiresMcp;
  const devopsEnabled = isAllowlistMode
    ? false
    : agentConfig.devops_enabled === true;
  // Desktop/browser can be enabled via agent config OR via SOP in the task input.
  // The workspace-level desktopToolsEnabled kill switch always wins: when the
  // workspace has desktop disabled (default), no agent gets desktop tools
  // regardless of its own opt-in. Agents that previously relied on desktop
  // need their workspace opted in via workspace.json `desktopToolsEnabled: true`
  // or globally via OHWOW_DESKTOP_TOOLS_ENABLED=true.
  const sopTaskInputForCaps = String(task.input || '');
  const sopNeedsDesktop = sopTaskInputForCaps.includes('request_desktop') || sopTaskInputForCaps.includes('desktop_focus_app');
  const workspaceDesktopAllowed = this.config.desktopToolsEnabled === true;
  const desktopEnabledRaw = isAllowlistMode
    ? allowlistPermits(toolPolicy, 'request_desktop')
    : (agentConfig.desktop_enabled === true || agentConfig.desktop_enabled === 1 || sopNeedsDesktop);
  const desktopEnabled = workspaceDesktopAllowed && desktopEnabledRaw;
  const desktopRecordingEnabled = agentConfig.desktop_recording_enabled === true;
  const desktopPreActionScreenshots = agentConfig.desktop_pre_action_screenshots === true;
  const desktopAllowedApps: string[] = (agentConfig.desktop_allowed_apps as string[]) ?? [];
  const agentMcpServers: McpServerConfig[] = (agentConfig.mcp_servers as McpServerConfig[]) ?? [];

  // Auto-inject GitHub MCP server for devops-enabled agents
  if (devopsEnabled && mcpEnabled) {
    const hasGitHub = agentMcpServers.some((s) => s.name === 'github');
    if (!hasGitHub && process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
      agentMcpServers.push({
        name: 'github',
        transport: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN },
      });
    }
  }

  // Desktop service options (passed via buildToolContext → request-desktop-executor)
  const desktopOptions: Partial<DesktopServiceOptions> = {
    enableRecording: desktopRecordingEnabled,
    enablePreActionScreenshots: desktopPreActionScreenshots,
    allowedApps: desktopAllowedApps,
    autonomyLevel,
  };

  // Build the file access guard from the workspace baseline (already
  // loaded above for the gate decision) plus any per-agent path rows.
  // The workspace baseline is the same source of truth used by
  // orchestrator chat (filesystem.ts), so admins manage one set of
  // paths and both the orchestrator and per-agent execution see them.
  let fileAccessGuard: FileAccessGuard | null = null;
  if (localFilesEnabled) {
    const { data: pathData } = await this.db
      .from('agent_file_access_paths')
      .select('path')
      .eq('agent_id', agentId);

    const agentPaths = pathData
      ? (pathData as Array<{ path: string }>).map((p) => p.path)
      : [];

    const ephemeralGrants = permissionGrants ?? [];
    const merged = Array.from(new Set([
      ...workspaceFsBaseline,
      ...agentPaths,
      ...ephemeralGrants,
    ]));
    if (merged.length > 0) {
      fileAccessGuard = new FileAccessGuard(merged);
    }
  }

  // Auto-mount declared documentation for this agent
  const mountedDocs: string[] = (() => {
    try {
      const raw = agentConfig.mounted_docs;
      if (Array.isArray(raw)) return raw as string[];
      if (typeof raw === 'string') return JSON.parse(raw) as string[];
      return [];
    } catch { return []; }
  })();

  if (mountedDocs.length > 0) {
    for (const docUrl of mountedDocs) {
      try {
        const existing = await this.docMountManager.getMountByUrl(docUrl, workspaceId);
        if (existing && existing.status === 'ready') {
          // Already mounted — expand file access
          const current = fileAccessGuard?.getAllowedPaths() ?? [];
          fileAccessGuard = new FileAccessGuard([...current, existing.mountPath]);
        } else if (!existing) {
          // Mount in background — don't block task start
          this.docMountManager.mount(docUrl, workspaceId).catch((err) => {
            logger.warn({ err, url: docUrl }, '[engine] Background doc mount failed');
          });
        } else if (existing.status === 'stale' || existing.status === 'failed') {
          // Stale/failed — still serve from disk if available, refresh in background
          const current = fileAccessGuard?.getAllowedPaths() ?? [];
          fileAccessGuard = new FileAccessGuard([...current, existing.mountPath]);
          this.docMountManager.refreshIfStale(existing.id).catch((err) => {
            logger.warn({ err, url: docUrl }, '[engine] Background doc refresh failed');
          });
        }
      } catch (err) {
        logger.warn({ err, url: docUrl }, '[engine] Auto-mount check failed');
      }
    }
  }

  // Load goal context if task is linked to a goal
  let goalContext: string | undefined;
  if (task.goal_id) {
    const { data: goalData } = await this.db
      .from('agent_workforce_goals')
      .select('title, description, target_metric, target_value, current_value, unit')
      .eq('id', task.goal_id)
      .single();

    if (goalData) {
      const g = goalData as { title: string; description?: string; target_metric?: string; target_value?: number; current_value?: number; unit?: string };
      const parts = [`## Strategic Goal\nThis task contributes to: "${g.title}"`];
      if (g.description) parts.push(`Why: ${g.description}`);
      if (g.target_metric) {
        parts.push(`Target: ${g.current_value ?? 0}${g.unit || ''} \u2192 ${g.target_value}${g.unit || ''} (${g.target_metric})`);
      }
      parts.push('Keep this goal in mind when making decisions about scope, tone, and priorities.');
      goalContext = parts.join('\n');
    }
  }

  return {
    toolPolicy,
    webSearchEnabled,
    browserEnabled,
    scraplingEnabled,
    localFilesEnabled,
    bashEnabled,
    mcpEnabled,
    devopsEnabled,
    desktopEnabled,
    approvalRequired,
    autonomyLevel,
    agentMcpServers,
    desktopOptions,
    fileAccessGuard,
    goalContext,
  };
}
