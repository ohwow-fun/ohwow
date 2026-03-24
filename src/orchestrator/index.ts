/**
 * Orchestrator barrel export
 */

export { LocalOrchestrator } from './local-orchestrator.js';
export { type OrchestratorEvent, type ChannelChatOptions, type ClassifiedIntent } from './orchestrator-types.js';
export { classifyIntent } from './intent-classifier.js';
export { ORCHESTRATOR_TOOL_DEFINITIONS } from './tool-definitions.js';
export { toolRegistry } from './tools/registry.js';
export { buildLocalSystemPrompt, type BuildLocalSystemPromptArgs } from './system-prompt.js';
export type { LocalToolContext, ToolResult, ToolHandler } from './local-tool-types.js';
