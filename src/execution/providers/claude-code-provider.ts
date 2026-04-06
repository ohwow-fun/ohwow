/**
 * Claude Code Provider
 * Routes LLM calls through the `claude` CLI binary.
 * No API key needed — uses the Claude subscription powering the user's Claude Code session.
 *
 * This is a lightweight single-turn provider (--max-turns 1).
 * For full agentic task delegation, see ../adapters/claude-code-adapter.ts.
 */

import { spawn } from 'child_process';
import { logger } from '../../lib/logger.js';
import {
  detectClaudeCode,
  getCachedClaudeCodeStatus,
} from '../adapters/claude-code-detection.js';
import type {
  ModelProvider,
  ModelResponse,
  ModelResponseWithTools,
  CreateMessageParams,
  OpenAITool,
  OpenAIToolCall,
} from '../model-router.js';

const DEFAULT_TIMEOUT = 120_000; // 2 min, matching other providers

export class ClaudeCodeProvider implements ModelProvider {
  readonly name = 'claude-code';
  private binaryPath: string | undefined;
  private defaultModel: string | undefined;
  private _detectionPromise: Promise<void> | null = null;

  constructor(binaryPath?: string, model?: string) {
    this.binaryPath = binaryPath || undefined;
    this.defaultModel = model || undefined;
  }

  async isAvailable(): Promise<boolean> {
    // Fast path: use cached detection
    const cached = getCachedClaudeCodeStatus();
    if (cached) return cached.available;

    // Slow path: run detection (once, coalesced)
    if (!this._detectionPromise) {
      this._detectionPromise = detectClaudeCode(this.binaryPath).then(() => {
        this._detectionPromise = null;
      });
    }
    await this._detectionPromise;

    const status = getCachedClaudeCodeStatus();
    return status?.available ?? false;
  }

  async createMessage(params: CreateMessageParams): Promise<ModelResponse> {
    const prompt = this.buildPrompt(params);
    const result = await this.runClaude(prompt, params.model);

    return {
      content: result.content,
      model: result.model,
      provider: 'claude-code',
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }

  async createMessageWithTools(params: CreateMessageParams & { tools: OpenAITool[] }): Promise<ModelResponseWithTools> {
    const toolSystemPrompt = this.buildToolSystemPrompt(params.tools);
    const augmentedSystem = params.system
      ? `${params.system}\n\n${toolSystemPrompt}`
      : toolSystemPrompt;

    const prompt = this.buildPrompt({ ...params, system: augmentedSystem });
    const result = await this.runClaude(prompt, params.model);

    // Parse tool calls from response
    const toolCalls: OpenAIToolCall[] = [];
    const toolCallRegex = /```tool_call\s*\n([\s\S]*?)\n```/g;
    let match: RegExpExecArray | null;
    let textContent = result.content;

    while ((match = toolCallRegex.exec(result.content)) !== null) {
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
        textContent = textContent.replace(match[0], '').trim();
      } catch {
        // Not valid JSON, skip
      }
    }

    return {
      content: textContent,
      model: result.model,
      provider: 'claude-code',
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      toolCalls,
    };
  }

  // ---------- Internals ----------

  /**
   * Serialize CreateMessageParams into a single text prompt for `claude --print`.
   */
  private buildPrompt(params: CreateMessageParams): string {
    const parts: string[] = [];

    if (params.system) {
      parts.push(`<system>\n${params.system}\n</system>`);
    }

    const conversationMsgs = params.messages.filter((m) => m.role !== 'system');

    // Collect system-role messages and prepend them
    for (const m of params.messages) {
      if (m.role === 'system') {
        const text = typeof m.content === 'string'
          ? m.content
          : m.content.map((p) => ('text' in p ? p.text : '[image]')).join('\n');
        parts.push(`<system>\n${text}\n</system>`);
      }
    }

    if (conversationMsgs.length > 0) {
      const formatted = conversationMsgs.map((m) => {
        const role = m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool Result' : 'User';
        const text = typeof m.content === 'string'
          ? m.content
          : m.content.map((p) => ('text' in p ? p.text : '[image]')).join('\n');
        return `${role}: ${text}`;
      }).join('\n\n');

      parts.push(formatted);
    }

    return parts.join('\n\n');
  }

  /**
   * Build the tool-calling system prompt injection.
   */
  private buildToolSystemPrompt(tools: OpenAITool[]): string {
    const toolDescriptions = tools.map((t) => {
      const p = t.function.parameters;
      const propsStr = p && typeof p === 'object' && 'properties' in p
        ? Object.entries(p.properties as Record<string, { type?: string; description?: string }>)
            .map(([name, prop]) => `  - ${name} (${prop.type || 'any'}): ${prop.description || ''}`)
            .join('\n')
        : '  (no parameters)';
      return `### ${t.function.name}\n${t.function.description}\nParameters:\n${propsStr}`;
    }).join('\n\n');

    return `You have access to the following tools. To use a tool, respond with a JSON block:
\`\`\`tool_call
{"name": "tool_name", "arguments": {"param": "value"}}
\`\`\`

Available tools:\n\n${toolDescriptions}

If you want to call a tool, output exactly one tool_call block. If you want to respond with text only, do not include any tool_call blocks.`;
  }

  /**
   * Resolve the claude binary path from config or cached detection.
   */
  private resolveBinary(): string {
    if (this.binaryPath) return this.binaryPath;
    const cached = getCachedClaudeCodeStatus();
    if (cached?.binaryPath) return cached.binaryPath;
    return 'claude';
  }

  /**
   * Spawn `claude --print` and collect the result.
   * Uses --output-format json for clean parsing of single-turn responses.
   */
  private runClaude(prompt: string, model?: string): Promise<{
    content: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }> {
    return new Promise((resolve, reject) => {
      const binary = this.resolveBinary();
      const args = [
        '--print',
        '--output-format', 'json',
        '--max-turns', '1',
        '--dangerously-skip-permissions',
      ];

      const effectiveModel = model || this.defaultModel;
      if (effectiveModel) {
        args.push('--model', effectiveModel);
      }

      logger.debug(
        { binary, model: effectiveModel },
        '[claude-code-provider] Spawning single-turn completion',
      );

      const child = spawn(binary, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk.toString());
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk.toString());
      });

      // Timeout
      const timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 5_000);
        reject(new Error(`Claude Code CLI timed out after ${DEFAULT_TIMEOUT}ms`));
      }, DEFAULT_TIMEOUT);

      child.on('error', (err) => {
        clearTimeout(timeoutId);
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timeoutId);
        const stdout = stdoutChunks.join('');
        const stderr = stderrChunks.join('');

        if (!stdout && code !== 0) {
          reject(new Error(`Claude Code CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
          return;
        }

        try {
          // --output-format json returns a JSON object with the result
          const data = JSON.parse(stdout) as {
            result?: string;
            cost_usd?: number;
            total_cost_usd?: number;
            session_id?: string;
            model?: string;
            input_tokens?: number;
            output_tokens?: number;
            num_turns?: number;
            // Some versions return content directly
            content?: string;
          };

          const content = data.result || data.content || '';
          const resultModel = data.model || effectiveModel || 'claude-code';

          resolve({
            content,
            model: resultModel,
            inputTokens: data.input_tokens || 0,
            outputTokens: data.output_tokens || 0,
          });
        } catch {
          // If JSON parse fails, treat raw stdout as the content
          // (claude --print without --output-format returns plain text)
          resolve({
            content: stdout.trim(),
            model: effectiveModel || 'claude-code',
            inputTokens: 0,
            outputTokens: 0,
          });
        }
      });

      // Pipe prompt via stdin
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
