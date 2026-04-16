/**
 * Tool Dispatch — barrel exports + default registry factory
 */

export type { ToolExecutor, ToolExecutionContext, ToolCallResult } from './types.js';
export { ToolExecutorRegistry } from './registry.js';

import { ToolExecutorRegistry } from './registry.js';
import { requestDesktopExecutor } from './request-desktop-executor.js';
import { desktopExecutor } from './desktop-executor.js';
import { requestBrowserExecutor } from './request-browser-executor.js';
import { browserExecutor } from './browser-executor.js';
import { scraplingExecutor } from './scrapling-executor.js';
import { draftExecutor } from './draft-executor.js';
import { filesystemExecutor } from './filesystem-executor.js';
import { bashExecutor } from './bash-executor.js';
import { hostReachExecutor } from './host-executor.js';
import { logTailExecutor } from './log-tail-executor.js';
import { mcpExecutor } from './mcp-executor.js';
import { stateExecutor } from './state-executor.js';
import { docMountExecutor } from '../doc-mounts/doc-mount-executor.js';
import { llmExecutor } from './llm-executor.js';
import { xPostingExecutor } from './x-posting-executor.js';

/** Create a registry with all default tool executors */
export function createDefaultToolRegistry(): ToolExecutorRegistry {
  const registry = new ToolExecutorRegistry();
  // Order matters: request_* must be checked before full tool executors
  registry.register(llmExecutor);
  registry.register(requestDesktopExecutor);
  registry.register(desktopExecutor);
  registry.register(requestBrowserExecutor);
  registry.register(browserExecutor);
  // X posting executor — must come AFTER browserExecutor because
  // browserExecutor's `isBrowserTool` doesn't match x_* names, but
  // registering earlier is safe and makes the routing visible next
  // to the other browser-surface dispatchers.
  registry.register(xPostingExecutor);
  registry.register(scraplingExecutor);
  registry.register(docMountExecutor);
  registry.register(filesystemExecutor);
  registry.register(bashExecutor);
  registry.register(hostReachExecutor);
  registry.register(logTailExecutor);
  registry.register(draftExecutor);
  registry.register(stateExecutor);
  registry.register(mcpExecutor);
  return registry;
}
