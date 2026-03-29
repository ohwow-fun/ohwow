/**
 * Tool Embodiment — Transparent Extension (Merleau-Ponty)
 *
 * "The body is our general medium for having a world."
 * — Maurice Merleau-Ponty, Phenomenology of Perception
 *
 * Heidegger distinguished two modes of encountering tools:
 * - Ready-to-hand (Zuhandenheit): transparent, an extension of the body.
 *   A carpenter doesn't think about the hammer; it's part of their arm.
 * - Present-at-hand (Vorhandenheit): an object of conscious attention.
 *   A broken hammer is suddenly visible as an object.
 *
 * For AI agents, tools follow the same pattern:
 * - A "mastered" tool (50+ successful uses) is ready-to-hand. Its prompt
 *   description can be compressed because the LLM has seen it so many times
 *   in the conversation context that a short reminder suffices.
 * - A "novice" tool (< 20 uses) is present-at-hand. It needs a full
 *   description so the LLM understands what it does.
 *
 * This module:
 * 1. Generates compact descriptions for mastered tools (saves 200-500 tokens)
 * 2. Applies them to the tool list before sending to the LLM
 * 3. Connects the SelfModelBuilder's proficiency tracking to tool definitions
 *
 * The SelfModelBuilder owns the data (usage counts, success rates, patterns).
 * This module owns the presentation (compact descriptions, tool list mutation).
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { SelfModelBuilder } from './self-model.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Maximum characters for a compact description. */
const COMPACT_DESC_MAX_LENGTH = 80;

/**
 * Hand-written compact descriptions for common tools.
 * These are the "ready-to-hand" summaries: just enough to remind,
 * not enough to teach.
 */
const COMPACT_DESCRIPTIONS: Record<string, string> = {
  // Planning & task management
  update_plan: 'Update working task plan (show/hide tasks, mark progress)',
  list_agents: 'List all AI agents with status and role',
  run_agent: 'Execute an agent on a task',
  spawn_agents: 'Run multiple agents in parallel',
  queue_task: 'Queue a task for an agent',
  list_tasks: 'List recent tasks with status',
  get_task_detail: 'Get full details of a specific task',
  approve_task: 'Approve a pending task',
  reject_task: 'Reject a pending task',

  // Workflows
  list_workflows: 'List automation workflows',
  run_workflow: 'Execute a workflow by name',
  generate_workflow: 'AI-generate a workflow from description',

  // Projects & goals
  list_projects: 'List active projects',
  create_project: 'Create a new project',
  list_goals: 'List workspace goals',

  // CRM
  list_contacts: 'List CRM contacts with filters',
  create_contact: 'Create a new contact',
  search_contacts: 'Search contacts by name/email',
  log_contact_event: 'Log an interaction with a contact',

  // Research & data
  scrape_url: 'Fetch and extract content from a URL',
  scrape_search: 'Search the web and return results',
  deep_research: 'Multi-query synthesis research',

  // Messaging
  send_whatsapp_message: 'Send a WhatsApp message',
  send_telegram_message: 'Send a Telegram message',

  // Business intelligence
  get_business_pulse: 'Get workspace metrics summary',

  // Sub-orchestrator
  delegate_subtask: 'Delegate a research subtask to a sub-agent',
};

// ============================================================================
// TOOL EMBODIMENT
// ============================================================================

/**
 * Apply embodied knowledge to a tool list.
 *
 * For each tool that the brain has mastered, replace the full description
 * with a compact one. This saves tokens in the system prompt, leaving
 * more room for actual conversation context.
 *
 * @param tools - The full tool list (Anthropic format)
 * @param selfModel - The brain's self-awareness module
 * @returns A new tool array with compact descriptions where appropriate
 */
export function applyToolEmbodiment(
  tools: Tool[],
  selfModel: SelfModelBuilder,
): Tool[] {
  return tools.map(tool => {
    const mastery = selfModel.getToolMastery(tool.name);

    // Only compress mastered tools (ready-to-hand)
    if (mastery !== 'mastered') return tool;

    // Use hand-written compact description if available
    const compact = COMPACT_DESCRIPTIONS[tool.name];
    if (!compact) return tool;

    // Return a copy with the compact description
    return {
      ...tool,
      description: compact,
    };
  });
}

/**
 * Estimate token savings from tool embodiment.
 * Useful for logging and self-model calibration.
 */
export function estimateEmbodimentSavings(
  tools: Tool[],
  selfModel: SelfModelBuilder,
): { toolsCompressed: number; tokensEstimatedSaved: number } {
  let toolsCompressed = 0;
  let tokensSaved = 0;

  for (const tool of tools) {
    const mastery = selfModel.getToolMastery(tool.name);
    if (mastery !== 'mastered') continue;

    const compact = COMPACT_DESCRIPTIONS[tool.name];
    if (!compact) continue;

    const originalTokens = Math.ceil((tool.description?.length ?? 0) / 4);
    const compactTokens = Math.ceil(compact.length / 4);
    const saving = originalTokens - compactTokens;

    if (saving > 0) {
      toolsCompressed++;
      tokensSaved += saving;
    }
  }

  return { toolsCompressed, tokensEstimatedSaved: tokensSaved };
}

/**
 * Get the compact description for a tool, if one exists.
 * Returns undefined for tools without a compact variant.
 */
export function getCompactDescription(toolName: string): string | undefined {
  return COMPACT_DESCRIPTIONS[toolName];
}
