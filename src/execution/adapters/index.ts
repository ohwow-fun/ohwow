/**
 * Claude Code CLI Adapters
 * Full-delegation execution backend that spawns `claude` CLI for agent tasks.
 */

export { executeWithClaudeCodeCli } from './claude-code-adapter.js';
export type { ClaudeCodeExecConfig, ClaudeCodeExecResult } from './claude-code-adapter.js';

export { ClaudeCodeStreamParser } from './claude-code-parser.js';
export type { ClaudeCodeStreamEvent, ParsedClaudeCodeResult, ProgressInfo } from './claude-code-parser.js';

export { buildSkillsDir } from './claude-code-skills.js';
export type { SkillsContext, SkillsDir } from './claude-code-skills.js';

export { createSessionStore } from './claude-code-sessions.js';
export type { ClaudeCodeSessionStore } from './claude-code-sessions.js';

export {
  detectClaudeCode,
  isClaudeCodeCliAvailable,
  getCachedClaudeCodeStatus,
  resetClaudeCodeCache,
} from './claude-code-detection.js';
export type { ClaudeCodeStatus } from './claude-code-detection.js';
