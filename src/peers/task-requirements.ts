/**
 * Task Requirements Extraction
 * Analyzes agent config and task description to determine what a task needs,
 * enabling capability-aware routing to the best peer.
 */

import { scoreDifficulty, type DifficultyLevel } from '../execution/difficulty-scorer.js';

export interface TaskRequirements {
  needsBrowser: boolean;
  needsLocalFiles: boolean;
  difficulty: DifficultyLevel;
  estimatedVramGB: number;
}

/**
 * Extract execution requirements from an agent config and task description.
 * Agents never pin a model — the peer routing layer therefore reasons only
 * about capabilities (browser, files, difficulty) rather than model size.
 */
export function extractRequirements(
  agentConfig: Record<string, unknown>,
  taskDescription: string | null,
): TaskRequirements {
  const tools = Array.isArray(agentConfig.tools) ? agentConfig.tools as string[] : [];
  const needsBrowser = !!(agentConfig.browser_enabled) || tools.some(t => t.startsWith('browser_'));
  const needsLocalFiles = !!(agentConfig.local_files_enabled) || tools.some(t =>
    t === 'read_file' || t === 'write_file' || t === 'list_directory' || t.startsWith('filesystem_')
  );

  const difficulty = scoreDifficulty({
    taskDescription,
    toolCount: tools.length,
    hasIntegrations: tools.some(t => t.startsWith('whatsapp_') || t.startsWith('telegram_') || t.startsWith('email_')),
    hasBrowserTools: needsBrowser,
  });

  // Rough VRAM envelope for a ~4B local model — tuned to the default
  // Ollama footprint. Peer routing uses this as a lower-bound hint.
  const estimatedVramGB = 4;

  return {
    needsBrowser,
    needsLocalFiles,
    difficulty,
    estimatedVramGB,
  };
}
