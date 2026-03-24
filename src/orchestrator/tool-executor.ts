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
import { isMcpTool } from '../mcp/tool-adapter.js';
import type { McpClientManager } from '../mcp/client.js';
import { saveMediaFile, saveMediaFromUrl } from '../media/storage.js';
import { summarizeToolResult } from './result-summarizer.js';
import { retryTransient, CircuitBreaker } from './error-recovery.js';
import { estimateMediaCost } from '../media/media-router.js';
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

export interface ToolExecutionContext {
  toolCtx: LocalToolContext;
  executedToolCalls: Map<string, ToolResult>;
  browserState: BrowserState;
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
    const ollamaContent = formatted
      .map(b => (b.type === 'text' ? b.text : (screenshotPath
        ? `Screenshot saved to ${screenshotPath}. The image shows the current browser viewport at ${browserResult.currentUrl || 'the current page'}.`
        : '[image]')))
      .join('\n');

    return {
      toolName: request.name,
      result: toolResult,
      resultContent: ollamaContent,
      formattedBlocks: formatted,
      isError: !!browserResult.error,
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
      if (!mcpResult.is_error) cb?.recordSuccess(request.name);
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
      const errorResult: ToolResult = { success: false, error: errorMsg };
      yield { type: 'tool_done', name: request.name, result: errorResult };
      return {
        toolName: request.name,
        result: errorResult,
        resultContent: `Error: ${errorMsg}`,
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
    // Wrap execution with retry for transient errors
    let result = await retryTransient(async () => handler(ctx.toolCtx, toolInput));

    // Handle permission request for out-of-scope paths
    if (result.needsPermission) {
      const requestId = crypto.randomUUID();
      yield { type: 'permission_request', requestId, path: result.needsPermission, toolName: request.name };
      const granted = await ctx.waitForPermission(requestId);
      if (granted) {
        await ctx.addAllowedPath(result.needsPermission);
        result = await retryTransient(async () => handler(ctx.toolCtx, toolInput));
      } else {
        result = { success: false, error: 'Access denied by user.' };
      }
    }

    cb?.recordSuccess(request.name);
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
    const errorMsg = err instanceof Error ? err.message : 'Tool execution failed';

    // Record failure in circuit breaker
    if (cb) {
      const tripped = cb.recordFailure(request.name);
      if (tripped) {
        logger.warn(`[tool-executor] Circuit breaker tripped for "${request.name}" after repeated failures`);
      }
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
