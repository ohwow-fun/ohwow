/**
 * assembleOrchestratorToolSurface — pure function that builds the full
 * tool list the Anthropic / OpenRouter / Ollama chat loops hand to the
 * model each turn. Extracted from LocalOrchestrator.getTools so the
 * assembly logic has a single home and isn't duplicated mentally inside
 * the three loop bodies.
 *
 * The function takes every input explicitly so it has no class deps; the
 * orchestrator just threads its own state through.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  ORCHESTRATOR_TOOL_DEFINITIONS,
  LSP_TOOL_DEFINITIONS,
  COS_EXTENSION_TOOL_DEFINITIONS,
  FILESYSTEM_TOOL_DEFINITIONS,
  BASH_TOOL_DEFINITIONS,
  REQUEST_FILE_ACCESS_TOOL,
  filterToolsByIntent,
  extractExplicitToolNames,
  type IntentSection,
} from './tool-definitions.js';
import {
  BROWSER_TOOL_DEFINITIONS,
  REQUEST_BROWSER_TOOL,
  LIST_CHROME_PROFILES_TOOL,
} from '../execution/browser/index.js';
import {
  DESKTOP_TOOL_DEFINITIONS,
  REQUEST_DESKTOP_TOOL,
} from '../execution/desktop/index.js';
import { HOST_REACH_TOOL_DEFINITIONS } from '../execution/host/index.js';
import { runtimeToolRegistry } from './runtime-tool-registry.js';
import { logger } from '../lib/logger.js';

export interface AssembleToolSurfaceOptions {
  /** Tool names to exclude from the base catalog (per-channel config). */
  excludedTools?: string[];
  /** Whether browser tools should be injected directly (skipping the gateway). */
  browserPreActivated?: boolean;
  browserActivated: boolean;
  /** Whether desktop tools should be injected directly (skipping the gateway). */
  desktopPreActivated?: boolean;
  desktopActivated: boolean;
  desktopToolsEnabled: boolean;
  filesystemActivated: boolean;
  hasOrchestratorFileAccess: () => Promise<boolean>;
  /** Already-loaded MCP tool definitions (empty when no servers connected). */
  mcpTools: Tool[];
  /** Total MCP servers configured — used for the observability log. */
  mcpServerCount: number;
  /** Intent sections for filtering; when undefined, no intent filter is applied. */
  sections?: Set<IntentSection>;
  maxPriority?: 1 | 2 | 3;
  userMessageForToolExtraction?: string;
}

/**
 * Assemble the full per-turn tool list for an orchestrator chat loop.
 *
 * Ordering (matches the LocalOrchestrator.getTools order the snapshots pin):
 *   1. Base catalog (ORCHESTRATOR + LSP + COS_EXTENSION), with excludedTools removed
 *   2. Browser tools (full set or just the gateway)
 *   3. Desktop tools (conditional on desktopAllowed)
 *   4. Filesystem/bash tools (full set or just request_file_access)
 *   5. Intent filter runs over the above (MCP tools stay outside the filter)
 *   6. MCP tools appended
 *   7. Runtime skill registry tools appended
 */
export async function assembleOrchestratorToolSurface(
  opts: AssembleToolSurfaceOptions,
): Promise<Tool[]> {
  const allBaseTools = [
    ...ORCHESTRATOR_TOOL_DEFINITIONS,
    ...LSP_TOOL_DEFINITIONS,
    ...COS_EXTENSION_TOOL_DEFINITIONS,
  ];
  let tools: Tool[] = opts.excludedTools?.length
    ? allBaseTools.filter((t) => !opts.excludedTools!.includes(t.name))
    : [...allBaseTools];

  // Browser: inject full set if pre-activated or already activated this turn,
  // otherwise expose the gateway tool.
  if (opts.browserPreActivated || opts.browserActivated) {
    tools = [...BROWSER_TOOL_DEFINITIONS, LIST_CHROME_PROFILES_TOOL, ...tools];
  } else {
    tools = [REQUEST_BROWSER_TOOL, LIST_CHROME_PROFILES_TOOL, ...tools];
  }

  // Desktop: gated by an explicit-intent + workspace allow check. The
  // legacy behavior was to always inject REQUEST_DESKTOP_TOOL; that let a
  // confused model fall into a desktop_screenshot loop on routine tasks
  // and read window contents from unrelated applications, leaking
  // cross-workspace data into the response. Default-off; opt in either by
  // workspace setting or by the intent classifier explicitly recognizing
  // a desktop request. Once activated this turn, stay activated so
  // multi-step desktop workflows keep their tool surface.
  const desktopAllowed =
    opts.desktopToolsEnabled
    || opts.desktopPreActivated === true
    || opts.desktopActivated;
  if (desktopAllowed) {
    if (opts.desktopPreActivated || opts.desktopActivated) {
      tools = [...DESKTOP_TOOL_DEFINITIONS, ...tools];
    } else {
      tools = [REQUEST_DESKTOP_TOOL, ...tools];
    }
  }

  // Filesystem/bash: full set if activated or any allowed paths exist in DB,
  // otherwise just the gateway tool.
  if (opts.filesystemActivated || (await opts.hasOrchestratorFileAccess())) {
    tools = [...tools, ...FILESYSTEM_TOOL_DEFINITIONS, ...BASH_TOOL_DEFINITIONS];
  } else {
    tools = [...tools, REQUEST_FILE_ACCESS_TOOL];
  }

  // Host-reach tools (notify_user, speak, clipboard_read/write, open_url):
  // always injected. Typed wrappers for the macOS commands the orchestrator
  // used to compose by hand through run_bash. Per-channel excludedTools /
  // allowlists still apply downstream if a caller wants them gone.
  tools = [...tools, ...HOST_REACH_TOOL_DEFINITIONS];

  // Filter by intent sections and priority when provided. Explicit tool
  // names mentioned in the user message bypass the filter — if the user
  // writes "call upload_knowledge" or any other snake_case tool name, that
  // tool must always be loaded regardless of intent classification. This
  // is the safety valve for classifier misses, especially around word-
  // boundary quirks with underscores.
  if (opts.sections) {
    const explicitNames = opts.userMessageForToolExtraction
      ? extractExplicitToolNames(opts.userMessageForToolExtraction, tools)
      : undefined;
    tools = filterToolsByIntent(tools, opts.sections, opts.maxPriority, explicitNames);
  }

  // Append MCP tools after filtering — they pass through since they're
  // not in TOOL_SECTION_MAP and the chat loops want them unconditionally.
  if (opts.mcpTools.length > 0) {
    tools = [...tools, ...opts.mcpTools];
  }

  // Append runtime-registered code skills (synthesized tools loaded hot
  // from the workspace skills dir). They bypass intent filtering the same
  // way MCP tools do: once a synthesized tool is promoted out of probation
  // it should always be visible to the LLM. The registry itself hides
  // probation skills behind OHWOW_SYNTHESIS_DEBUG so agents don't see
  // half-tested tools during normal operation.
  const runtimeSkillDefs = runtimeToolRegistry.getToolDefinitions();
  if (runtimeSkillDefs.length > 0) {
    tools = [...tools, ...runtimeSkillDefs];
  }

  // Observability: log the assembled tool surface so operators can verify
  // MCP tools actually landed in what the model sees. The "configured but
  // empty" case is the regression signal — it means a server is registered
  // but ensureMcpConnected/reload silently failed and getMcpStatus() will
  // tell you why.
  if (opts.mcpTools.length > 0 || opts.mcpServerCount > 0) {
    const overLong = tools.filter((t) => t.name.length > 64).map((t) => t.name);
    logger.info(
      {
        totalTools: tools.length,
        mcpToolCount: opts.mcpTools.length,
        mcpServerCount: opts.mcpServerCount,
        mcpToolNames: opts.mcpTools.slice(0, 5).map((t) => t.name),
        overLongNames: overLong.length > 0 ? overLong : undefined,
      },
      '[orchestrator] tool surface assembled',
    );
  }

  return tools;
}
