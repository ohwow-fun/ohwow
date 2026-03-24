/**
 * Prompt Injection Defense (Local Runtime)
 * Log-only scanner + user-data wrapping for prompt isolation.
 * Ported from cloud: src/lib/agents/prompts/builders.ts
 */

import { logger } from './logger.js';

// ============================================================================
// INJECTION PATTERN SCANNER
// ============================================================================

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+/i,
  /^system\s*:/im,
  /```system/i,
  /\[INST\]/i,
  /^Human\s*:/im,
  /^Assistant\s*:/im,
  /disregard\s+(all\s+)?(prior|above)/i,
  /override\s+(your\s+)?instructions/i,
  /new\s+instructions?\s*:/i,
];

/**
 * Scan user-provided fields for potential prompt injection patterns.
 * Log-only — never blocks execution.
 */
export function scanForInjection(
  fields: Record<string, string | undefined | null>,
  context: { taskId?: string; agentId?: string },
): void {
  for (const [fieldName, value] of Object.entries(fields)) {
    if (!value) continue;
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(value)) {
        logger.warn(
          {
            pattern: pattern.source,
            taskId: context.taskId,
            agentId: context.agentId,
            snippet: value.slice(0, 200),
          },
          `[Prompt Injection Scanner] Suspicious pattern in ${fieldName}`,
        );
        break; // One warning per field is enough
      }
    }
  }
}

// ============================================================================
// USER DATA WRAPPING
// ============================================================================

/**
 * Wrap user-provided text in boundary tags for prompt isolation.
 * Helps the model distinguish user-supplied data from system instructions.
 */
export function wrapUserData(text: string): string {
  return `[START USER-PROVIDED DATA]\n${text}\n[END USER-PROVIDED DATA]`;
}
