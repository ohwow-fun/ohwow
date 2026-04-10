/**
 * ModelRouter — Abstracts model providers for local (Ollama) and cloud (Anthropic) inference.
 *
 * Routes based on task type:
 * - Orchestrator chat, memory extraction → Ollama (when available)
 * - Planning, browser tasks, complex reasoning → Claude (Anthropic)
 * - Auto-fallback: if Ollama fails, escalate to Claude transparently
 */

import Anthropic from '@anthropic-ai/sdk';
import { getWorkingNumCtx } from '../lib/ollama-models.js';
import { CLAUDE_CONTEXT_LIMITS } from './ai-types.js';
import type { OperationType } from './execution-policy.js';
import { resolvePolicy, shouldPreferLocal } from './execution-policy.js';
import { ClaudeCodeProvider } from './providers/claude-code-provider.js';
import { LlamaCppProvider } from './providers/llama-cpp-provider.js';
import { MLXProvider } from './providers/mlx-provider.js';
import { OpenAICompatibleProvider } from './providers/openai-compatible-provider.js';
import type {
  TextBlock,
  MessageParam,
  ImageBlockParam,
  ContentBlockParam,
  Tool,
  ToolUseBlock,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';

// ============================================================================
// PROVIDER INTERFACE
// ============================================================================

export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ModelMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | MessageContentPart[];
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

export interface ModelResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  provider: 'anthropic' | 'ollama' | 'openrouter' | 'claude-code' | 'llama-cpp' | 'mlx' | 'openai-compatible';
  /** Actual cost in cents reported by provider (e.g., OpenRouter x-openrouter-cost header). */
  costCents?: number;
}

// ============================================================================
// TOOL CALLING TYPES (OpenAI format, used by Ollama)
// ============================================================================

export interface OpenAIToolFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OpenAITool {
  type: 'function';
  function: OpenAIToolFunction;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ModelResponseWithTools extends ModelResponse {
  toolCalls: OpenAIToolCall[];
}

export interface CreateMessageParams {
  model?: string;
  system?: string;
  messages: ModelMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Ollama num_ctx override — sets the context window size for the request. */
  numCtx?: number;
}

export interface ModelProvider {
  createMessage(params: CreateMessageParams): Promise<ModelResponse>;
  createMessageWithTools?(params: CreateMessageParams & {
    tools: OpenAITool[];
  }): Promise<ModelResponseWithTools>;
  isAvailable(): Promise<boolean>;
  readonly name: string;
}

// ============================================================================
// ANTHROPIC PROVIDER
// ============================================================================

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async createMessage(params: CreateMessageParams): Promise<ModelResponse> {
    const messages: MessageParam[] = params.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string'
          ? m.content
          : this.convertToAnthropicContent(m.content),
      }));

    const response = await this.client.messages.create({
      model: params.model || 'claude-haiku-4-5-20251001',
      max_tokens: params.maxTokens || 4096,
      temperature: params.temperature ?? 0.5,
      system: params.system,
      messages,
    });

    const textContent = response.content
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return {
      content: textContent,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      model: params.model || 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
    };
  }

  async createMessageWithTools(params: CreateMessageParams & {
    tools: OpenAITool[];
  }): Promise<ModelResponseWithTools> {
    // Convert OpenAI-format tools to Anthropic format
    const anthropicTools: Tool[] = params.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as Tool['input_schema'],
    }));

    // Convert messages to Anthropic format, handling tool_calls and tool results
    const messages: MessageParam[] = [];
    for (const m of params.messages) {
      if (m.role === 'system') continue;

      if (m.role === 'tool' && m.tool_call_id) {
        // Tool result → user message with tool_result content block
        const resultContent = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: resultContent,
          } as ToolResultBlockParam],
        });
      } else if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        // Assistant message with tool_calls → assistant with tool_use content blocks
        const blocks: ContentBlockParam[] = [];
        const textContent = typeof m.content === 'string' ? m.content : '';
        if (textContent) {
          blocks.push({ type: 'text', text: textContent });
        }
        for (const tc of m.tool_calls) {
          let input: Record<string, unknown>;
          try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          } as ContentBlockParam);
        }
        messages.push({ role: 'assistant', content: blocks });
      } else {
        // Regular message
        messages.push({
          role: m.role as 'user' | 'assistant',
          content: typeof m.content === 'string'
            ? m.content
            : this.convertToAnthropicContent(m.content),
        });
      }
    }

    const response = await this.client.messages.create({
      model: params.model || 'claude-haiku-4-5-20251001',
      max_tokens: params.maxTokens || 4096,
      temperature: params.temperature ?? 0.5,
      system: params.system,
      messages,
      tools: anthropicTools,
      tool_choice: { type: 'auto' },
    });

    // Extract text content and tool calls from response
    let textContent = '';
    const toolCalls: OpenAIToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += (block as TextBlock).text;
      } else if (block.type === 'tool_use') {
        const toolBlock = block as ToolUseBlock;
        toolCalls.push({
          id: toolBlock.id,
          type: 'function',
          function: {
            name: toolBlock.name,
            arguments: JSON.stringify(toolBlock.input),
          },
        });
      }
    }

    return {
      content: textContent,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      model: params.model || 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      toolCalls,
    };
  }

  /** Convert OpenAI-style content parts to Anthropic content blocks, including images. */
  private convertToAnthropicContent(parts: MessageContentPart[]): string | ContentBlockParam[] {
    const hasImages = parts.some((p) => p.type === 'image_url');
    if (!hasImages) {
      // Text-only: join as a single string (original behavior)
      return parts
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
    }

    // Mixed content: build Anthropic content blocks
    const blocks: ContentBlockParam[] = [];
    for (const part of parts) {
      if (part.type === 'text') {
        blocks.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        const url = part.image_url.url;
        const dataUriMatch = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (dataUriMatch) {
          const mediaType = dataUriMatch[1] as ImageBlockParam['source'] extends { media_type: infer T } ? T : never;
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: dataUriMatch[2],
            },
          } as ImageBlockParam);
        }
      }
    }
    return blocks;
  }

  async isAvailable(): Promise<boolean> {
    return true; // Available as long as API key exists
  }
}

// ============================================================================
// OLLAMA PROVIDER
// ============================================================================

const AVAILABILITY_TTL_OK_MS = 30_000;   // 30s when Ollama is up
const AVAILABILITY_TTL_FAIL_MS = 5_000;  // 5s when down (fast recovery)

export class OllamaProvider implements ModelProvider {
  readonly name = 'ollama';
  private baseUrl: string;
  private defaultModel: string;
  private _available: boolean | null = null;
  private _availableCheckedAt = 0;
  private _responseCallback: ((model: string, inputTokens: number, outputTokens: number, durationMs: number) => void) | null = null;

  constructor(baseUrl: string, defaultModel: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.defaultModel = defaultModel;
  }

  /** Set a callback that fires after each successful response (for stats tracking). */
  setResponseCallback(cb: (model: string, inputTokens: number, outputTokens: number, durationMs: number) => void): void {
    this._responseCallback = cb;
  }

  async createMessage(params: CreateMessageParams): Promise<ModelResponse> {
    const model = params.model || this.defaultModel;

    // Build messages in OpenAI format (Ollama supports this)
    const messages: Array<{ role: string; content: string | MessageContentPart[] }> = [];
    if (params.system) {
      messages.push({ role: 'system', content: params.system });
    }
    for (const m of params.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    const startTime = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model,
          messages,
          max_tokens: params.maxTokens || 4096,
          temperature: params.temperature ?? 0.5,
          stream: false,
          options: { num_ctx: params.numCtx || getWorkingNumCtx(model) },
        }),
      });
    } catch (err) {
      // Network error — reset availability cache so next check re-probes
      this._available = null;
      this._availableCheckedAt = 0;
      throw err;
    }

    if (!response.ok) {
      await this.throwOllamaError(response);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const content = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };
    const durationMs = Date.now() - startTime;

    // Notify stats tracker
    if (this._responseCallback) {
      try { this._responseCallback(model, usage.prompt_tokens, usage.completion_tokens, durationMs); } catch { /* */ }
    }

    return {
      content,
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      model,
      provider: 'ollama',
    };
  }

  async createMessageWithTools(params: CreateMessageParams & {
    tools: OpenAITool[];
  }): Promise<ModelResponseWithTools> {
    const model = params.model || this.defaultModel;

    type OllamaMsg = {
      role: string;
      content: string | MessageContentPart[];
      tool_call_id?: string;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
    const messages: OllamaMsg[] = [];
    if (params.system) {
      messages.push({ role: 'system', content: params.system });
    }
    for (const m of params.messages) {
      const msg: OllamaMsg = { role: m.role, content: m.content };
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      messages.push(msg);
    }

    const startTime = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model,
          messages,
          max_tokens: params.maxTokens || 4096,
          temperature: params.temperature ?? 0.5,
          stream: false,
          tools: params.tools,
          tool_choice: 'auto',
          options: { num_ctx: params.numCtx || getWorkingNumCtx(model) },
        }),
      });
    } catch (err) {
      // Network error — reset availability cache so next check re-probes
      this._available = null;
      this._availableCheckedAt = 0;
      throw err;
    }

    if (!response.ok) {
      await this.throwOllamaError(response);
    }

    const data = await response.json() as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id?: string;
            type: 'function';
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices?.[0];
    const content = choice?.message?.content || '';
    const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };
    const durationMs = Date.now() - startTime;

    // Notify stats tracker
    if (this._responseCallback) {
      try { this._responseCallback(model, usage.prompt_tokens, usage.completion_tokens, durationMs); } catch { /* */ }
    }

    const toolCalls: OpenAIToolCall[] = (choice?.message?.tool_calls || [])
      .filter((tc) => tc.function && typeof tc.function.name === 'string')
      .map((tc, i) => ({
        id: tc.id || `call_${i}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments ?? '{}',
        },
      }));

    return {
      content,
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      model,
      provider: 'ollama',
      toolCalls,
    };
  }

  async isAvailable(): Promise<boolean> {
    // Return cached value if within TTL (shorter TTL for failures → faster recovery)
    if (this._available !== null) {
      const ttl = this._available ? AVAILABILITY_TTL_OK_MS : AVAILABILITY_TTL_FAIL_MS;
      if ((Date.now() - this._availableCheckedAt) < ttl) {
        return this._available;
      }
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      this._available = response.ok;
      this._availableCheckedAt = Date.now();
      return this._available;
    } catch {
      this._available = false;
      this._availableCheckedAt = Date.now();
      return false;
    }
  }

  /** Parse Ollama error response and throw a descriptive error (OOM + model-not-found detection). */
  private async throwOllamaError(response: Response): Promise<never> {
    const text = await response.text();
    const lower = text.toLowerCase();
    if (lower.includes('out of memory') || lower.includes('cuda') || lower.includes('mmap') || lower.includes('oom') || lower.includes('not enough memory')) {
      throw new Error(`Model too large for available memory. Try a smaller model. Ollama: ${text.slice(0, 200)}`);
    }
    if (response.status === 404 || lower.includes('not found') || lower.includes('no such model')) {
      throw new Error(`Model not found in Ollama. Make sure it's downloaded first. Ollama: ${text.slice(0, 200)}`);
    }
    throw new Error(`Ollama request failed (${response.status}): ${text}`);
  }

  /**
   * Streaming version of createMessage(). Yields text tokens as they arrive
   * and returns the final ModelResponse.
   */
  async *createMessageStreaming(params: CreateMessageParams): AsyncGenerator<{ type: 'token'; content: string }, ModelResponse> {
    const model = params.model || this.defaultModel;

    const messages: Array<{ role: string; content: string | MessageContentPart[] }> = [];
    if (params.system) {
      messages.push({ role: 'system', content: params.system });
    }
    for (const m of params.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    const startTime = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model,
          messages,
          max_tokens: params.maxTokens || 4096,
          temperature: params.temperature ?? 0.5,
          stream: true,
          options: { num_ctx: params.numCtx || getWorkingNumCtx(model) },
        }),
      });
    } catch (err) {
      this._available = null;
      this._availableCheckedAt = 0;
      throw err;
    }

    if (!response.ok) {
      await this.throwOllamaError(response);
    }

    let fullContent = '';
    let usage = { prompt_tokens: 0, completion_tokens: 0 };

    for await (const chunk of this.parseOllamaStream(response)) {
      if (chunk.content) {
        fullContent += chunk.content;
        yield { type: 'token', content: chunk.content };
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }

    const durationMs = Date.now() - startTime;
    if (this._responseCallback) {
      try { this._responseCallback(model, usage.prompt_tokens, usage.completion_tokens, durationMs); } catch { /* */ }
    }

    return {
      content: fullContent,
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      model,
      provider: 'ollama',
    };
  }

  /**
   * Streaming version of createMessageWithTools(). Yields text tokens as they arrive,
   * accumulates tool call deltas, and returns the final ModelResponseWithTools.
   */
  async *createMessageWithToolsStreaming(params: CreateMessageParams & {
    tools: OpenAITool[];
  }): AsyncGenerator<{ type: 'token'; content: string }, ModelResponseWithTools> {
    const model = params.model || this.defaultModel;

    type OllamaMsg = {
      role: string;
      content: string | MessageContentPart[];
      tool_call_id?: string;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
    const messages: OllamaMsg[] = [];
    if (params.system) {
      messages.push({ role: 'system', content: params.system });
    }
    for (const m of params.messages) {
      const msg: OllamaMsg = { role: m.role, content: m.content };
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      messages.push(msg);
    }

    const startTime = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model,
          messages,
          max_tokens: params.maxTokens || 4096,
          temperature: params.temperature ?? 0.5,
          stream: true,
          tools: params.tools,
          tool_choice: 'auto',
          options: { num_ctx: params.numCtx || getWorkingNumCtx(model) },
        }),
      });
    } catch (err) {
      this._available = null;
      this._availableCheckedAt = 0;
      throw err;
    }

    if (!response.ok) {
      await this.throwOllamaError(response);
    }

    let fullContent = '';
    let usage = { prompt_tokens: 0, completion_tokens: 0 };
    // Accumulate tool calls by index
    const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();
    let hasToolCalls = false;

    for await (const chunk of this.parseOllamaStream(response)) {
      if (chunk.content && !hasToolCalls) {
        fullContent += chunk.content;
        yield { type: 'token', content: chunk.content };
      } else if (chunk.content) {
        // Tool calls detected — accumulate text but don't yield
        fullContent += chunk.content;
      }
      if (chunk.toolCalls) {
        hasToolCalls = true;
        for (const tc of chunk.toolCalls) {
          const existing = toolCallAccum.get(tc.index);
          if (existing) {
            if (tc.name) existing.name += tc.name;
            if (tc.arguments) existing.arguments += tc.arguments;
          } else {
            toolCallAccum.set(tc.index, {
              id: tc.id || `call_${tc.index}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              name: tc.name || '',
              arguments: tc.arguments || '',
            });
          }
        }
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }

    const durationMs = Date.now() - startTime;
    if (this._responseCallback) {
      try { this._responseCallback(model, usage.prompt_tokens, usage.completion_tokens, durationMs); } catch { /* */ }
    }

    const toolCalls: OpenAIToolCall[] = Array.from(toolCallAccum.values())
      .filter(tc => tc.name)
      .map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: tc.arguments || '{}',
        },
      }));

    return {
      content: fullContent,
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      model,
      provider: 'ollama',
      toolCalls,
    };
  }

  /**
   * Parse an SSE stream from Ollama's OpenAI-compatible endpoint.
   * Yields parsed chunks with content, tool call deltas, and usage.
   */
  private async *parseOllamaStream(response: Response): AsyncGenerator<{
    content?: string;
    toolCalls?: Array<{ index: number; id?: string; name?: string; arguments?: string }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  }> {
    if (!response.body) return;

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const chunk = JSON.parse(data) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  tool_calls?: Array<{
                    index: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
              }>;
              usage?: { prompt_tokens: number; completion_tokens: number };
            };

            const delta = chunk.choices?.[0]?.delta;
            const result: {
              content?: string;
              toolCalls?: Array<{ index: number; id?: string; name?: string; arguments?: string }>;
              usage?: { prompt_tokens: number; completion_tokens: number };
            } = {};

            if (delta?.content) {
              result.content = delta.content;
            }

            if (delta?.tool_calls) {
              result.toolCalls = delta.tool_calls.map(tc => ({
                index: tc.index,
                id: tc.id,
                name: tc.function?.name,
                arguments: tc.function?.arguments,
              }));
            }

            if (chunk.usage) {
              result.usage = chunk.usage;
            }

            if (result.content || result.toolCalls || result.usage) {
              yield result;
            }
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Update the default model used for inference. */
  setDefaultModel(model: string): void {
    this.defaultModel = model;
  }

  /** Returns the current default model tag. */
  getDefaultModel(): string {
    return this.defaultModel;
  }

  /** Reset cached availability (for retry after reconnect) */
  resetAvailability(): void {
    this._available = null;
    this._availableCheckedAt = 0;
  }

  /** Get list of available models from Ollama */
  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return [];
      const data = await response.json() as { models?: Array<{ name: string }> };
      return (data.models || []).map((m) => m.name);
    } catch {
      return [];
    }
  }
}

// ============================================================================
// OPENROUTER PROVIDER
// ============================================================================

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Curated OpenRouter models — mirrors the cloud dashboard catalog.
 * Organized by tier: each model has a specific role in the routing hierarchy.
 *
 * Tier 1 (primary): best quality-to-cost ratio per task type
 * Tier 2 (premium): higher quality for complex/critical tasks
 * Tier 3 (fallback): legacy or niche models
 */
export const CURATED_OPENROUTER_MODELS: OpenRouterModelInfo[] = [
  // ── Tier 1: Primary models ──────────────────────────────────────────
  {
    id: 'google/gemini-3.1-flash-lite-preview',
    name: 'Gemini 3.1 Flash Lite',
    contextLength: 1_048_576,
    pricing: { prompt: 0.00000025, completion: 0.0000015 },
    supportsTools: true,
    supportsVision: true,
    isFree: false,
  },
  {
    id: 'deepseek/deepseek-v3.2',
    name: 'DeepSeek V3.2',
    contextLength: 163_840,
    pricing: { prompt: 0.00000026, completion: 0.00000038 },
    supportsTools: true,
    supportsVision: false,
    isFree: false,
  },
  {
    id: 'xiaomi/mimo-v2-flash',
    name: 'MiMo-V2-Flash',
    contextLength: 262_144,
    pricing: { prompt: 0, completion: 0 },
    supportsTools: true,
    supportsVision: false,
    isFree: true,
  },
  {
    id: 'google/gemini-3.1-flash-image-preview',
    name: 'Nano Banana 2 (image gen)',
    contextLength: 65_536,
    pricing: { prompt: 0.0000005, completion: 0.000003 },
    supportsTools: false,
    supportsVision: true,
    isFree: false,
  },
  {
    id: 'qwen/qwen3.5-9b',
    name: 'Qwen 3.5 9B',
    contextLength: 262_144,
    pricing: { prompt: 0.00000005, completion: 0.00000015 },
    supportsTools: true,
    supportsVision: true,
    isFree: false,
  },
  {
    id: 'qwen/qwen3.5-35b-a3b',
    name: 'Qwen 3.5 35B',
    contextLength: 262_144,
    pricing: { prompt: 0.00000016, completion: 0.0000013 },
    supportsTools: true,
    supportsVision: true,
    isFree: false,
  },
  {
    id: 'google/gemini-3-flash-preview',
    name: 'Gemini 3 Flash',
    contextLength: 1_048_576,
    pricing: { prompt: 0.0000005, completion: 0.000003 },
    supportsTools: true,
    supportsVision: true,
    isFree: false,
  },
  {
    id: 'x-ai/grok-4.1-fast',
    name: 'Grok 4.1 Fast',
    contextLength: 2_000_000,
    pricing: { prompt: 0.0000002, completion: 0.0000005 },
    supportsTools: true,
    supportsVision: false,
    isFree: false,
  },
  // ── Tier 2: Premium models ──────────────────────────────────────────
  {
    id: 'x-ai/grok-4.20',
    name: 'Grok 4.20',
    contextLength: 2_000_000,
    pricing: { prompt: 0.000002, completion: 0.000006 },
    supportsTools: true,
    supportsVision: false,
    isFree: false,
  },
  {
    id: 'anthropic/claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    contextLength: 1_000_000,
    pricing: { prompt: 0.000003, completion: 0.000015 },
    supportsTools: true,
    supportsVision: true,
    isFree: false,
  },
  {
    id: 'deepseek/deepseek-r1',
    name: 'DeepSeek R1',
    contextLength: 64_000,
    pricing: { prompt: 0.0000007, completion: 0.0000025 },
    supportsTools: false,
    supportsVision: false,
    isFree: false,
  },
  {
    id: 'google/gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro',
    contextLength: 1_048_576,
    pricing: { prompt: 0.000002, completion: 0.000012 },
    supportsTools: true,
    supportsVision: true,
    isFree: false,
  },
  {
    id: 'z-ai/glm-5.1',
    name: 'GLM 5.1',
    contextLength: 200_000,
    pricing: { prompt: 0.000001, completion: 0.0000032 },
    supportsTools: true,
    supportsVision: false,
    isFree: false,
  },
  {
    id: 'xiaomi/mimo-v2-pro',
    name: 'MiMo-V2-Pro',
    contextLength: 1_048_576,
    pricing: { prompt: 0.000001, completion: 0.000003 },
    supportsTools: true,
    supportsVision: false,
    isFree: false,
  },
  // ── Tier 3: Fallback / niche ────────────────────────────────────────
  {
    id: 'anthropic/claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    contextLength: 200_000,
    pricing: { prompt: 0.000001, completion: 0.000005 },
    supportsTools: true,
    supportsVision: true,
    isFree: false,
  },
  {
    id: 'anthropic/claude-opus-4.6',
    name: 'Claude Opus 4.6',
    contextLength: 1_000_000,
    pricing: { prompt: 0.000005, completion: 0.000025 },
    supportsTools: true,
    supportsVision: true,
    isFree: false,
  },
  {
    id: 'xiaomi/mimo-v2-omni',
    name: 'MiMo-V2-Omni',
    contextLength: 262_144,
    pricing: { prompt: 0.0000004, completion: 0.000002 },
    supportsTools: true,
    supportsVision: true,
    isFree: false,
  },
  {
    id: 'mistralai/devstral-2512',
    name: 'Devstral 2',
    contextLength: 262_144,
    pricing: { prompt: 0.00000005, completion: 0.00000022 },
    supportsTools: true,
    supportsVision: false,
    isFree: false,
  },
  {
    id: 'qwen/qwen3.5-flash-02-23',
    name: 'Qwen 3.5 Flash',
    contextLength: 1_000_000,
    pricing: { prompt: 0.00000007, completion: 0.00000026 },
    supportsTools: true,
    supportsVision: false,
    isFree: false,
  },
];

/** Model info returned by OpenRouter's /models endpoint. */
export interface OpenRouterModelInfo {
  id: string;
  name: string;
  contextLength: number;
  pricing: { prompt: number; completion: number };
  supportsTools: boolean;
  supportsVision: boolean;
  isFree: boolean;
}

export class OpenRouterProvider implements ModelProvider {
  readonly name = 'openrouter';
  private apiKey: string;
  private defaultModel: string;
  private _available: boolean | null = null;
  private _availableCheckedAt = 0;
  private _modelsCache: OpenRouterModelInfo[] | null = null;
  private _modelsCachedAt = 0;
  private static MODELS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(apiKey: string, defaultModel: string = 'deepseek/deepseek-v3.2') {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
  }

  private getHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://ohwow.fun',
      'X-Title': 'OHWOW',
    };
  }

  async createMessage(params: CreateMessageParams): Promise<ModelResponse> {
    const model = params.model || this.defaultModel;

    const messages: Array<{ role: string; content: string | MessageContentPart[] }> = [];
    if (params.system) {
      messages.push({ role: 'system', content: params.system });
    }
    for (const m of params.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    const startTime = Date.now();
    let response: Response;
    try {
      response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model,
          messages,
          max_tokens: params.maxTokens || 4096,
          temperature: params.temperature ?? 0.5,
          stream: false,
        }),
      });
    } catch (err) {
      this._available = null;
      this._availableCheckedAt = 0;
      throw err;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OpenRouter request failed (${response.status}): ${text.slice(0, 200)}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const content = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };
    const _durationMs = Date.now() - startTime;

    // Extract actual cost from OpenRouter response header (USD → cents)
    const openrouterCostHeader = response.headers.get('x-openrouter-cost');
    const costCents = openrouterCostHeader
      ? Math.ceil(parseFloat(openrouterCostHeader) * 100)
      : undefined;

    return {
      content,
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      model,
      provider: 'openrouter',
      costCents,
    };
  }

  async createMessageWithTools(params: CreateMessageParams & {
    tools: OpenAITool[];
  }): Promise<ModelResponseWithTools> {
    const model = params.model || this.defaultModel;

    type ORMsg = {
      role: string;
      content: string | MessageContentPart[];
      tool_call_id?: string;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
    const messages: ORMsg[] = [];
    if (params.system) {
      messages.push({ role: 'system', content: params.system });
    }
    for (const m of params.messages) {
      const msg: ORMsg = { role: m.role, content: m.content };
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      messages.push(msg);
    }

    let response: Response;
    try {
      response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model,
          messages,
          max_tokens: params.maxTokens || 4096,
          temperature: params.temperature ?? 0.5,
          stream: false,
          tools: params.tools,
          tool_choice: 'auto',
        }),
      });
    } catch (err) {
      this._available = null;
      this._availableCheckedAt = 0;
      throw err;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OpenRouter request failed (${response.status}): ${text.slice(0, 200)}`);
    }

    const data = await response.json() as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id?: string;
            type: 'function';
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices?.[0];
    const content = choice?.message?.content || '';
    const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };

    const toolCalls: OpenAIToolCall[] = (choice?.message?.tool_calls || [])
      .filter((tc) => tc.function && typeof tc.function.name === 'string')
      .map((tc, i) => ({
        id: tc.id || `call_${i}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments ?? '{}',
        },
      }));

    // Extract actual cost from OpenRouter response header (USD → cents)
    const openrouterCostHeader = response.headers.get('x-openrouter-cost');
    const costCents = openrouterCostHeader
      ? Math.ceil(parseFloat(openrouterCostHeader) * 100)
      : undefined;

    return {
      content,
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      model,
      provider: 'openrouter',
      costCents,
      toolCalls,
    };
  }

  /**
   * Streaming tool-calling via OpenRouter (OpenAI chat/completions SSE format).
   * Yields text tokens as they arrive, accumulates tool_call deltas,
   * and returns the final ModelResponseWithTools.
   */
  async *createMessageWithToolsStreaming(params: CreateMessageParams & {
    tools: OpenAITool[];
  }): AsyncGenerator<{ type: 'token'; content: string }, ModelResponseWithTools> {
    const model = params.model || this.defaultModel;

    type ORMsg = {
      role: string;
      content: string | MessageContentPart[];
      tool_call_id?: string;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
    const messages: ORMsg[] = [];
    if (params.system) {
      messages.push({ role: 'system', content: params.system });
    }
    for (const m of params.messages) {
      const msg: ORMsg = { role: m.role, content: m.content };
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      messages.push(msg);
    }

    const startTime = Date.now();
    let response: Response;
    try {
      response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model,
          messages,
          max_tokens: params.maxTokens || 4096,
          temperature: params.temperature ?? 0.5,
          stream: true,
          tools: params.tools,
          tool_choice: 'auto',
        }),
      });
    } catch (err) {
      this._available = null;
      this._availableCheckedAt = 0;
      throw err;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OpenRouter streaming request failed (${response.status}): ${text.slice(0, 200)}`);
    }

    if (!response.body) {
      throw new Error('OpenRouter streaming response has no body');
    }

    let fullContent = '';
    let usage = { prompt_tokens: 0, completion_tokens: 0 };
    const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();
    let hasToolCalls = false;

    // Parse SSE stream (identical format to OpenAI chat/completions)
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const chunk = JSON.parse(data) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  tool_calls?: Array<{
                    index: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
              }>;
              usage?: { prompt_tokens: number; completion_tokens: number };
            };

            const delta = chunk.choices?.[0]?.delta;

            if (delta?.content && !hasToolCalls) {
              fullContent += delta.content;
              yield { type: 'token', content: delta.content };
            } else if (delta?.content) {
              fullContent += delta.content;
            }

            if (delta?.tool_calls) {
              hasToolCalls = true;
              for (const tc of delta.tool_calls) {
                const existing = toolCallAccum.get(tc.index);
                if (existing) {
                  if (tc.function?.name) existing.name += tc.function.name;
                  if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                } else {
                  toolCallAccum.set(tc.index, {
                    id: tc.id || `call_${tc.index}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    name: tc.function?.name || '',
                    arguments: tc.function?.arguments || '',
                  });
                }
              }
            }

            if (chunk.usage) {
              usage = chunk.usage;
            }
          } catch {
            // Skip malformed SSE chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const _durationMs = Date.now() - startTime;

    // Extract actual cost from OpenRouter response header
    const openrouterCostHeader = response.headers.get('x-openrouter-cost');
    const costCents = openrouterCostHeader
      ? Math.ceil(parseFloat(openrouterCostHeader) * 100)
      : undefined;

    const toolCalls: OpenAIToolCall[] = Array.from(toolCallAccum.values())
      .filter(tc => tc.name)
      .map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: tc.arguments || '{}',
        },
      }));

    return {
      content: fullContent,
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      model,
      provider: 'openrouter',
      costCents,
      toolCalls,
    };
  }

  async isAvailable(): Promise<boolean> {
    if (this._available !== null) {
      const ttl = this._available ? AVAILABILITY_TTL_OK_MS : AVAILABILITY_TTL_FAIL_MS;
      if ((Date.now() - this._availableCheckedAt) < ttl) {
        return this._available;
      }
    }

    try {
      const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      this._available = response.ok;
      this._availableCheckedAt = Date.now();
      return this._available;
    } catch {
      this._available = false;
      this._availableCheckedAt = Date.now();
      return false;
    }
  }

  /**
   * Fetch available models from OpenRouter with caching.
   * Returns curated models first (marked as recommended), then all others from the live API.
   * Falls back to the curated catalog if the API is unreachable.
   */
  async listModels(forceRefresh = false): Promise<OpenRouterModelInfo[]> {
    if (!forceRefresh && this._modelsCache && (Date.now() - this._modelsCachedAt) < OpenRouterProvider.MODELS_CACHE_TTL_MS) {
      return this._modelsCache;
    }

    try {
      const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return this._modelsCache || CURATED_OPENROUTER_MODELS;

      const data = await response.json() as {
        data: Array<{
          id: string;
          name: string;
          context_length?: number;
          pricing?: { prompt?: string; completion?: string };
          architecture?: { modality?: string; tokenizer?: string };
          supported_parameters?: string[];
        }>;
      };

      // Build live model list
      const liveModels = (data.data || []).map(m => {
        const promptPrice = parseFloat(m.pricing?.prompt || '0');
        const completionPrice = parseFloat(m.pricing?.completion || '0');
        const modality = m.architecture?.modality || '';
        return {
          id: m.id,
          name: m.name || m.id,
          contextLength: m.context_length || 4096,
          pricing: { prompt: promptPrice, completion: completionPrice },
          supportsTools: (m.supported_parameters || []).includes('tools'),
          supportsVision: modality.includes('image') || modality.includes('vision'),
          isFree: promptPrice === 0 && completionPrice === 0,
        };
      });

      // Curated models first (with live data if available), then remaining live models
      const curatedIds = new Set(CURATED_OPENROUTER_MODELS.map(m => m.id));
      const liveById = new Map(liveModels.map(m => [m.id, m]));

      const curated = CURATED_OPENROUTER_MODELS.map(c => liveById.get(c.id) || c);
      const rest = liveModels.filter(m => !curatedIds.has(m.id));

      this._modelsCache = [...curated, ...rest];
      this._modelsCachedAt = Date.now();
      return this._modelsCache;
    } catch {
      return this._modelsCache || CURATED_OPENROUTER_MODELS;
    }
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  setDefaultModel(model: string): void {
    this.defaultModel = model;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
    this._available = null;
    this._availableCheckedAt = 0;
    this._modelsCache = null;
    this._modelsCachedAt = 0;
  }

  resetAvailability(): void {
    this._available = null;
    this._availableCheckedAt = 0;
  }
}

// ============================================================================
// MODEL ROUTER
// ============================================================================

export type TaskType = 'orchestrator' | 'memory_extraction' | 'planning' | 'agent_task' | 'browser' | 'ocr' | 'vision' | 'audio';

export type ModelSourceOption = 'local' | 'cloud' | 'claude-code' | 'claude-code-cli' | 'auto';

/**
 * Routing history for adaptive model selection.
 * Compatible with cloud dashboard's RoutingHistory interface.
 * When provided to getProvider(), influences model tier:
 * - Low truth score (<60 with N≥5): escalate to higher-capability model
 * - High truth score (>85 with N≥10): allow downgrade to cheaper model
 */
export interface RoutingHistory {
  avgTruthScore: number;
  attempts: number;
}

export class ModelRouter {
  private anthropic: AnthropicProvider | null;
  private ollama: OllamaProvider | null;
  private ocrOllama: OllamaProvider | null;
  private quickOllama: OllamaProvider | null;
  private openrouter: OpenRouterProvider | null;
  private claudeCode: ClaudeCodeProvider | null;
  private llamaCpp: LlamaCppProvider | null;
  private mlx: MLXProvider | null;
  private openaiCompatible: OpenAICompatibleProvider | null;
  private preferLocal: boolean;
  private modelSource: ModelSourceOption;
  private cloudProvider: 'anthropic' | 'openrouter';
  private mainModelHasVision: boolean;
  private mainModelHasAudio: boolean;
  private _openRouterApiKey: string;
  private _onOllamaResponse: ((model: string, inputTokens: number, outputTokens: number, durationMs: number) => void) | null = null;
  /** Cached credit balance percentage (0-100). Updated from heartbeat responses. */
  private _creditBalancePercent = 100;

  constructor(opts: {
    anthropicApiKey?: string;
    ollamaUrl?: string;
    ollamaModel?: string;
    ocrModel?: string;
    quickModel?: string;
    openRouterApiKey?: string;
    openRouterModel?: string;
    preferLocalModel?: boolean;
    modelSource?: ModelSourceOption;
    /** Which cloud provider to use when modelSource === 'cloud' */
    cloudProvider?: 'anthropic' | 'openrouter';
    mainModelHasVision?: boolean;
    mainModelHasAudio?: boolean;
    onOllamaResponse?: (model: string, inputTokens: number, outputTokens: number, durationMs: number) => void;
    /** URL for llama-server with TurboQuant support */
    llamaCppUrl?: string;
    /** TurboQuant bits (>0 enables llama-cpp provider) */
    turboQuantBits?: 0 | 2 | 3 | 4;
    /** URL for mlx-vlm server (Apple Silicon native inference) */
    mlxServerUrl?: string;
    /** Whether MLX provider is enabled */
    mlxEnabled?: boolean;
    /** MLX model identifier */
    mlxModel?: string;
    /** Base URL for OpenAI-compatible provider (e.g. http://localhost:8000) */
    openaiCompatibleUrl?: string;
    /** API key for OpenAI-compatible provider */
    openaiCompatibleApiKey?: string;
    /** Path to claude CLI binary for Claude Code provider (empty = auto-detect) */
    claudeCodeCliPath?: string;
    /** Model override for Claude Code provider */
    claudeCodeCliModel?: string;
  }) {
    this.anthropic = opts.anthropicApiKey
      ? new AnthropicProvider(opts.anthropicApiKey)
      : null;
    this.modelSource = opts.modelSource ?? 'auto';
    this.cloudProvider = opts.cloudProvider ?? 'anthropic';
    this.ollama = opts.ollamaUrl
      ? new OllamaProvider(opts.ollamaUrl, opts.ollamaModel || 'qwen3:4b')
      : null;
    this.ocrOllama = opts.ollamaUrl && opts.ocrModel
      ? new OllamaProvider(opts.ollamaUrl, opts.ocrModel)
      : null;
    this.quickOllama = opts.ollamaUrl && opts.quickModel
      ? new OllamaProvider(opts.ollamaUrl, opts.quickModel)
      : null;
    this.openrouter = opts.openRouterApiKey
      ? new OpenRouterProvider(opts.openRouterApiKey, opts.openRouterModel || 'deepseek/deepseek-v3.2')
      : null;
    this.claudeCode = this.modelSource === 'claude-code'
      ? new ClaudeCodeProvider(opts.claudeCodeCliPath, opts.claudeCodeCliModel)
      : null;
    this.llamaCpp = (opts.llamaCppUrl && opts.turboQuantBits && opts.turboQuantBits > 0)
      ? new LlamaCppProvider(opts.llamaCppUrl, opts.ollamaModel || 'qwen3:4b')
      : null;
    this.mlx = (opts.mlxServerUrl && opts.mlxEnabled)
      ? new MLXProvider(opts.mlxServerUrl, opts.mlxModel || '')
      : null;
    this.openaiCompatible = opts.openaiCompatibleUrl
      ? new OpenAICompatibleProvider(opts.openaiCompatibleUrl, opts.ollamaModel || 'qwen3:4b', opts.openaiCompatibleApiKey || undefined)
      : null;
    this.preferLocal = opts.preferLocalModel ?? false;
    this.mainModelHasVision = opts.mainModelHasVision ?? false;
    this.mainModelHasAudio = opts.mainModelHasAudio ?? false;
    this._openRouterApiKey = opts.openRouterApiKey ?? '';
    this._onOllamaResponse = opts.onOllamaResponse ?? null;

    // Wire response callback to all local providers
    if (this._onOllamaResponse) {
      const cb = this._onOllamaResponse;
      this.ollama?.setResponseCallback(cb);
      this.ocrOllama?.setResponseCallback(cb);
      this.quickOllama?.setResponseCallback(cb);
      this.llamaCpp?.setResponseCallback(cb);
      this.mlx?.setResponseCallback(cb);
      this.openaiCompatible?.setResponseCallback(cb);
    }
  }

  /** Set callback for Ollama response tracking (usage stats). */
  setOnOllamaResponse(cb: (model: string, inputTokens: number, outputTokens: number, durationMs: number) => void): void {
    this._onOllamaResponse = cb;
    this.ollama?.setResponseCallback(cb);
    this.ocrOllama?.setResponseCallback(cb);
  }

  /** Notify the callback after a successful Ollama response. */
  notifyOllamaResponse(model: string, inputTokens: number, outputTokens: number, durationMs: number): void {
    if (this._onOllamaResponse) {
      try {
        this._onOllamaResponse(model, inputTokens, outputTokens, durationMs);
      } catch {
        // Stats tracking should never break request flow
      }
    }
  }

  /** Try cloud providers in order of cloudProvider preference. Returns null if none available. */
  private async tryCloudProvider(): Promise<ModelProvider | null> {
    if (this.cloudProvider === 'openrouter') {
      if (this.openrouter) {
        const available = await this.openrouter.isAvailable();
        if (available) return this.openrouter;
      }
      if (this.anthropic) return this.anthropic;
    } else {
      if (this.anthropic) return this.anthropic;
      if (this.openrouter) {
        const available = await this.openrouter.isAvailable();
        if (available) return this.openrouter;
      }
    }
    return null;
  }

  /**
   * Get the appropriate provider for a task type.
   * Behavior depends on modelSource (and optionally, execution policy):
   * - 'cloud': always use Anthropic (all task types), fall back to Ollama if unavailable
   * - 'local': always prefer Ollama, fall back to Anthropic
   * - 'auto': route by task type (orchestrator/memory → Ollama, planning/agent/browser → Anthropic)
   *
   * When operationType is provided, the execution policy may override the modelSource
   * for that specific operation (e.g., planning always prefers cloud, memory extraction always local).
   */
  async getProvider(taskType: TaskType, difficulty?: 'simple' | 'moderate' | 'complex', operationType?: OperationType, routingHistory?: RoutingHistory): Promise<ModelProvider> {
    // Adaptive model routing: if routing history shows low quality, escalate to cloud
    if (routingHistory && this.modelSource === 'auto') {
      const { avgTruthScore, attempts } = routingHistory;
      if (attempts >= 5 && avgTruthScore < 60 && this.anthropic) {
        // Low quality with sufficient data: escalate to Anthropic
        return this.anthropic;
      }
      if (attempts >= 10 && avgTruthScore > 85 && this.ollama) {
        // Consistently high quality: allow downgrade to local
        const available = await this.ollama.isAvailable();
        if (available) return this.ollama;
      }
    }

    // OCR and vision tasks: try MLX → dedicated OCR model → vision-capable main model → Anthropic
    if (taskType === 'ocr' || taskType === 'vision') {
      // 0. MLX (native multimodal on Apple Silicon — best for vision/audio)
      if (this.mlx) {
        const available = await this.mlx.isAvailable();
        if (available) return this.mlx;
      }
      // 1. Dedicated OCR model (best for OCR/vision tasks)
      if (this.ocrOllama) {
        const available = await this.ocrOllama.isAvailable();
        if (available) return this.ocrOllama;
      }
      // 2. Main Ollama model if it supports vision
      if (this.mainModelHasVision && this.ollama) {
        const available = await this.ollama.isAvailable();
        if (available) return this.ollama;
      }
      // 3. Anthropic (Claude supports vision natively)
      if (this.anthropic) return this.anthropic;

      throw new Error('No vision-capable model available. Configure an OCR model, use a vision-capable local model, or add an Anthropic API key.');
    }

    // Audio tasks: try MLX → audio-capable main model → Anthropic fallback
    if (taskType === 'audio') {
      if (this.mlx) {
        const available = await this.mlx.isAvailable();
        if (available) return this.mlx;
      }
      if (this.mainModelHasAudio && this.ollama) {
        const available = await this.ollama.isAvailable();
        if (available) return this.ollama;
      }
      if (this.anthropic) return this.anthropic;
      throw new Error('No audio-capable model available. Install Gemma 4 E2B or E4B, or add an Anthropic API key.');
    }

    // Execution policy override: when an operationType is provided and modelSource is 'auto',
    // the execution policy may override routing for that specific operation.
    if (operationType && this.modelSource === 'auto') {
      const policy = resolvePolicy(operationType);
      if (shouldPreferLocal(policy, this._creditBalancePercent)) {
        // Policy says prefer local (either explicitly or because credits are low)
        if (this.ollama) {
          const available = await this.ollama.isAvailable();
          if (available) return this.ollama;
        }
        // Fall back based on policy
        if (policy.fallback === 'cloud') {
          const cloudResult = await this.tryCloudProvider();
          if (cloudResult) return cloudResult;
        }
      } else if (policy.modelSource === 'cloud') {
        // Policy explicitly wants cloud — respect cloudProvider preference
        const cloudResult = await this.tryCloudProvider();
        if (cloudResult) return cloudResult;
        // Fall back to local if policy allows
        if (policy.fallback === 'local' && this.ollama) {
          const available = await this.ollama.isAvailable();
          if (available) return this.ollama;
        }
      }
      // For 'auto' policy modelSource, fall through to standard routing below
    }

    // Claude Code mode: route through Claude Code CLI
    if (this.modelSource === 'claude-code') {
      if (this.claudeCode) {
        const available = await this.claudeCode.isAvailable();
        if (available) return this.claudeCode;
      }
      // Fall back to Ollama → Anthropic
      if (this.ollama) {
        const available = await this.ollama.isAvailable();
        if (available) return this.ollama;
      }
      if (this.anthropic) return this.anthropic;
      throw new Error('Claude Code mode selected but the CLI is not available. Make sure Claude Code is installed and authenticated.');
    }

    // Cloud mode: use the selected cloud provider (Anthropic or OpenRouter)
    if (this.modelSource === 'cloud') {
      if (this.cloudProvider === 'openrouter') {
        // OpenRouter cloud provider — user explicitly chose this, return it
        // directly without availability check to avoid timeout-induced fallback
        // to Ollama (which would use wrong context limits and model size).
        if (this.openrouter) return this.openrouter;
        // No OpenRouter configured at all — throw, don't silently fall back
        throw new Error('Cloud mode with OpenRouter selected but no API key configured. Add openRouterApiKey to your config.');
      }

      // Anthropic cloud provider (default)
      if (this.anthropic) return this.anthropic;
      // Fall back to OpenRouter → Ollama
      if (this.openrouter) {
        const available = await this.openrouter.isAvailable();
        if (available) return this.openrouter;
      }
      if (this.ollama) {
        const available = await this.ollama.isAvailable();
        if (available) return this.ollama;
      }
      throw new Error('Cloud mode selected but no API key configured. Add an Anthropic or OpenRouter API key, or switch to local mode.');
    }

    // Local mode: prefer mlx (Apple Silicon) → llama-cpp (TurboQuant) → openai-compatible → Ollama → Anthropic
    if (this.modelSource === 'local') {
      if (this.mlx) {
        const available = await this.mlx.isAvailable();
        if (available) return this.mlx;
      }
      if (this.llamaCpp) {
        const available = await this.llamaCpp.isAvailable();
        if (available) return this.llamaCpp;
      }
      if (this.openaiCompatible) {
        const available = await this.openaiCompatible.isAvailable();
        if (available) return this.openaiCompatible;
      }
      if (this.ollama) {
        const available = await this.ollama.isAvailable();
        if (available) return this.ollama;
      }
      // Fall back to Anthropic
      if (this.anthropic) return this.anthropic;
      throw new Error('Local mode selected but neither llama-server nor Ollama is running. Start a local server or switch to cloud mode.');
    }

    // Auto mode: difficulty-aware routing
    // Simple tasks use quick model when configured
    if (difficulty === 'simple' && this.quickOllama) {
      const available = await this.quickOllama.isAvailable();
      if (available) return this.quickOllama;
    }

    // Complex tasks prefer Anthropic even for orchestrator tasks
    if (difficulty === 'complex' && this.anthropic) {
      return this.anthropic;
    }

    // Auto mode: route by task type (original behavior)
    const useLocal = this.preferLocal && (this.mlx || this.llamaCpp || this.openaiCompatible || this.ollama) && (
      taskType === 'orchestrator' || taskType === 'memory_extraction'
    );

    if (useLocal) {
      // Prefer mlx (Apple Silicon) → llama-cpp (TurboQuant) → openai-compatible → Ollama
      if (this.mlx) {
        const available = await this.mlx.isAvailable();
        if (available) return this.mlx;
      }
      if (this.llamaCpp) {
        const available = await this.llamaCpp.isAvailable();
        if (available) return this.llamaCpp;
      }
      if (this.openaiCompatible) {
        const available = await this.openaiCompatible.isAvailable();
        if (available) return this.openaiCompatible;
      }
      if (this.ollama) {
        const available = await this.ollama.isAvailable();
        if (available) return this.ollama;
      }
      // Fall back to cloud providers
    }

    // Try cloud providers (respects cloudProvider preference order)
    const cloudResult = await this.tryCloudProvider();
    if (cloudResult) return cloudResult;

    // Last resort: try OpenAI-compatible → Ollama even for non-preferred tasks (free tier)
    if (this.openaiCompatible) {
      const available = await this.openaiCompatible.isAvailable();
      if (available) return this.openaiCompatible;
    }
    if (this.ollama) {
      const available = await this.ollama.isAvailable();
      if (available) return this.ollama;
    }

    throw new Error('No model provider available. Make sure Ollama is running, or configure an Anthropic API key.');
  }

  // ============================================================================
  // BPP-AWARE MODEL SELECTION
  // ============================================================================

  /**
   * Select a model provider using biological/philosophical signals.
   * Wraps getProvider() with endocrine modulation, self-model confidence,
   * and predictive engine feedback to make routing decisions organic.
   */
  async selectModelWithContext(
    taskType: TaskType,
    context: {
      selfModelConfidence?: number;
      endocrineEffects?: Array<{ parameter: string; modifier: number }>;
      recentPredictionAccuracy?: number;
      routingHistory?: RoutingHistory;
      difficulty?: 'simple' | 'moderate' | 'complex';
    },
  ): Promise<ModelProvider> {
    let effectiveDifficulty = context.difficulty;

    // Endocrine modulation: cortisol (stress) → prefer more capable model
    if (context.endocrineEffects) {
      const ambitionEffect = context.endocrineEffects.find(e => e.parameter === 'ambition');
      if (ambitionEffect && ambitionEffect.modifier < 0.85) {
        // Cortisol is suppressing ambition → escalate to safer model
        if (!effectiveDifficulty || effectiveDifficulty === 'simple') effectiveDifficulty = 'moderate';
        else if (effectiveDifficulty === 'moderate') effectiveDifficulty = 'complex';
      }

      const confidenceEffect = context.endocrineEffects.find(e => e.parameter === 'prediction_confidence');
      if (confidenceEffect && confidenceEffect.modifier > 1.1 && effectiveDifficulty === 'complex') {
        // High dopamine confidence → allow downgrade
        effectiveDifficulty = 'moderate';
      }
    }

    // Self-model: low confidence → escalate to more capable model
    if (context.selfModelConfidence !== undefined && context.selfModelConfidence < 0.3) {
      effectiveDifficulty = 'complex';
    }

    // Prediction accuracy: if recent predictions are consistently wrong, escalate
    if (context.recentPredictionAccuracy !== undefined && context.recentPredictionAccuracy < 0.3) {
      effectiveDifficulty = 'complex';
    }

    return this.getProvider(taskType, effectiveDifficulty, undefined, context.routingHistory);
  }

  /** Get the Anthropic provider directly (for tool-using tasks that need the SDK) */
  getAnthropicProvider(): AnthropicProvider | null {
    return this.anthropic;
  }

  /** Get the Ollama provider directly (for status checks) */
  getOllamaProvider(): OllamaProvider | null {
    return this.ollama;
  }

  /** Get the OCR Ollama provider directly (for status checks) */
  getOcrProvider(): OllamaProvider | null {
    return this.ocrOllama;
  }

  /** Check if Ollama is connected */
  async isOllamaAvailable(): Promise<boolean> {
    if (!this.ollama) return false;
    return this.ollama.isAvailable();
  }

  /** Check if any model provider is available (Anthropic, OpenRouter, Ollama, etc.) */
  async isAnyProviderAvailable(): Promise<boolean> {
    if (this.anthropic) return true;
    if (this.openrouter) return true;
    if (this.claudeCode) {
      const available = await this.claudeCode.isAvailable();
      if (available) return true;
    }
    if (this.openaiCompatible) {
      const available = await this.openaiCompatible.isAvailable();
      if (available) return true;
    }
    if (this.ollama) {
      const available = await this.ollama.isAvailable();
      if (available) return true;
    }
    if (this.llamaCpp) {
      const available = await this.llamaCpp.isAvailable();
      if (available) return true;
    }
    if (this.mlx) {
      const available = await this.mlx.isAvailable();
      if (available) return true;
    }
    return false;
  }

  /** Reset Ollama availability cache (for reconnection attempts) */
  resetOllamaStatus(): void {
    this.ollama?.resetAvailability();
  }

  /** Update the active Ollama model at runtime (called when user changes active model). */
  setOllamaModel(model: string): void {
    this.ollama?.setDefaultModel(model);
    this.ollama?.resetAvailability();  // Force re-probe with new model
  }

  /** Update the model source at runtime (called when user switches cloud/local). */
  setModelSource(source: ModelSourceOption): void {
    this.modelSource = source;
    // Lazily create Claude Code provider when switching to it
    if (source === 'claude-code' && !this.claudeCode) {
      this.claudeCode = new ClaudeCodeProvider();
    }
  }

  /** Update which cloud provider to use when modelSource === 'cloud'. */
  setCloudProvider(provider: 'anthropic' | 'openrouter'): void {
    this.cloudProvider = provider;
    // Lazily create OpenRouter provider if key is available
    if (provider === 'openrouter' && !this.openrouter && this._openRouterApiKey) {
      this.openrouter = new OpenRouterProvider(this._openRouterApiKey);
    }
  }

  /** Get the current cloud provider. */
  getCloudProvider(): 'anthropic' | 'openrouter' {
    return this.cloudProvider;
  }

  /** Get the OpenRouter provider directly (for status checks). */
  getOpenRouterProvider(): OpenRouterProvider | null {
    return this.openrouter;
  }

  /** Get the OpenRouter API key (for media generation bridges). */
  getOpenRouterApiKey(): string {
    return this._openRouterApiKey;
  }

  /** Update the OpenRouter API key at runtime (called when user changes key in settings). */
  setOpenRouterApiKey(key: string): void {
    this._openRouterApiKey = key;
    if (key) {
      if (this.openrouter) {
        this.openrouter.setApiKey(key);
      } else {
        this.openrouter = new OpenRouterProvider(key);
      }
    } else {
      this.openrouter = null;
    }
  }

  /** Update the OpenRouter model at runtime. */
  setOpenRouterModel(model: string): void {
    this.openrouter?.setDefaultModel(model);
  }

  /** Update cached credit balance (called from heartbeat responses). */
  setCreditBalance(percent: number): void {
    this._creditBalancePercent = Math.max(0, Math.min(100, percent));
  }

  /** Get the current cached credit balance percentage. */
  getCreditBalance(): number {
    return this._creditBalancePercent;
  }

  /**
   * Returns the effective context limit (in tokens) for the active provider.
   * For Anthropic: uses CLAUDE_CONTEXT_LIMITS. For Ollama: delegates to getWorkingNumCtx().
   * Callers get a single, provider-agnostic way to know how much context is available.
   */
  async getContextLimit(taskType: TaskType, maxOllamaCtx?: number): Promise<number> {
    let provider: ModelProvider;
    try {
      provider = await this.getProvider(taskType);
    } catch {
      return CLAUDE_CONTEXT_LIMITS['claude-sonnet-4-5']; // safe default
    }

    if (provider.name === 'anthropic') {
      return CLAUDE_CONTEXT_LIMITS['claude-sonnet-4-5'];
    }

    if (provider.name === 'ollama' && this.ollama) {
      // Use the Ollama model's working context, with optional cap override
      return getWorkingNumCtx(this.ollama.getDefaultModel(), maxOllamaCtx);
    }

    // OpenRouter or unknown provider: assume large context
    return CLAUDE_CONTEXT_LIMITS['claude-sonnet-4-5'];
  }
}
