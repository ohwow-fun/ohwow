/**
 * Provider-agnostic tool execution for the local orchestrator.
 * Eliminates duplication between Anthropic and Ollama tool loops.
 */

import type { TextBlockParam, ImageBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';

/** Browser result blocks are always text or image, narrow from ContentBlockParam. */
export type BrowserResultBlock = TextBlockParam | ImageBlockParam;
import type { LocalToolContext, ToolResult } from './local-tool-types.js';
import type { OrchestratorEvent, ChannelChatOptions } from './orchestrator-types.js';
import { toolRegistry } from './tools/registry.js';
import type { ToolCache } from './tool-cache.js';
import {
  BROWSER_ACTIVATION_MESSAGE,
  executeBrowserTool,
  formatBrowserToolResult,
  isBrowserTool,
} from '../execution/browser/browser-tools.js';
import { LocalBrowserService } from '../execution/browser/local-browser.service.js';
import { saveScreenshotLocally } from '../execution/browser/screenshot-storage.js';
import {
  DESKTOP_ACTIVATION_MESSAGE,
  executeDesktopTool,
  formatDesktopToolResult,
  isDesktopTool,
} from '../execution/desktop/desktop-tools.js';
import type { LocalDesktopService } from '../execution/desktop/local-desktop.service.js';
import { isMcpTool } from '../mcp/tool-adapter.js';
import type { McpClientManager } from '../mcp/client.js';
import { saveMediaFile, saveMediaFromUrl } from '../media/storage.js';
import { summarizeToolResult } from './result-summarizer.js';
import { retryTransient, CircuitBreaker, attemptRecovery, classifyError } from './error-recovery.js';
import { estimateMediaCost } from '../media/media-router.js';
import type { ImmuneSystem } from '../immune/immune-system.js';
import { FILE_ACCESS_ACTIVATION_MESSAGE } from '../execution/filesystem/index.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// MEDIA MCP DETECTION
// ============================================================================

const MEDIA_MCP_SERVERS = new Set(['fal-ai', 'replicate', 'openai-image', 'minimax', 'elevenlabs']);

function isMediaMcpTool(toolName: string): boolean {
  const match = toolName.match(/^mcp__([^_]+(?:-[^_]+)*)__/);
  return match ? MEDIA_MCP_SERVERS.has(match[1]) : false;
}

// ============================================================================
// ACTIVITY LOGGING
// ============================================================================

/**
 * Tool names that should NOT log to the activity feed. These are read-only
 * or high-frequency calls whose appearance in the feed would just be noise.
 * Writes, sends, creates, uploads, and any state mutation DO log.
 */
const ACTIVITY_SKIP_TOOLS = new Set<string>([
  'update_plan',          // planning UI only, not a world change
  'llm',                  // too chatty to log individually
  'list_agents', 'list_tasks', 'list_workflows', 'list_projects', 'list_goals',
  'list_contacts', 'list_knowledge', 'list_workflow_triggers', 'list_automations',
  'list_a2a_connections', 'list_peers', 'list_peer_agents', 'list_connectors',
  'list_telegram_chats', 'list_whatsapp_chats', 'list_whatsapp_messages',
  'list_whatsapp_connections', 'list_telegram_connections',
  'list_agent_state', 'list_person_models', 'list_doc_mounts', 'list_available_presets',
  'cloud_list_contacts', 'cloud_list_schedules', 'cloud_list_agents',
  'cloud_list_tasks', 'cloud_get_analytics', 'cloud_list_members',
  'get_task_detail', 'get_workspace_stats', 'get_activity_feed',
  'get_business_pulse', 'get_body_state', 'get_contact_pipeline',
  'get_daily_reps_status', 'get_agent_schedules', 'get_project_board',
  'get_pending_approvals', 'get_whatsapp_status', 'get_whatsapp_messages',
  'get_person_model', 'get_agent_state', 'get_workflow_detail',
  'get_transition_status', 'get_human_growth', 'get_skill_paths',
  'get_team_health', 'get_delegation_metrics', 'get_work_patterns',
  'get_time_allocation', 'get_observation_insights', 'get_cross_pollination',
  'get_collective_briefing', 'get_workload_balance', 'get_routing_recommendations',
  'get_task_augmentation', 'get_pillar_detail', 'get_time_saved',
  'search_contacts', 'search_knowledge', 'search_files', 'search_mounted_docs',
  'local_read_file', 'local_list_directory', 'local_search_files', 'local_search_content',
  'lsp_diagnostics', 'lsp_hover', 'lsp_go_to_definition', 'lsp_references', 'lsp_completions',
  'assess_operations', 'detect_task_patterns', 'detect_automation_opportunities',
  'body_state', 'business_pulse',
]);

/** Human-readable activity title for a given tool. */
function titleForTool(toolName: string, input: Record<string, unknown>): string {
  // Try to pull a sensible name out of the input for specific tools
  if (toolName === 'create_contact') {
    return `Created contact "${input.name ?? 'unnamed'}"`;
  }
  if (toolName === 'update_contact') {
    return `Updated contact ${input.contact_id ?? ''}`.trim();
  }
  if (toolName === 'upload_knowledge') {
    return `Ingested knowledge doc "${input.title ?? basenameOfPath(input.file_path)}"`;
  }
  if (toolName === 'delete_knowledge') {
    return `Deleted knowledge doc ${input.document_id ?? ''}`.trim();
  }
  if (toolName === 'local_write_file') {
    return `Wrote file ${String(input.path ?? '')}`;
  }
  if (toolName === 'local_edit_file') {
    return `Edited file ${String(input.path ?? '')}`;
  }
  if (toolName === 'send_whatsapp_message') {
    return `Sent WhatsApp message to ${input.chat_id ?? input.to ?? 'contact'}`;
  }
  if (toolName === 'send_telegram_message') {
    return `Sent Telegram message to ${input.chat_id ?? 'contact'}`;
  }
  if (toolName === 'run_agent') {
    return `Dispatched agent ${input.agent_id ?? ''}`.trim();
  }
  if (toolName === 'run_workflow') {
    return `Ran workflow ${input.workflow_id ?? ''}`.trim();
  }
  if (toolName === 'create_workflow' || toolName === 'generate_workflow') {
    return `Created workflow "${input.name ?? 'unnamed'}"`;
  }
  if (toolName === 'create_project') {
    return `Created project "${input.name ?? 'unnamed'}"`;
  }
  if (toolName === 'create_goal') {
    return `Created goal "${input.title ?? input.name ?? 'unnamed'}"`;
  }
  if (toolName === 'create_automation' || toolName === 'propose_automation') {
    return `Created automation "${input.name ?? 'unnamed'}"`;
  }
  // Fallback: human-ish version of the tool name
  return toolName.replace(/_/g, ' ');
}

function basenameOfPath(p: unknown): string {
  if (typeof p !== 'string') return 'file';
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

async function recordOrchestratorActivity(
  toolCtx: LocalToolContext,
  toolName: string,
  input: Record<string, unknown>,
  result: ToolResult,
): Promise<void> {
  // Skip noisy/read-only tools
  if (ACTIVITY_SKIP_TOOLS.has(toolName)) return;
  // Skip any `get_*` or `list_*` not explicitly covered above
  if (toolName.startsWith('get_') || toolName.startsWith('list_') || toolName.startsWith('search_')) return;

  try {
    const title = titleForTool(toolName, input);
    const description = result.success
      ? summarizeResultForActivity(result)
      : `Failed: ${result.error ?? 'unknown error'}`;
    await toolCtx.db.rpc('create_agent_activity', {
      p_workspace_id: toolCtx.workspaceId,
      p_activity_type: result.success ? 'orchestrator_tool' : 'orchestrator_tool_failed',
      p_title: title,
      p_description: description,
      p_agent_id: toolCtx.currentAgentId ?? null,
      p_task_id: null,
      p_metadata: {
        tool_name: toolName,
        source: 'orchestrator',
      },
    });
  } catch (err) {
    logger.debug({ err, toolName }, '[tool-executor] activity log failed (non-fatal)');
  }
}

function summarizeResultForActivity(result: ToolResult): string {
  if (!result.data) return 'OK';
  if (typeof result.data === 'string') return result.data.slice(0, 200);
  if (typeof result.data === 'object' && result.data !== null) {
    const r = result.data as Record<string, unknown>;
    if (typeof r.message === 'string') return r.message.slice(0, 200);
    if (typeof r.text === 'string') return r.text.slice(0, 200).replace(/\s+/g, ' ');
  }
  return 'OK';
}

// ============================================================================
// TYPES
// ============================================================================

export interface ToolCallRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolCallOutcome {
  toolName: string;
  result: ToolResult;
  resultContent: string;
  formattedBlocks?: BrowserResultBlock[];
  isError: boolean;
  screenshotPath?: string;
  planTasks?: Array<{ id: string; title: string; status: string }>;
  toolsModified?: boolean;
}

export interface BrowserState {
  service: LocalBrowserService | null;
  activated: boolean;
  headless: boolean;
  dataDir: string;
  /** Lazy-activation callback: creates browser service on demand when a browser tool is called without prior request_browser */
  activate?: () => Promise<void>;
  /** Profile requested by the model via request_browser tool */
  requestedProfile?: string;
  /** Callback to set the requested profile on the orchestrator */
  setRequestedProfile?: (profile: string) => void;
}

export interface DesktopState {
  service: LocalDesktopService | null;
  activated: boolean;
  dataDir: string;
}

export interface ToolExecutionContext {
  toolCtx: LocalToolContext;
  executedToolCalls: Map<string, ToolResult>;
  browserState: BrowserState;
  desktopState?: DesktopState;
  waitForPermission: (requestId: string) => Promise<boolean>;
  addAllowedPath: (path: string) => Promise<void>;
  options?: ChannelChatOptions;
  circuitBreaker?: CircuitBreaker;
  /** Cross-turn tool result cache for reducing redundant API calls. */
  toolCache?: ToolCache;
  /** Optional handler for delegate_subtask — provided by the parent orchestrator. */
  delegateSubtask?: (prompt: string, focus: string) => Promise<{ summary: string; toolsCalled: string[]; tokensUsed: { input: number; output: number }; success: boolean }>;
  /** MCP client manager for routing MCP tool calls. */
  mcpClients?: McpClientManager | null;
  /** Optional handler for cost confirmation before expensive media MCP calls. */
  waitForCostApproval?: (requestId: string) => Promise<boolean>;
  /** When true, skip cost confirmation dialogs for cloud media MCP calls. */
  skipMediaCostConfirmation?: boolean;
  /** Immune system for threat scanning on tool inputs/outputs (Maturana & Varela). */
  immuneSystem?: ImmuneSystem | null;
}

// ============================================================================
// HELPERS
// ============================================================================

/** Stable JSON key: sorts object keys so {a:1,b:2} and {b:2,a:1} produce the same string. */
function stableKey(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

// ============================================================================
// TOOL EXECUTION
// ============================================================================

export async function* executeToolCall(
  request: ToolCallRequest,
  ctx: ToolExecutionContext,
): AsyncGenerator<OrchestratorEvent, ToolCallOutcome> {
  let toolInput = request.input;

  // Apply channel-specific tool input transformations
  if (ctx.options?.transformToolInput) {
    toolInput = ctx.options.transformToolInput(request.name, toolInput);
  }

  // Observation tools must always re-execute — screen/page state changes between actions
  const isObservationTool = /^(desktop_screenshot|browser_snapshot|browser_screenshot|browser_take_screenshot|desktop_list_windows)$/.test(request.name)
    || /^mcp__.*__(browser_snapshot|browser_take_screenshot)$/.test(request.name);

  // State-mutating tools must also always re-execute. Deduping them is
  // wrong on two counts:
  //   1. The same input can legitimately be re-applied (press cmd+l
  //      twice, write the same bytes twice, send the same whatsapp twice).
  //   2. When the model gets confused and retries, dedup silently
  //      no-ops the action AND echoes the old "Done" — which reinforces
  //      the confusion into a hard loop. We saw this live on 2026-04-12
  //      where an X-messages task burned 737k tokens bouncing between
  //      identical desktop_key/desktop_type calls that were all cached.
  // Covers: desktop keyboard/mouse/window actions, browser actions,
  // filesystem writes, bash, create/update/delete/upload/send/run verbs,
  // A2A / workflow / agent dispatch, and messaging sends.
  const isStateMutating = /^(desktop_(key|type|click|scroll|drag|hotkey|focus|wait|move_mouse|double_click|right_click|triple_click|paste|press)|browser_(click|type|navigate|scroll|drag|press_key|fill|select|wait_for|hover|file_upload|handle_dialog|back|forward|reload|evaluate|close|resize|open_new_tab|switch_tab|go_to)|local_(write_file|edit_file|delete_file|move_file|copy_file)|run_bash|save_deliverable|upload_knowledge|add_knowledge_from_url|delete_knowledge|assign_knowledge|create_contact|update_contact|delete_contact|log_contact_event|create_project|update_project|delete_project|create_goal|update_goal|link_task_to_goal|link_project_to_goal|create_workflow|update_workflow|delete_workflow|generate_workflow|create_workflow_trigger|update_workflow_trigger|delete_workflow_trigger|create_automation|propose_automation|run_workflow|run_agent|run_sequence|spawn_agents|queue_task|retry_task|cancel_task|approve_task|reject_task|update_agent_status|update_agent_schedule|send_whatsapp_message|send_telegram_message|connect_whatsapp|disconnect_whatsapp|add_whatsapp_chat|remove_whatsapp_chat|update_whatsapp_chat|send_a2a_task|evolve_task|delegate_to_peer|ask_peer|set_agent_state|delete_agent_state|override_transition_stage|schedule_team_council|rebalance_workload|mount_docs|unmount_docs|build_pillar|update_pillar_status|create_skill_path|record_skill_assessment|trigger_pre_work|record_routing_outcome|route_task|generate_slides|export_slides_to_pdf|generate_music|generate_video|generate_voice|transcribe_audio|start_meeting_listener|stop_meeting_listener|openclaw_import_skill|openclaw_remove_skill|pdf_fill_form|start_person_ingestion|update_person_model|add_connector|remove_connector|sync_connector|test_connector)$/.test(request.name)
    || /^mcp__.*__(browser_(click|type|navigate|scroll|drag|press_key|fill|select|hover|file_upload|handle_dialog|back|forward|reload|evaluate|close|resize|run_code))$/.test(request.name)
    || /^llm$/.test(request.name); // llm is also non-idempotent (each call is a fresh LLM roll)

  // Deduplicate: return cached result for identical tool+input (per-turn)
  const toolKey = `${request.name}:${stableKey(toolInput)}`;
  if (!isObservationTool && !isStateMutating) {
    const cachedResult = ctx.executedToolCalls.get(toolKey);
    if (cachedResult) {
      yield { type: 'tool_done', name: request.name, result: cachedResult };
      return {
        toolName: request.name,
        result: cachedResult,
        resultContent: `You already called ${request.name} with these same arguments and received the result above. Do not repeat this call — use the existing result to answer the user now.`,
        isError: false,
      };
    }

    // Cross-turn cache check
    if (ctx.toolCache) {
      const crossTurnCached = ctx.toolCache.get(request.name, toolInput);
      if (crossTurnCached) {
        ctx.executedToolCalls.set(toolKey, crossTurnCached);
        yield { type: 'tool_done', name: request.name, result: crossTurnCached };
        return {
          toolName: request.name,
          result: crossTurnCached,
          resultContent: summarizeToolResult(request.name, JSON.stringify(crossTurnCached.data), !crossTurnCached.success),
          isError: !crossTurnCached.success,
        };
      }
    }
  }

  yield { type: 'tool_start', name: request.name, input: toolInput };

  // --- Immune system: pre-tool threat scan (Maturana & Varela's autopoiesis) ---
  if (ctx.immuneSystem) {
    try {
      const detection = ctx.immuneSystem.scan(JSON.stringify(toolInput), request.name);
      if (detection.detected) {
        ctx.immuneSystem.respond(detection);
        if (detection.recommendation === 'block' || detection.recommendation === 'quarantine') {
          logger.warn({ tool: request.name, pathogen: detection.pathogenType, confidence: detection.confidence }, 'immune: blocked tool input');
          const blockedResult: ToolResult = { success: false, error: `Blocked by immune system: ${detection.reason}` };
          yield { type: 'tool_done', name: request.name, result: blockedResult };
          return { toolName: request.name, result: blockedResult, resultContent: `Blocked: ${detection.reason}`, isError: true };
        }
        if (detection.recommendation === 'flag') {
          logger.info({ tool: request.name, pathogen: detection.pathogenType, confidence: detection.confidence }, 'immune: flagged tool input');
        }
      }
    } catch { /* immune scanning is non-fatal */ }
  }

  // --- Plan update ---
  if (request.name === 'update_plan') {
    const tasks = (toolInput.tasks as Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'done' }>) ?? [];
    yield { type: 'plan_update', tasks };
    const planResult: ToolResult = { success: true, data: 'Plan updated.' };
    ctx.executedToolCalls.set(toolKey, planResult);
    yield { type: 'tool_done', name: request.name, result: planResult };
    return {
      toolName: request.name,
      result: planResult,
      resultContent: 'Plan updated successfully.',
      isError: false,
      planTasks: tasks,
    };
  }

  // --- Chrome profile discovery ---
  if (request.name === 'list_chrome_profiles') {
    const profiles = await LocalBrowserService.discoverChromeProfiles();
    const formatted = profiles.length > 0
      ? profiles.map((p, i) => `${i + 1}. ${p.name} (${p.email || 'no account'}) — directory: "${p.directory}"${p.hostedDomain ? ` [${p.hostedDomain}]` : ''}`).join('\n')
      : 'No Chrome profiles found on this device.';
    const result: ToolResult = { success: true, data: formatted };
    ctx.executedToolCalls.set(toolKey, result);
    yield { type: 'tool_done', name: request.name, result };
    return { toolName: request.name, result, resultContent: formatted, isError: false };
  }

  // --- Browser activation ---
  if (request.name === 'request_browser' && !ctx.browserState.activated) {
    // Capture profile preference for the orchestrator to use when activating
    const profileInput = toolInput.profile as string | undefined;
    if (profileInput && ctx.browserState.setRequestedProfile) {
      ctx.browserState.setRequestedProfile(profileInput);
    }
    logger.debug(`[browser] request_browser activation — profile: ${profileInput || 'default'}`);
    // NOTE: The caller must handle creating the LocalBrowserService and updating browserState
    // because the service instance lives on the class. We signal via toolsModified.
    const activationResult: ToolResult = { success: true, data: BROWSER_ACTIVATION_MESSAGE };
    ctx.executedToolCalls.set(toolKey, activationResult);
    yield { type: 'tool_done', name: request.name, result: activationResult };
    return {
      toolName: request.name,
      result: activationResult,
      resultContent: BROWSER_ACTIVATION_MESSAGE,
      isError: false,
      toolsModified: true,
    };
  }

  // --- Desktop activation ---
  if (request.name === 'request_desktop' && ctx.desktopState && !ctx.desktopState.activated) {
    yield { type: 'status', message: '[debug] Desktop control launching (request_desktop)' };
    logger.debug('[desktop] request_desktop activation');
    const activationResult: ToolResult = { success: true, data: DESKTOP_ACTIVATION_MESSAGE };
    ctx.executedToolCalls.set(toolKey, activationResult);
    yield { type: 'tool_done', name: request.name, result: activationResult };
    return {
      toolName: request.name,
      result: activationResult,
      resultContent: DESKTOP_ACTIVATION_MESSAGE,
      isError: false,
      toolsModified: true,
    };
  }

  // --- Filesystem/bash activation (permission-gated) ---
  if (request.name === 'request_file_access') {
    const resolvedDir = (toolInput.directory as string | undefined)
      || ctx.toolCtx.workingDirectory
      || '';
    if (!resolvedDir) {
      const errorResult: ToolResult = { success: false, error: 'No directory available to request access for.' };
      ctx.executedToolCalls.set(toolKey, errorResult);
      yield { type: 'tool_done', name: request.name, result: errorResult };
      return { toolName: request.name, result: errorResult, resultContent: errorResult.error!, isError: true };
    }
    const requestId = crypto.randomUUID();
    yield { type: 'permission_request', requestId, path: resolvedDir, toolName: request.name };
    const granted = await ctx.waitForPermission(requestId);
    if (granted) {
      await ctx.addAllowedPath(resolvedDir);
      const activationResult: ToolResult = { success: true, data: FILE_ACCESS_ACTIVATION_MESSAGE };
      ctx.executedToolCalls.set(toolKey, activationResult);
      yield { type: 'tool_done', name: request.name, result: activationResult };
      return {
        toolName: request.name,
        result: activationResult,
        resultContent: FILE_ACCESS_ACTIVATION_MESSAGE,
        isError: false,
        toolsModified: true,
      };
    } else {
      const deniedResult: ToolResult = { success: false, error: 'File access denied by user.' };
      ctx.executedToolCalls.set(toolKey, deniedResult);
      yield { type: 'tool_done', name: request.name, result: deniedResult };
      return { toolName: request.name, result: deniedResult, resultContent: deniedResult.error!, isError: true };
    }
  }

  // --- Delegate subtask to sub-orchestrator ---
  if (request.name === 'delegate_subtask') {
    if (!ctx.delegateSubtask) {
      const errorResult: ToolResult = { success: false, error: 'Sub-orchestrator not available in this context.' };
      yield { type: 'tool_done', name: request.name, result: errorResult };
      return { toolName: request.name, result: errorResult, resultContent: 'Error: Sub-orchestrator not available.', isError: true };
    }
    yield { type: 'status', message: `Delegating subtask (focus: ${toolInput.focus})...` };
    const subResult = await ctx.delegateSubtask(toolInput.prompt as string, toolInput.focus as string);
    const result: ToolResult = subResult.success
      ? { success: true, data: subResult.summary }
      : { success: false, error: subResult.summary };
    ctx.executedToolCalls.set(toolKey, result);
    yield { type: 'tool_done', name: request.name, result };
    const content = subResult.success
      ? `Sub-orchestrator result (used ${subResult.toolsCalled.length} tools: ${subResult.toolsCalled.join(', ')}):\n\n${subResult.summary}`
      : `Sub-orchestrator failed: ${subResult.summary}`;
    return { toolName: request.name, result, resultContent: summarizeToolResult(request.name, content, !subResult.success), isError: !subResult.success };
  }

  // --- Wiki curate: janitorial cleanup pass in an isolated sub-orch ---
  // Special-cased here (rather than wired through the registry) for the
  // same reason as delegate_subtask: it needs ctx.delegateSubtask, which
  // is on ToolExecutionContext, not on the LocalToolContext that normal
  // tool handlers receive. The tool wraps a hardcoded janitorial prompt
  // around the user-supplied intent so the sub-orch always knows the
  // expected shape: lint → fix → re-lint → summarize.
  if (request.name === 'wiki_curate') {
    if (!ctx.delegateSubtask) {
      const errorResult: ToolResult = { success: false, error: 'Sub-orchestrator not available — wiki_curate cannot run.' };
      yield { type: 'tool_done', name: request.name, result: errorResult };
      return { toolName: request.name, result: errorResult, resultContent: 'Error: Sub-orchestrator not available.', isError: true };
    }
    const intent = (toolInput.intent as string | undefined)?.trim() || 'general lint pass — fix everything you reasonably can';
    yield { type: 'status', message: `Curating wiki (${intent.slice(0, 60)})...` };
    const cleanupPrompt = `You are running an isolated wiki cleanup pass. The parent chat does not see your intermediate tool results — only your final summary. Be efficient.

Intent: ${intent}

Procedure:
1. Call wiki_lint to get the current findings.
2. Walk the findings and fix what you can:
   - missing_summary: read the page with wiki_read_page, then call wiki_write_page with the same body but a one-line summary added (≤ 100 chars, captures the gist).
   - orphan: pick a related existing page from wiki_list_pages, read it, append a sentence with a [[backlink]] to the orphan in a sensible section, and write it back.
   - stub: only create the page if the concept is clearly worth having; otherwise note it as "intentionally not created" in your summary.
   - thin: skip these — they need real content, not janitorial work.
3. Call wiki_lint again to confirm the delta.
4. Reply with a one-line summary of: pages touched, lint count before → after, anything you intentionally skipped.

Constraints:
- Do not ask clarifying questions. Work with what you have.
- Use wiki_list_pages first if you need to discover slugs.
- Never overwrite a page with less content than it had — always read first, merge, then write.
- Keep your summary under 200 words. The parent only needs the delta, not the full play-by-play.`;

    const subResult = await ctx.delegateSubtask(cleanupPrompt, 'wiki');
    const result: ToolResult = subResult.success
      ? { success: true, data: subResult.summary }
      : { success: false, error: subResult.summary };
    ctx.executedToolCalls.set(toolKey, result);
    yield { type: 'tool_done', name: request.name, result };
    const content = subResult.success
      ? `Wiki curate complete (${subResult.toolsCalled.length} tools used):\n\n${subResult.summary}`
      : `Wiki curate failed: ${subResult.summary}`;
    return { toolName: request.name, result, resultContent: summarizeToolResult(request.name, content, !subResult.success), isError: !subResult.success };
  }

  // --- Sequential multi-agent execution ---
  if (request.name === 'run_sequence') {
    yield { type: 'status', message: 'Planning multi-agent sequence...' };

    // Collect sequence events to emit after execution
    const sequenceEvents: OrchestratorEvent[] = [];
    const { runSequenceWithEvents } = await import('./tools/sequences.js');
    const seqResult = await runSequenceWithEvents(ctx.toolCtx, toolInput, (event) => {
      if (event.type === 'sequence_start') {
        sequenceEvents.push(event as unknown as OrchestratorEvent);
      } else if (event.type === 'step_start') {
        const e = event as { stepId: string; agentName: string; wave: number };
        sequenceEvents.push({
          type: 'sequence_step', stepId: e.stepId, agentName: e.agentName,
          status: 'running', wave: e.wave,
        });
      } else if (event.type === 'step_abstained') {
        const e = event as unknown as { stepId: string; agentName: string; reason: string };
        sequenceEvents.push({
          type: 'sequence_step', stepId: e.stepId, agentName: e.agentName,
          status: 'abstained', wave: 0, reason: e.reason,
        });
      } else if (event.type === 'sequence_complete') {
        const e = event as { result: { success: boolean; participatedCount: number; abstainedCount: number; totalCostCents: number } };
        sequenceEvents.push({
          type: 'sequence_done', success: e.result.success,
          participatedCount: e.result.participatedCount,
          abstainedCount: e.result.abstainedCount,
          totalCostCents: e.result.totalCostCents,
        });
      }
    });

    // Emit collected events
    for (const seqEvent of sequenceEvents) {
      yield seqEvent;
    }

    const result: ToolResult = seqResult.success
      ? { success: true, data: seqResult.data }
      : { success: false, error: seqResult.error };
    ctx.executedToolCalls.set(toolKey, result);
    yield { type: 'tool_done', name: request.name, result };

    const content = seqResult.success
      ? `Sequence completed: ${JSON.stringify(seqResult.data)}`
      : `Sequence failed: ${seqResult.error}`;
    return { toolName: request.name, result, resultContent: summarizeToolResult(request.name, content, !seqResult.success), isError: !seqResult.success };
  }

  // --- Co-evolution multi-agent execution ---
  if (request.name === 'evolve_task') {
    yield { type: 'status', message: 'Starting co-evolution...' };

    const evolutionEvents: OrchestratorEvent[] = [];
    const { evolveTaskWithEvents } = await import('./tools/co-evolution.js');
    const evoResult = await evolveTaskWithEvents(ctx.toolCtx, toolInput, (event) => {
      evolutionEvents.push(event);
    });

    // Emit collected events
    for (const evoEvent of evolutionEvents) {
      yield evoEvent;
    }

    const result: ToolResult = evoResult.success
      ? { success: true, data: evoResult.data }
      : { success: false, error: evoResult.error };
    ctx.executedToolCalls.set(toolKey, result);
    yield { type: 'tool_done', name: request.name, result };

    const content = evoResult.success
      ? `Co-evolution completed: ${JSON.stringify(evoResult.data)}`
      : `Co-evolution failed: ${evoResult.error}`;
    return { toolName: request.name, result, resultContent: summarizeToolResult(request.name, content, !evoResult.success), isError: !evoResult.success };
  }

  // --- Browser tool execution ---
  // Auto-activate browser service if a browser tool is called without prior request_browser
  if (isBrowserTool(request.name) && !ctx.browserState.service && ctx.browserState.activate) {
    try {
      await ctx.browserState.activate();
    } catch {
      // Non-fatal: fall through to MCP or error path
    }
  }
  if (isBrowserTool(request.name) && ctx.browserState.service) {
    const browserResult = await executeBrowserTool(ctx.browserState.service, request.name, toolInput);
    let screenshotPath: string | undefined;
    if (browserResult.screenshot && ctx.browserState.dataDir) {
      try {
        const saved = await saveScreenshotLocally(browserResult.screenshot, ctx.browserState.dataDir);
        screenshotPath = saved.path;
      } catch {
        // Non-fatal
      }
    }
    const formatted = formatBrowserToolResult(browserResult) as BrowserResultBlock[];
    if (screenshotPath) {
      formatted.push({ type: 'text', text: `Screenshot saved to ${screenshotPath}` });
    }
    const toolResult: ToolResult = browserResult.error
      ? { success: false, error: browserResult.error }
      : { success: true, data: screenshotPath ? `Done. Screenshot saved to ${screenshotPath}` : (browserResult.content || 'Done') };
    ctx.executedToolCalls.set(toolKey, toolResult);
    yield { type: 'tool_done', name: request.name, result: toolResult };
    if (screenshotPath) {
      yield { type: 'screenshot', path: screenshotPath, base64: browserResult.screenshot };
    }

    // Build Ollama-compatible text content (for models that can't process images)
    let ollamaContent = formatted
      .map(b => (b.type === 'text' ? b.text : (screenshotPath
        ? `Screenshot saved to ${screenshotPath}. The image shows the current browser viewport at ${browserResult.currentUrl || 'the current page'}.`
        : '[image]')))
      .join('\n');

    // Hint: suggest desktop tools when browser hits a native boundary
    if (browserResult.error && ctx.desktopState) {
      const err = browserResult.error.toLowerCase();
      if (/file.*(upload|picker|dialog)|native.*(popup|dialog)|system.*(dialog|prompt)|permission.*prompt|save.*as|print.*dialog|open.*with/.test(err)) {
        ollamaContent += '\n\nHint: This looks like a native OS interaction. Consider using desktop_* tools (desktop_screenshot, desktop_click, desktop_type) to handle file pickers, system dialogs, or native app prompts.';
      }
    }

    return {
      toolName: request.name,
      result: toolResult,
      resultContent: ollamaContent,
      formattedBlocks: formatted,
      isError: !!browserResult.error,
      screenshotPath,
    };
  }

  // --- Desktop tool execution ---
  if (isDesktopTool(request.name) && ctx.desktopState?.service) {
    const desktopResult = await executeDesktopTool(ctx.desktopState.service, request.name, toolInput);
    let screenshotPath: string | undefined;
    if (desktopResult.screenshot && ctx.desktopState.dataDir) {
      try {
        const saved = await saveScreenshotLocally(desktopResult.screenshot, ctx.desktopState.dataDir);
        screenshotPath = saved.path;
      } catch { /* non-fatal */ }
    }
    const formatted = formatDesktopToolResult(desktopResult) as BrowserResultBlock[];
    if (screenshotPath) {
      formatted.push({ type: 'text', text: `Screenshot saved to ${screenshotPath}` });
    }
    const toolResult: ToolResult = desktopResult.error
      ? { success: false, error: desktopResult.error }
      : { success: true, data: screenshotPath ? `Done. Screenshot saved to ${screenshotPath}` : `Action ${desktopResult.type} completed.` };
    ctx.executedToolCalls.set(toolKey, toolResult);
    yield { type: 'tool_done', name: request.name, result: toolResult };
    if (screenshotPath) {
      yield { type: 'screenshot', path: screenshotPath, base64: desktopResult.screenshot };
    }

    const ollamaContent = formatted
      .map(b => (b.type === 'text' ? b.text : (screenshotPath
        ? `Screenshot saved to ${screenshotPath}. The image shows the current desktop screen.`
        : '[desktop screenshot]')))
      .join('\n');

    return {
      toolName: request.name,
      result: toolResult,
      resultContent: ollamaContent,
      formattedBlocks: formatted,
      isError: !!desktopResult.error,
      screenshotPath,
    };
  }

  // --- MCP tool execution ---
  if (isMcpTool(request.name) && ctx.mcpClients?.hasTool(request.name)) {
    // Circuit breaker check for MCP tools
    const cb = ctx.circuitBreaker;
    if (cb?.isDisabled(request.name)) {
      const disabledMsg = cb.buildErrorWithAlternatives(
        request.name,
        `Tool "${request.name}" is temporarily disabled due to repeated failures.`,
      );
      const errorResult: ToolResult = { success: false, error: disabledMsg };
      yield { type: 'tool_done', name: request.name, result: errorResult };
      return { toolName: request.name, result: errorResult, resultContent: `Error: ${disabledMsg}`, isError: true };
    }

    // Cost confirmation for cloud media MCP tools
    if (isMediaMcpTool(request.name) && ctx.waitForCostApproval && !ctx.skipMediaCostConfirmation) {
      const cost = estimateMediaCost('image', 'standard', false);
      const requestId = crypto.randomUUID();
      yield { type: 'cost_confirmation', requestId, toolName: request.name, estimatedCredits: cost.credits, description: cost.description };
      const approved = await ctx.waitForCostApproval(requestId);
      if (!approved) {
        const cancelResult: ToolResult = { success: false, error: 'Media generation cancelled.' };
        yield { type: 'tool_done', name: request.name, result: cancelResult };
        return { toolName: request.name, result: cancelResult, resultContent: 'Media generation cancelled by user.', isError: true };
      }
    }

    try {
      const mcpResult = await ctx.mcpClients.callTool(request.name, toolInput);

      // Save any media attachments to disk
      const savedMediaPaths: string[] = [];
      if (mcpResult.mediaAttachments?.length) {
        for (const attachment of mcpResult.mediaAttachments) {
          try {
            if (attachment.data) {
              const saved = await saveMediaFile(attachment.data, attachment.mimeType);
              savedMediaPaths.push(saved.path);
            } else if (attachment.url) {
              const saved = await saveMediaFromUrl(attachment.url, attachment.mimeType);
              savedMediaPaths.push(saved.path);
            }
          } catch (saveErr) {
            logger.warn(`[mcp] Couldn't save media attachment: ${saveErr instanceof Error ? saveErr.message : saveErr}`);
          }
        }
      }

      // Append saved paths to the content so the orchestrator/user sees them
      let resultContent = mcpResult.content;
      if (savedMediaPaths.length > 0) {
        const pathLines = savedMediaPaths.map(p => `Saved to: ${p}`).join('\n');
        resultContent = `${resultContent}\n\n${pathLines}`;
      }

      const toolResult: ToolResult = mcpResult.is_error
        ? { success: false, error: resultContent }
        : { success: true, data: resultContent };
      if (!mcpResult.is_error) {
        cb?.recordSuccess(request.name);
        // Immune: de-escalate on successful MCP execution
        if (ctx.immuneSystem) {
          try {
            ctx.immuneSystem.respond({ detected: false, pathogenType: null, confidence: 0, matchedSignature: null, recommendation: 'allow', reason: 'MCP tool succeeded' });
          } catch { /* non-fatal */ }
        }
      }
      ctx.executedToolCalls.set(toolKey, toolResult);
      ctx.toolCache?.set(request.name, toolInput, toolResult);
      yield { type: 'tool_done', name: request.name, result: toolResult };

      // Emit media_generated events for each saved file
      for (const mediaPath of savedMediaPaths) {
        yield { type: 'media_generated', path: mediaPath };
      }

      return {
        toolName: request.name,
        result: toolResult,
        resultContent: summarizeToolResult(request.name, resultContent, !!mcpResult.is_error),
        isError: !!mcpResult.is_error,
      };
    } catch (err) {
      const isTransportError = err instanceof Error && (
        err.message.includes('EPIPE') ||
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('not connected') ||
        err.message.includes('transport')
      );

      // Transport error — attempt one reconnection
      if (isTransportError && ctx.mcpClients) {
        logger.warn(`[mcp] Transport error calling ${request.name}, attempting reconnect...`);
        const reconnected = await ctx.mcpClients.reconnectServer(request.name).catch(() => false);
        if (reconnected) {
          try {
            const retryResult = await ctx.mcpClients.callTool(request.name, toolInput);
            let retryContent = retryResult.content;

            // Save media attachments on retry success
            const retrySavedPaths: string[] = [];
            if (retryResult.mediaAttachments?.length) {
              for (const attachment of retryResult.mediaAttachments) {
                try {
                  if (attachment.data) {
                    const saved = await saveMediaFile(attachment.data, attachment.mimeType);
                    retrySavedPaths.push(saved.path);
                  } else if (attachment.url) {
                    const saved = await saveMediaFromUrl(attachment.url, attachment.mimeType);
                    retrySavedPaths.push(saved.path);
                  }
                } catch { /* non-fatal */ }
              }
            }
            if (retrySavedPaths.length > 0) {
              retryContent = `${retryContent}\n\n${retrySavedPaths.map(p => `Saved to: ${p}`).join('\n')}`;
            }

            const retryToolResult: ToolResult = retryResult.is_error
              ? { success: false, error: retryContent }
              : { success: true, data: retryContent };
            if (!retryResult.is_error) cb?.recordSuccess(request.name);
            ctx.executedToolCalls.set(toolKey, retryToolResult);
            ctx.toolCache?.set(request.name, toolInput, retryToolResult);
            yield { type: 'tool_done', name: request.name, result: retryToolResult };
            for (const mediaPath of retrySavedPaths) {
              yield { type: 'media_generated', path: mediaPath };
            }
            return {
              toolName: request.name,
              result: retryToolResult,
              resultContent: summarizeToolResult(request.name, retryContent, !!retryResult.is_error),
              isError: !!retryResult.is_error,
            };
          } catch { /* fall through to error */ }
        }
      }

      // Record failure in circuit breaker
      if (cb) {
        const tripped = cb.recordFailure(request.name);
        if (tripped) {
          logger.warn(`[tool-executor] Circuit breaker tripped for MCP tool "${request.name}"`);
        }
      }

      const errorMsg = err instanceof Error ? err.message : 'MCP tool call failed';

      // Immune: scan MCP error for threat patterns
      if (ctx.immuneSystem) {
        try {
          const failureDetection = ctx.immuneSystem.scan(errorMsg, request.name);
          ctx.immuneSystem.respond(failureDetection);
        } catch { /* non-fatal */ }
      }
      const errorResult: ToolResult = { success: false, error: errorMsg };
      yield { type: 'tool_done', name: request.name, result: errorResult };

      // Hint: suggest browser as fallback when MCP fails
      let mcpErrorContent = `Error: ${errorMsg}`;
      if (ctx.browserState.service || ctx.browserState.activated) {
        mcpErrorContent += '\n\nHint: This MCP tool failed. If the task can be done through a web interface, consider using browser_* tools instead.';
      }

      return {
        toolName: request.name,
        result: errorResult,
        resultContent: mcpErrorContent,
        isError: true,
      };
    }
  }

  // --- Registry tool execution ---
  const handler = toolRegistry.get(request.name);
  if (!handler) {
    const errorResult: ToolResult = { success: false, error: `Unknown tool: ${request.name}` };
    yield { type: 'tool_done', name: request.name, result: errorResult };
    return {
      toolName: request.name,
      result: errorResult,
      resultContent: `Error: Unknown tool: ${request.name}`,
      isError: true,
    };
  }

  // Circuit breaker check: skip tools that have failed repeatedly
  const cb = ctx.circuitBreaker;
  if (cb?.isDisabled(request.name)) {
    const disabledMsg = cb.buildErrorWithAlternatives(
      request.name,
      `Tool "${request.name}" is temporarily disabled due to repeated failures.`,
    );
    const errorResult: ToolResult = { success: false, error: disabledMsg };
    yield { type: 'tool_done', name: request.name, result: errorResult };
    return {
      toolName: request.name,
      result: errorResult,
      resultContent: `Error: ${disabledMsg}`,
      isError: true,
    };
  }

  try {
    // Wrap execution with retry for transient errors (immune-aware: suppress retries under threat)
    const immuneAlert = ctx.immuneSystem?.getInflammatoryState().alertLevel;
    let result = await retryTransient(async () => handler(ctx.toolCtx, toolInput), undefined, immuneAlert);

    // Handle permission request for out-of-scope paths
    if (result.needsPermission) {
      const requestId = crypto.randomUUID();
      yield { type: 'permission_request', requestId, path: result.needsPermission, toolName: request.name };
      const granted = await ctx.waitForPermission(requestId);
      if (granted) {
        await ctx.addAllowedPath(result.needsPermission);
        result = await retryTransient(async () => handler(ctx.toolCtx, toolInput), undefined, immuneAlert);
      } else {
        result = { success: false, error: 'Access denied by user.' };
      }
    }

    cb?.recordSuccess(request.name);
    // Immune: de-escalate on successful execution
    if (ctx.immuneSystem) {
      try {
        ctx.immuneSystem.respond({ detected: false, pathogenType: null, confidence: 0, matchedSignature: null, recommendation: 'allow', reason: 'tool succeeded' });
      } catch { /* non-fatal */ }
    }
    ctx.executedToolCalls.set(toolKey, result);
    ctx.toolCache?.set(request.name, toolInput, result);
    // Activity feed: log notable orchestrator tool calls so dashboard shows
    // dogfood work in real time. Best-effort, never blocks tool execution.
    void recordOrchestratorActivity(ctx.toolCtx, request.name, toolInput, result);
    yield { type: 'tool_done', name: request.name, result };

    if (result.switchTab) {
      yield { type: 'switch_tab', tab: result.switchTab };
    }

    const rawContent = result.success ? JSON.stringify(result.data) : `Error: ${result.error}`;
    const resultContent = summarizeToolResult(request.name, rawContent, !result.success);
    return {
      toolName: request.name,
      result,
      resultContent,
      isError: !result.success,
    };
  } catch (err) {
    const lastError = err instanceof Error ? err : new Error(String(err));
    const errorMsg = lastError.message;
    const category = classifyError(lastError);

    // Attempt structured recovery for non-transient errors
    // (transient errors are already handled by retryTransient above)
    if (category !== 'transient') {
      try {
        const outcome = await attemptRecovery(lastError, {
          error: lastError,
          toolName: request.name,
          workingDirectory: ctx.toolCtx.workingDirectory,
        });

        if (outcome.shouldRetry) {
          // Recovery succeeded — retry the tool once
          try {
            const retryResult = await handler(ctx.toolCtx, toolInput);
            cb?.recordSuccess(request.name);
            ctx.executedToolCalls.set(toolKey, retryResult);
            yield { type: 'tool_done', name: request.name, result: retryResult };
            const rawContent = retryResult.success ? JSON.stringify(retryResult.data) : `Error: ${retryResult.error}`;
            return { toolName: request.name, result: retryResult, resultContent: summarizeToolResult(request.name, rawContent, !retryResult.success), isError: !retryResult.success };
          } catch {
            // Retry also failed — fall through to error path
          }
        }

        // Surface recovery message to user if provided
        if (outcome.userMessage) {
          const recoveryResult: ToolResult = { success: false, error: outcome.userMessage };
          yield { type: 'tool_done', name: request.name, result: recoveryResult };
          return { toolName: request.name, result: recoveryResult, resultContent: `Error: ${outcome.userMessage}`, isError: true };
        }
      } catch {
        // Recovery itself failed, fall through to standard error handling
      }
    }

    // Record failure in circuit breaker
    if (cb) {
      const tripped = cb.recordFailure(request.name);
      if (tripped) {
        logger.warn(`[tool-executor] Circuit breaker tripped for "${request.name}" after repeated failures`);
      }
    }

    // Immune: scan error for threat patterns and escalate if warranted
    if (ctx.immuneSystem) {
      try {
        const failureDetection = ctx.immuneSystem.scan(errorMsg, request.name);
        ctx.immuneSystem.respond(failureDetection);
      } catch { /* non-fatal */ }
    }

    // Enrich error message with alternatives
    const enrichedMsg = cb
      ? cb.buildErrorWithAlternatives(request.name, errorMsg)
      : errorMsg;

    const errorResult: ToolResult = { success: false, error: enrichedMsg };
    yield { type: 'tool_done', name: request.name, result: errorResult };
    return {
      toolName: request.name,
      result: errorResult,
      resultContent: `Error: ${enrichedMsg}`,
      isError: true,
    };
  }
}
