/**
 * OpenAICompatibleProvider — Generic provider for any server exposing /v1/chat/completions.
 *
 * Works with vLLM, Together, Groq, or any OpenAI-compatible endpoint.
 * Differences from LlamaCppProvider:
 * 1. Health check uses GET /v1/models (not /health)
 * 2. Supports optional API key via Authorization: Bearer header
 * 3. No options.num_ctx in request body
 */

import type {
  ModelProvider,
  ModelResponse,
  ModelResponseWithTools,
  CreateMessageParams,
  OpenAITool,
  OpenAIToolCall,
  MessageContentPart,
} from '../model-router.js';

const AVAILABILITY_TTL_OK_MS = 30_000;
const AVAILABILITY_TTL_FAIL_MS = 5_000;

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'openai-compatible';
  private baseUrl: string;
  private defaultModel: string;
  private apiKey: string | undefined;
  private _available: boolean | null = null;
  private _availableCheckedAt = 0;
  private _responseCallback: ((model: string, inputTokens: number, outputTokens: number, durationMs: number) => void) | null = null;

  constructor(baseUrl: string, defaultModel: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.defaultModel = defaultModel;
    this.apiKey = apiKey;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  setResponseCallback(cb: (model: string, inputTokens: number, outputTokens: number, durationMs: number) => void): void {
    this._responseCallback = cb;
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
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
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
      await this.throwServerError(response);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const content = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };
    const durationMs = Date.now() - startTime;

    if (this._responseCallback) {
      try { this._responseCallback(model, usage.prompt_tokens, usage.completion_tokens, durationMs); } catch { /* */ }
    }

    return {
      content,
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      model,
      provider: 'openai-compatible',
    };
  }

  async createMessageWithTools(params: CreateMessageParams & {
    tools: OpenAITool[];
  }): Promise<ModelResponseWithTools> {
    const model = params.model || this.defaultModel;

    type Msg = {
      role: string;
      content: string | MessageContentPart[];
      tool_call_id?: string;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
    const messages: Msg[] = [];
    if (params.system) {
      messages.push({ role: 'system', content: params.system });
    }
    for (const m of params.messages) {
      const msg: Msg = { role: m.role, content: m.content };
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      messages.push(msg);
    }

    const startTime = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
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
      await this.throwServerError(response);
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
    const durationMs = Date.now() - startTime;

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
      provider: 'openai-compatible',
      toolCalls,
    };
  }

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
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model,
          messages,
          max_tokens: params.maxTokens || 4096,
          temperature: params.temperature ?? 0.5,
          stream: true,
        }),
      });
    } catch (err) {
      this._available = null;
      this._availableCheckedAt = 0;
      throw err;
    }

    if (!response.ok) {
      await this.throwServerError(response);
    }

    let fullContent = '';
    let usage = { prompt_tokens: 0, completion_tokens: 0 };

    for await (const chunk of this.parseStream(response)) {
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
      provider: 'openai-compatible',
    };
  }

  async *createMessageWithToolsStreaming(params: CreateMessageParams & {
    tools: OpenAITool[];
  }): AsyncGenerator<{ type: 'token'; content: string }, ModelResponseWithTools> {
    const model = params.model || this.defaultModel;

    type Msg = {
      role: string;
      content: string | MessageContentPart[];
      tool_call_id?: string;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
    const messages: Msg[] = [];
    if (params.system) {
      messages.push({ role: 'system', content: params.system });
    }
    for (const m of params.messages) {
      const msg: Msg = { role: m.role, content: m.content };
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      messages.push(msg);
    }

    const startTime = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
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
      await this.throwServerError(response);
    }

    let fullContent = '';
    let usage = { prompt_tokens: 0, completion_tokens: 0 };
    const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();
    let hasToolCalls = false;

    for await (const chunk of this.parseStream(response)) {
      if (chunk.content && !hasToolCalls) {
        fullContent += chunk.content;
        yield { type: 'token', content: chunk.content };
      } else if (chunk.content) {
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
      provider: 'openai-compatible',
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
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers,
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

  private async throwServerError(response: Response): Promise<never> {
    const text = await response.text();
    const lower = text.toLowerCase();
    if (lower.includes('out of memory') || lower.includes('oom') || lower.includes('not enough memory')) {
      throw new Error(`Model too large for available memory. Try a smaller model. Server: ${text.slice(0, 200)}`);
    }
    if (response.status === 404 || lower.includes('not found')) {
      throw new Error(`Model not found. Check your model configuration. Server: ${text.slice(0, 200)}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Authentication failed. Check your API key. Server: ${text.slice(0, 200)}`);
    }
    throw new Error(`OpenAI-compatible server request failed (${response.status}): ${text}`);
  }

  private async *parseStream(response: Response): AsyncGenerator<{
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

  setDefaultModel(model: string): void {
    this.defaultModel = model;
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  resetAvailability(): void {
    this._available = null;
    this._availableCheckedAt = 0;
  }
}
