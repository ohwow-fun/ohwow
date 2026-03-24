/**
 * Tool Executor Registry
 *
 * Manages a collection of tool executors. Replaces the duplicated
 * if/else chains in both Anthropic and Ollama paths of engine.ts.
 */

import type { ToolExecutor, ToolExecutionContext, ToolCallResult } from './types.js';

export class ToolExecutorRegistry {
  private executors: ToolExecutor[] = [];

  register(executor: ToolExecutor): void {
    this.executors.push(executor);
  }

  /** Find the first executor that can handle this tool */
  findExecutor(toolName: string): ToolExecutor | undefined {
    return this.executors.find(e => e.canHandle(toolName));
  }

  /** Execute a tool, delegating to the appropriate executor */
  async execute(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    const executor = this.findExecutor(toolName);
    if (!executor) {
      return {
        content: `Error: Unknown tool: ${toolName}`,
        is_error: true,
      };
    }
    return executor.execute(toolName, input, ctx);
  }
}
