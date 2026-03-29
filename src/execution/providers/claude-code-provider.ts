/**
 * Claude Code Provider
 * Routes LLM calls through the MCP sampling bridge to Claude Code.
 * No API key needed — uses the Claude instance powering the user's Claude Code session.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type {
  ModelProvider,
  ModelResponse,
  ModelResponseWithTools,
  CreateMessageParams,
  OpenAITool,
  OpenAIToolCall,
} from '../model-router.js';

const PORT_FILE = join(homedir(), '.ohwow', 'data', 'mcp-sampling.port');

export class ClaudeCodeProvider implements ModelProvider {
  readonly name = 'claude-code';
  private cachedPort: number | null = null;
  private lastPortCheck = 0;

  private getPort(): number | null {
    // Cache port for 5 seconds to avoid repeated file reads
    const now = Date.now();
    if (this.cachedPort && now - this.lastPortCheck < 5_000) {
      return this.cachedPort;
    }
    this.lastPortCheck = now;

    try {
      if (!existsSync(PORT_FILE)) {
        this.cachedPort = null;
        return null;
      }
      const port = parseInt(readFileSync(PORT_FILE, 'utf-8').trim(), 10);
      this.cachedPort = isNaN(port) ? null : port;
      return this.cachedPort;
    } catch {
      this.cachedPort = null;
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    const port = this.getPort();
    if (!port) return false;

    try {
      // Quick health check — POST with empty messages should return 400 (not connection refused)
      const res = await fetch(`http://127.0.0.1:${port}/sampling`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
        signal: AbortSignal.timeout(2_000),
      });
      // 400 means the bridge is running (it rejected empty messages)
      return res.status === 400 || res.status === 200;
    } catch {
      this.cachedPort = null;
      return false;
    }
  }

  async createMessage(params: CreateMessageParams): Promise<ModelResponse> {
    const port = this.getPort();
    if (!port) {
      throw new Error('Claude Code sampling bridge is not running. Make sure Claude Code is open with the ohwow MCP server connected.');
    }

    // Convert ModelMessage[] to the sampling bridge format
    const messages = params.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string'
          ? m.content
          : m.content.map((p) => ('text' in p ? p.text : '[image]')).join('\n'),
      }));

    // System messages get prepended to systemPrompt
    const systemParts: string[] = [];
    if (params.system) systemParts.push(params.system);
    for (const m of params.messages) {
      if (m.role === 'system' && typeof m.content === 'string') {
        systemParts.push(m.content);
      }
    }

    const body = {
      messages,
      systemPrompt: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
      maxTokens: params.maxTokens || 4096,
      temperature: params.temperature,
    };

    const res = await fetch(`http://127.0.0.1:${port}/sampling`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
      throw new Error(`Claude Code sampling failed: ${error.error || `HTTP ${res.status}`}`);
    }

    const data = await res.json() as { content: string; model: string };

    return {
      content: data.content,
      model: data.model || 'claude-code',
      provider: 'anthropic', // Reports as anthropic for compatibility with token tracking
      inputTokens: 0, // Token counts not available through sampling
      outputTokens: 0,
    };
  }

  async createMessageWithTools(params: CreateMessageParams & { tools: OpenAITool[] }): Promise<ModelResponseWithTools> {
    // For tool calling, we route through createMessage with tool instructions in the system prompt.
    // MCP sampling supports tools natively, but the bridge currently handles text-only.
    // For the initial implementation, we inject tool definitions into the prompt and parse structured output.
    const toolDescriptions = params.tools.map((t) => {
      const p = t.function.parameters;
      const propsStr = p && typeof p === 'object' && 'properties' in p
        ? Object.entries(p.properties as Record<string, { type?: string; description?: string }>)
            .map(([name, prop]) => `  - ${name} (${prop.type || 'any'}): ${prop.description || ''}`)
            .join('\n')
        : '  (no parameters)';
      return `### ${t.function.name}\n${t.function.description}\nParameters:\n${propsStr}`;
    }).join('\n\n');

    const toolSystemPrompt = `You have access to the following tools. To use a tool, respond with a JSON block:
\`\`\`tool_call
{"name": "tool_name", "arguments": {"param": "value"}}
\`\`\`

Available tools:\n\n${toolDescriptions}

If you want to call a tool, output exactly one tool_call block. If you want to respond with text only, do not include any tool_call blocks.`;

    const augmentedSystem = params.system
      ? `${params.system}\n\n${toolSystemPrompt}`
      : toolSystemPrompt;

    const response = await this.createMessage({
      ...params,
      system: augmentedSystem,
    });

    // Parse tool calls from response
    const toolCalls: OpenAIToolCall[] = [];
    const toolCallRegex = /```tool_call\s*\n([\s\S]*?)\n```/g;
    let match: RegExpExecArray | null;
    let textContent = response.content;

    while ((match = toolCallRegex.exec(response.content)) !== null) {
      try {
        const parsed = JSON.parse(match[1]) as { name: string; arguments: Record<string, unknown> };
        toolCalls.push({
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: JSON.stringify(parsed.arguments || {}),
          },
        });
        // Remove the tool call block from text content
        textContent = textContent.replace(match[0], '').trim();
      } catch {
        // Not valid JSON, skip
      }
    }

    return {
      ...response,
      content: textContent,
      toolCalls,
    };
  }
}
