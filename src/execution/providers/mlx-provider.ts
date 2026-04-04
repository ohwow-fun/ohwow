/**
 * MLXProvider — OpenAI-compatible provider for mlx-vlm server
 *
 * Speaks the same /v1/chat/completions API as Ollama and llama-server.
 * mlx-vlm natively supports vision (images), audio, and text on Apple Silicon
 * via the MLX framework. Context size is set at server launch, not per-request.
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

export class MLXProvider implements ModelProvider {
  readonly name = 'mlx';
  private baseUrl: string;
  private defaultModel: string;
  private _available: boolean | null = null;
  private _availableCheckedAt = 0;
  private _responseCallback: ((model: string, inputTokens: number, outputTokens: number, durationMs: number) => void) | null = null;

  constructor(baseUrl: string, defaultModel: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.defaultModel = defaultModel;
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
        headers: { 'Content-Type': 'application/json' },
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
      provider: 'mlx',
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
      provider: 'mlx',
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
        headers: { 'Content-Type': 'application/json' },
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
      provider: 'mlx',
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
      provider: 'mlx',
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
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const ok = response.ok;
      this._available = ok;
      this._availableCheckedAt = Date.now();
      return ok;
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
      throw new Error(`Model too large for available memory. Try a smaller model or reduce context size. mlx-vlm: ${text.slice(0, 200)}`);
    }
    if (response.status === 404 || lower.includes('not found')) {
      throw new Error(`Model not found by mlx-vlm server. Check the HuggingFace model ID. mlx-vlm: ${text.slice(0, 200)}`);
    }
    throw new Error(`mlx-vlm server request failed (${response.status}): ${text}`);
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
