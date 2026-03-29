/**
 * Batch tool executor — runs independent tool calls in parallel.
 * Separates state-mutating tools (browser activation) and permission-requiring
 * tools (filesystem) from the parallel batch for correctness.
 *
 * MCP tool annotations are used for smarter parallelization:
 * - readOnlyHint: true → always safe to parallelize
 * - destructiveHint: true → run sequentially
 */

import type { OrchestratorEvent } from './orchestrator-types.js';
import { executeToolCall, type ToolCallRequest, type ToolCallOutcome, type ToolExecutionContext } from './tool-executor.js';
import type { McpToolAnnotations } from '../mcp/types.js';

interface BatchResult {
  outcome: ToolCallOutcome;
  events: OrchestratorEvent[];
}

/** Set of filesystem tools that may trigger waitForPermission(). */
const FILESYSTEM_TOOLS = new Set([
  'local_list_directory',
  'local_read_file',
  'local_search_files',
  'local_search_content',
  'local_write_file',
  'local_edit_file',
]);

/**
 * Drain an async generator, collecting all yielded events and the final return value.
 */
async function drainGenerator(
  gen: AsyncGenerator<OrchestratorEvent, ToolCallOutcome>,
): Promise<BatchResult> {
  const events: OrchestratorEvent[] = [];
  let outcome: ToolCallOutcome;

  for (;;) {
    const { value, done } = await gen.next();
    if (done) {
      outcome = value;
      break;
    }
    events.push(value);
  }

  return { outcome, events };
}

/**
 * Execute a single tool call sequentially, yielding events as they arrive.
 */
async function* executeSingle(
  request: ToolCallRequest,
  ctx: ToolExecutionContext,
): AsyncGenerator<OrchestratorEvent, ToolCallOutcome> {
  const gen = executeToolCall(request, ctx);
  let outcome: ToolCallOutcome;
  for (;;) {
    const { value, done } = await gen.next();
    if (done) { outcome = value; break; }
    yield value;
  }
  return outcome;
}

/**
 * Check if an MCP tool should be forced sequential based on its annotations.
 */
function isDestructiveMcpTool(
  name: string,
  mcpAnnotations?: Map<string, McpToolAnnotations>,
): boolean {
  if (!mcpAnnotations) return false;
  const annotations = mcpAnnotations.get(name);
  return annotations?.destructiveHint === true;
}

/**
 * Execute multiple tool calls in parallel using Promise.allSettled.
 * Returns outcomes and yields all events in order (tool_start events first, then results).
 *
 * Special handling:
 * - `request_browser` runs first (sequentially) since it mutates shared browser state.
 * - Filesystem tools (`local_*`) run sequentially at the end since they may block
 *   on permission prompts, which would freeze event output for other completed tools.
 * - MCP tools with `destructiveHint: true` run sequentially after parallel tools.
 * - Remaining tools run in parallel.
 *
 * @param mcpAnnotations Optional map of namespaced MCP tool names to their annotations
 */
export async function* executeToolCallsBatch(
  requests: ToolCallRequest[],
  ctx: ToolExecutionContext,
  mcpAnnotations?: Map<string, McpToolAnnotations>,
): AsyncGenerator<OrchestratorEvent, ToolCallOutcome[]> {
  if (requests.length === 0) return [];
  if (requests.length === 1) {
    const outcome = yield* executeSingle(requests[0], ctx);
    return [outcome];
  }

  // Split requests into four groups:
  // 1. Browser activation (must run first, mutates state)
  // 2. MCP tools with destructiveHint (run sequentially)
  // 3. Filesystem tools (run sequentially at end, may block on permissions)
  // 4. Everything else (run in parallel)
  const browserActivation = requests.filter(r => r.name === 'request_browser');
  const destructiveMcp = requests.filter(r =>
    r.name !== 'request_browser' &&
    !FILESYSTEM_TOOLS.has(r.name) &&
    isDestructiveMcpTool(r.name, mcpAnnotations),
  );
  const filesystemTools = requests.filter(r => FILESYSTEM_TOOLS.has(r.name));
  const parallel = requests.filter(r =>
    r.name !== 'request_browser' &&
    !FILESYSTEM_TOOLS.has(r.name) &&
    !isDestructiveMcpTool(r.name, mcpAnnotations),
  );

  // Map from request to its outcome (preserves original order)
  const outcomeMap = new Map<ToolCallRequest, ToolCallOutcome>();

  // Phase 1: Execute browser activation sequentially first
  for (const req of browserActivation) {
    const outcome = yield* executeSingle(req, ctx);
    outcomeMap.set(req, outcome);
  }

  // Phase 2: Execute remaining non-filesystem, non-destructive tools in parallel
  if (parallel.length === 1) {
    const outcome = yield* executeSingle(parallel[0], ctx);
    outcomeMap.set(parallel[0], outcome);
  } else if (parallel.length > 1) {
    const generators = parallel.map(req => executeToolCall(req, ctx));
    const settledResults = await Promise.allSettled(generators.map(drainGenerator));

    for (let i = 0; i < settledResults.length; i++) {
      const settled = settledResults[i];
      if (settled.status === 'fulfilled') {
        for (const event of settled.value.events) {
          yield event;
        }
        outcomeMap.set(parallel[i], settled.value.outcome);
      } else {
        const errorOutcome: ToolCallOutcome = {
          toolName: parallel[i].name,
          result: { success: false, error: settled.reason?.message || 'Parallel execution failed' },
          resultContent: `Error: ${settled.reason?.message || 'Parallel execution failed'}`,
          isError: true,
        };
        yield { type: 'tool_done', name: parallel[i].name, result: errorOutcome.result };
        outcomeMap.set(parallel[i], errorOutcome);
      }
    }
  }

  // Phase 3: Execute destructive MCP tools sequentially
  for (const req of destructiveMcp) {
    const outcome = yield* executeSingle(req, ctx);
    outcomeMap.set(req, outcome);
  }

  // Phase 4: Execute filesystem tools sequentially (permission prompts don't block others)
  for (const req of filesystemTools) {
    const outcome = yield* executeSingle(req, ctx);
    outcomeMap.set(req, outcome);
  }

  // Return outcomes in original request order
  return requests.map(req => outcomeMap.get(req)!);
}
