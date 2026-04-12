/**
 * Task Requirements Extraction
 * Analyzes agent config and task description to determine what a task needs,
 * enabling capability-aware routing to the best peer.
 */

import { scoreDifficulty, type DifficultyLevel } from '../execution/difficulty-scorer.js';
import { getAgentDefaultModel } from '../execution/execution-policy.js';
import { MODEL_CATALOG } from '../lib/ollama-models.js';

export interface TaskRequirements {
  needsBrowser: boolean;
  needsLocalFiles: boolean;
  preferredModel: string | null;
  difficulty: DifficultyLevel;
  estimatedVramGB: number;
}

/**
 * Extract execution requirements from an agent config and task description.
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

  const preferredModel = getAgentDefaultModel(agentConfig) ?? null;

  const difficulty = scoreDifficulty({
    taskDescription,
    toolCount: tools.length,
    hasIntegrations: tools.some(t => t.startsWith('whatsapp_') || t.startsWith('telegram_') || t.startsWith('email_')),
    hasBrowserTools: needsBrowser,
  });

  // Estimate VRAM from preferred model or default
  let estimatedVramGB = 4; // default for a ~4b model
  if (preferredModel) {
    const catalogEntry = MODEL_CATALOG.find(m => m.tag === preferredModel);
    if (catalogEntry) {
      estimatedVramGB = catalogEntry.sizeGB;
    }
  }

  return {
    needsBrowser,
    needsLocalFiles,
    preferredModel,
    difficulty,
    estimatedVramGB,
  };
}
