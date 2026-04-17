/**
 * Per-task tool-list builder — the ~95-LOC block inside
 * RuntimeEngine.executeTask that connects MCP clients (with per-
 * allowlist server filtering), assembles the base tool surface with
 * conditional pushes (web search, browser, desktop, scrapling, doc
 * mounts, filesystem, bash, drafts, MCP tools), and runs the
 * allowlist-aware policy filter.
 *
 * Extracted so executeTask stops owning the connect logic inline.
 * Uses the `this: RuntimeEngine` parameter pattern for access to
 * `this.config`, `this.db`, `this.emit`, `this.pendingElicitations`,
 * etc. — matching the shape C4/C5 use.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { WebSearchTool20250305 } from '@anthropic-ai/sdk/resources/messages/messages';
import type { RuntimeEngine } from './engine.js';
import type { TaskCapabilities } from './task-capabilities.js';
import type { McpServerConfig } from '../mcp/types.js';
import { McpClientManager } from '../mcp/index.js';
import { REQUEST_BROWSER_TOOL } from './browser/index.js';
import { REQUEST_DESKTOP_TOOL } from './desktop/index.js';
import {
  X_POSTING_HEAD_TOOL_DEFINITIONS,
  X_POSTING_DELETE_TOOL_DEFINITIONS,
} from '../orchestrator/tools/x-posting.js';
import { THREADS_POSTING_TOOL_DEFINITIONS } from '../orchestrator/tools/threads-posting.js';
import { X_REPLY_TOOL_DEFINITIONS } from '../orchestrator/tools/x-reply.js';
import { THREADS_REPLY_TOOL_DEFINITIONS } from '../orchestrator/tools/threads-reply.js';
import { X_DELETE_REPLY_TOOL_DEFINITIONS } from '../orchestrator/tools/x-delete.js';
import { THREADS_DELETE_TOOL_DEFINITIONS } from '../orchestrator/tools/threads-delete.js';
import { DRAFT_TOOL_DEFINITIONS } from './draft-tools.js';
import { SCRAPLING_TOOL_DEFINITIONS } from './scrapling/index.js';
import { FILESYSTEM_TOOL_DEFINITIONS } from './filesystem/index.js';
import { BASH_TOOL_DEFINITIONS } from './bash/index.js';
import { DOC_MOUNT_TOOL_DEFINITIONS } from './doc-mounts/index.js';
import { STATE_TOOL_DEFINITIONS } from './state/index.js';
import { HOST_REACH_TOOL_DEFINITIONS } from './host/index.js';
import { LOG_TAIL_TOOL_DEFINITIONS } from './observability/index.js';
import { filterToolsByPolicy } from './agent-tool-policy.js';
import { logger } from '../lib/logger.js';
import crypto from 'crypto';

/**
 * Per-iteration web search tool definition. Kept local to tool-list.ts
 * because engine.ts used a top-level `WEB_SEARCH_TOOL` const that we're
 * no longer exporting.
 */
const WEB_SEARCH_TOOL: WebSearchTool20250305 = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 5,
};

export interface TaskToolListResult {
  tools: Array<WebSearchTool20250305 | Tool>;
  mcpClients: McpClientManager | null;
}

export async function buildTaskToolList(
  this: RuntimeEngine,
  args: {
    caps: TaskCapabilities;
    taskInput: unknown;
    agentId: string;
    taskId: string;
  },
): Promise<TaskToolListResult> {
  const { caps, taskInput, agentId, taskId } = args;

  // Connect MCP clients (global servers merged with per-agent servers)
  let mcpClients: McpClientManager | null = null;
  if (caps.mcpEnabled) {
    // Global servers: config file takes precedence; fall back to
    // runtime_settings table. The SQLite adapter auto-parses JSON
    // columns on read, so `value` may already be an array. Accept
    // either shape so historical rows still load.
    let globalServers: McpServerConfig[] = this.config.mcpServers ?? [];
    if (globalServers.length === 0) {
      const { data: mcpSetting } = await this.db
        .from('runtime_settings')
        .select('value')
        .eq('key', 'global_mcp_servers')
        .maybeSingle();
      if (mcpSetting) {
        const raw = (mcpSetting as { value: unknown }).value;
        if (Array.isArray(raw)) {
          globalServers = raw as McpServerConfig[];
        } else if (typeof raw === 'string') {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) globalServers = parsed as McpServerConfig[];
          } catch {
            globalServers = [];
          }
        }
      }
    }
    // When an allowlist references specific MCP servers, load only those.
    // The operator said "exactly these mcp__<server>__<tool> names" — we
    // should not connect to every registered server on every task, both
    // for latency and for blast-radius reasons.
    const filteredGlobalServers = caps.toolPolicy.requiresMcp
      ? globalServers.filter((s) => caps.toolPolicy.referencedMcpServers.has(s.name))
      : globalServers;
    if (caps.toolPolicy.requiresMcp) {
      const missing = [...caps.toolPolicy.referencedMcpServers].filter(
        (name) => !globalServers.some((s) => s.name === name) && !caps.agentMcpServers.some((s) => s.name === name),
      );
      if (missing.length > 0) {
        logger.warn(
          { agentId, taskId, missing },
          '[RuntimeEngine] Agent allowlist references MCP servers that are not registered in this workspace',
        );
      }
    }
    const allServers = [...filteredGlobalServers, ...caps.agentMcpServers];
    if (allServers.length > 0) {
      mcpClients = await McpClientManager.connect(allServers, {
        onElicitation: async (serverName, message, schema) => {
          const requestId = crypto.randomUUID();
          this.emit('mcp:elicitation', { requestId, taskId, serverName, message, schema });
          return new Promise<Record<string, unknown> | null>((resolve) => {
            this.pendingElicitations.set(requestId, resolve);
            // Auto-decline after 5 minutes to prevent indefinite hangs
            setTimeout(() => {
              if (this.pendingElicitations.has(requestId)) {
                this.pendingElicitations.delete(requestId);
                resolve(null);
              }
            }, 5 * 60 * 1000);
          });
        },
      });
    }
  }

  // Build combined tool list — request_browser is lightweight, included by default
  let tools: Array<WebSearchTool20250305 | Tool> = [];
  // State tools always available — agents need cross-task persistence
  tools.push(...STATE_TOOL_DEFINITIONS);
  // Host-reach tools always available — typed wrappers for notify, speak,
  // clipboard, open_url. Allowlist mode will filter these out downstream
  // via filterToolsByPolicy if the agent isn't meant to have them.
  tools.push(...HOST_REACH_TOOL_DEFINITIONS);
  // log_tail: provider CLI wrappers (supabase/vercel/fly/modal). Always
  // injected; graceful no-op when the CLI or credentials are missing.
  tools.push(...LOG_TAIL_TOOL_DEFINITIONS);
  if (caps.webSearchEnabled) tools.push(WEB_SEARCH_TOOL);

  // When SOP explicitly says "Do NOT use request_browser", exclude it from tools
  // so the model can't even call it. Same for desktop exclusion.
  const sopTaskInput = String(taskInput || '');
  const sopExcludesBrowser = sopTaskInput.includes('Do NOT use request_browser');
  const sopExcludesDesktop = sopTaskInput.includes('Do NOT use request_desktop');
  void sopExcludesDesktop; // preserve the string-sniff even though the
  // original code intentionally still pushes desktop regardless (see
  // comment below). Leaving the variable live documents the load-
  // bearing substring so a future contributor doesn't accidentally
  // strip the sniff.

  if (caps.browserEnabled && !sopExcludesBrowser) tools.push(REQUEST_BROWSER_TOOL);
  if (caps.desktopEnabled) tools.push(REQUEST_DESKTOP_TOOL);
  // X posting tools (x_compose_tweet, thread, article, list_dms, send_dm,
  // delete_tweet). These drive the user's real Chrome via CDP and the
  // tool-executor path pins the right profile via `ensureProfileChrome`
  // before any type/click — so they're safe to expose alongside the
  // browser/desktop surface. Previously they only lived in the chat
  // orchestrator catalog, leaving task agents (content-cadence's
  // "Post one tweet today", deferred-action dispatches, etc.) without
  // any posting tool — react_trace would show the agent calling
  // get_state + producing a markdown fallback because it had no way
  // to actually post. Gated on browserEnabled OR desktopEnabled
  // because X posting doesn't care which surface activated (both
  // flows end at the same debug Chrome on :9222).
  if (caps.browserEnabled || caps.desktopEnabled) {
    tools.push(...X_POSTING_HEAD_TOOL_DEFINITIONS);
    tools.push(...X_POSTING_DELETE_TOOL_DEFINITIONS);
    tools.push(...X_REPLY_TOOL_DEFINITIONS);
    tools.push(...X_DELETE_REPLY_TOOL_DEFINITIONS);
    tools.push(...THREADS_POSTING_TOOL_DEFINITIONS);
    tools.push(...THREADS_REPLY_TOOL_DEFINITIONS);
    tools.push(...THREADS_DELETE_TOOL_DEFINITIONS);
  }
  // If SOP excludes desktop, still include it — desktop is rarely excluded
  // When real Chrome is available via CDP, skip Scrapling — Chrome handles
  // both public and authenticated pages. Scrapling is only useful as a
  // lightweight fallback when no browser is available.
  const useScrapling = caps.scraplingEnabled && this.config.browserTarget !== 'chrome';
  if (useScrapling) tools.push(...SCRAPLING_TOOL_DEFINITIONS);
  if (useScrapling) tools.push(...DOC_MOUNT_TOOL_DEFINITIONS);
  if (caps.localFilesEnabled && caps.fileAccessGuard) tools.push(...FILESYSTEM_TOOL_DEFINITIONS);
  if (caps.bashEnabled && caps.fileAccessGuard) tools.push(...BASH_TOOL_DEFINITIONS);
  if (caps.approvalRequired) tools.push(...DRAFT_TOOL_DEFINITIONS);
  if (mcpClients) tools.push(...mcpClients.getToolDefinitions());

  // Per-agent tool scoping: filter tools by the resolved policy.
  // In allowlist mode the filter is strict — only names in the list
  // survive, which is what lets a narrow `ohwow_create_agent`
  // allowlist produce an exactly-that-many-tools tool surface.
  tools = filterToolsByPolicy(tools, caps.toolPolicy);

  return { tools, mcpClients };
}
