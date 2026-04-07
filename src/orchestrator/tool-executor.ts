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
import type { LocalBrowserService } from '../execution/browser/local-browser.service.js';
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

  // Deduplicate: return cached result for identical tool+input (per-turn)
  const toolKey = `${request.name}:${stableKey(toolInput)}`;
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

  // --- Browser activation ---
  if (request.name === 'request_browser' && !ctx.browserState.activated) {
    yield { type: 'status', message: `[debug] Browser launching (request_browser) — headless: ${ctx.browserState.headless}` };
    logger.debug(`[browser] request_browser activation — headless: ${ctx.browserState.headless}`);
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

  // --- Browser tool execution ---
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
      yield { type: 'screenshot', path: screenshotPath };
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
      yield { type: 'screenshot', path: screenshotPath };
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
