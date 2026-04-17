/**
 * Orchestrator Tool Definitions (Local Runtime) — barrel.
 *
 * Schemas colocated with their runtime executors in `./tools/*.ts`. This
 * file assembles the three top-level catalog exports (ORCHESTRATOR,
 * LSP, COS extension) and re-exports the filesystem/bash tool schemas
 * plus the intent-filter helpers so existing callers keep working.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';

// Runtime-owned tool catalogs (filesystem, bash) exported for callers.
import {
  FILESYSTEM_TOOL_DEFINITIONS,
  REQUEST_FILE_ACCESS_TOOL,
} from '../execution/filesystem/index.js';
import { BASH_TOOL_DEFINITIONS } from '../execution/bash/index.js';

// Orchestrator catalog pieces, colocated with executors.
import { LLM_TOOL_DEFINITIONS } from './tools/llm.js';
import { DAEMON_INFO_TOOL_DEFINITIONS } from './tools/daemon-info.js';
import { OPENCLAW_TOOL_DEFINITIONS } from './tools/openclaw.js';
import { RESYNC_TOOL_DEFINITIONS } from './tools/resync.js';
import { INVESTIGATE_SHELL_TOOL_DEFINITIONS } from './tools/investigate-shell.js';
import { WORKSPACE_PULSE_TOOL_DEFINITIONS } from './tools/workspace.js';
import { AGENT_TASK_TOOL_DEFINITIONS } from './tools/agents.js';
import { DELIVERABLE_TOOL_DEFINITIONS } from './tools/deliverables.js';
import { WORKFLOW_TOOL_DEFINITIONS } from './tools/workflows.js';
import { WORKFLOW_TRIGGER_TOOL_DEFINITIONS } from './tools/triggers.js';
import { AGENT_SCHEDULE_TOOL_DEFINITIONS } from './tools/schedules.js';
import { PROJECT_TOOL_DEFINITIONS } from './tools/projects.js';
import { GOAL_TOOL_DEFINITIONS } from './tools/goals.js';
import { AGENT_STATE_TOOL_DEFINITIONS } from './tools/state.js';
import { A2A_TOOL_DEFINITIONS } from './tools/a2a.js';
import { PEER_TOOL_DEFINITIONS } from './tools/peers.js';
import { WHATSAPP_TOOL_DEFINITIONS } from './tools/whatsapp.js';
import { TELEGRAM_TOOL_DEFINITIONS } from './tools/telegram.js';
import { BUSINESS_INTEL_TOOL_DEFINITIONS } from './tools/business-pulse.js';
import { CRM_TOOL_DEFINITIONS } from './tools/crm.js';
import { SCRAPING_TOOL_DEFINITIONS } from './tools/scraping.js';
import { RESEARCH_TOOL_DEFINITIONS } from './tools/research.js';
import { AUDIO_TOOL_DEFINITIONS } from './tools/audio.js';
import { MEETING_TOOL_DEFINITIONS } from './tools/meeting.js';
import { INTERNET_TOOL_DEFINITIONS } from './tools/internet.js';
import { OCR_TOOL_DEFINITIONS } from './tools/ocr.js';
import { ORCHESTRATION_HELPER_TOOL_DEFINITIONS } from './tools/sequences.js';
import { CO_EVOLUTION_TOOL_DEFINITIONS } from './tools/co-evolution.js';
import { AUTOMATION_BUILDER_TOOL_DEFINITIONS } from './tools/automation-builder.js';
import { AGENT_SUGGESTIONS_TOOL_DEFINITIONS } from './tools/agent-suggestions.js';
import { SETUP_TOOL_DEFINITIONS } from './tools/setup-agents.js';
import { MEDIA_TOOL_DEFINITIONS } from './tools/media.js';
import { KNOWLEDGE_TOOL_DEFINITIONS } from './tools/knowledge.js';
import { WIKI_TOOL_DEFINITIONS } from './tools/wiki.js';
import {
  X_POSTING_HEAD_TOOL_DEFINITIONS,
  X_POSTING_DELETE_TOOL_DEFINITIONS,
} from './tools/x-posting.js';
import { THREADS_POSTING_TOOL_DEFINITIONS } from './tools/threads-posting.js';
import { X_REPLY_TOOL_DEFINITIONS } from './tools/x-reply.js';
import { THREADS_REPLY_TOOL_DEFINITIONS } from './tools/threads-reply.js';
import { X_DELETE_REPLY_TOOL_DEFINITIONS } from './tools/x-delete.js';
import { THREADS_DELETE_TOOL_DEFINITIONS } from './tools/threads-delete.js';
import { SYNTHESIZE_FOR_GOAL_TOOL_DEFINITIONS } from './tools/synthesize-for-goal.js';
import { SYNTHESIS_ACCEPTANCE_TOOL_DEFINITIONS } from './tools/synthesis-acceptance.js';
import { CONNECTORS_TOOL_DEFINITIONS } from './tools/connectors.js';
import { PDF_TOOL_DEFINITIONS } from './tools/pdf.js';
import { CLOUD_TOOL_DEFINITIONS } from './tools/cloud-data.js';

// LSP + Center of Operations catalogs.
import { LSP_CODE_TOOL_DEFINITIONS } from './tools/lsp.js';
import { OPERATIONAL_PILLARS_TOOL_DEFINITIONS } from './tools/operational-pillars.js';
import { PERSON_MODEL_TOOL_DEFINITIONS } from './tools/person-model.js';
import { TEAM_TOOL_DEFINITIONS } from './tools/team.js';
import { PERSONA_TOOL_DEFINITIONS } from './tools/persona.js';
import { ONBOARDING_PLAN_TOOL_DEFINITIONS } from './tools/onboarding-plan.js';
import { TRANSITION_TOOL_DEFINITIONS } from './tools/transitions.js';
import { WORK_ROUTER_TOOL_DEFINITIONS } from './tools/work-router.js';
import { HUMAN_GROWTH_TOOL_DEFINITIONS } from './tools/human-growth.js';
import { OBSERVATION_TOOL_DEFINITIONS } from './tools/observation.js';
import { COLLECTIVE_INTELLIGENCE_TOOL_DEFINITIONS } from './tools/collective-intelligence.js';

export { FILESYSTEM_TOOL_DEFINITIONS, REQUEST_FILE_ACCESS_TOOL, BASH_TOOL_DEFINITIONS };

export {
  type IntentSection,
  getToolPriorityLimit,
  extractExplicitToolNames,
  filterToolsByIntent,
} from './tool-intent-filter.js';

/** Main orchestrator tool catalog, assembled in canonical source order. */
export const ORCHESTRATOR_TOOL_DEFINITIONS: Tool[] = [
  ...LLM_TOOL_DEFINITIONS,
  ...DAEMON_INFO_TOOL_DEFINITIONS,
  {
    name: 'update_plan',
    description:
      'Update your working task plan. Call at the start of a multi-step response with all planned tasks, then call again to mark tasks as in_progress or done as you complete them. This shows a live plan panel in the UI.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tasks: {
          type: 'array',
          description: 'The full list of plan tasks',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique task identifier (e.g. "1", "step-2")' },
              title: { type: 'string', description: 'Short description of the task' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'Task status' },
            },
            required: ['id', 'title', 'status'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  ...AGENT_TASK_TOOL_DEFINITIONS,
  ...DELIVERABLE_TOOL_DEFINITIONS,
  ...WORKSPACE_PULSE_TOOL_DEFINITIONS,
  ...WORKFLOW_TOOL_DEFINITIONS,
  ...WORKFLOW_TRIGGER_TOOL_DEFINITIONS,
  ...AGENT_SCHEDULE_TOOL_DEFINITIONS,
  ...PROJECT_TOOL_DEFINITIONS,
  ...GOAL_TOOL_DEFINITIONS,
  ...AGENT_STATE_TOOL_DEFINITIONS,
  ...A2A_TOOL_DEFINITIONS,
  ...PEER_TOOL_DEFINITIONS,
  ...WHATSAPP_TOOL_DEFINITIONS,
  ...TELEGRAM_TOOL_DEFINITIONS,
  ...BUSINESS_INTEL_TOOL_DEFINITIONS,
  ...CRM_TOOL_DEFINITIONS,
  ...SCRAPING_TOOL_DEFINITIONS,
  ...RESEARCH_TOOL_DEFINITIONS,
  ...AUDIO_TOOL_DEFINITIONS,
  ...MEETING_TOOL_DEFINITIONS,
  ...INTERNET_TOOL_DEFINITIONS,
  ...OCR_TOOL_DEFINITIONS,
  ...ORCHESTRATION_HELPER_TOOL_DEFINITIONS,
  ...CO_EVOLUTION_TOOL_DEFINITIONS,
  ...AUTOMATION_BUILDER_TOOL_DEFINITIONS,
  ...AGENT_SUGGESTIONS_TOOL_DEFINITIONS,
  ...SETUP_TOOL_DEFINITIONS,
  ...MEDIA_TOOL_DEFINITIONS,
  ...KNOWLEDGE_TOOL_DEFINITIONS,
  ...WIKI_TOOL_DEFINITIONS,
  ...X_POSTING_HEAD_TOOL_DEFINITIONS,
  ...X_REPLY_TOOL_DEFINITIONS,
  ...X_DELETE_REPLY_TOOL_DEFINITIONS,
  ...THREADS_POSTING_TOOL_DEFINITIONS,
  ...THREADS_REPLY_TOOL_DEFINITIONS,
  ...THREADS_DELETE_TOOL_DEFINITIONS,
  ...SYNTHESIZE_FOR_GOAL_TOOL_DEFINITIONS,
  ...SYNTHESIS_ACCEPTANCE_TOOL_DEFINITIONS,
  ...X_POSTING_DELETE_TOOL_DEFINITIONS,
  ...CONNECTORS_TOOL_DEFINITIONS,
  ...PDF_TOOL_DEFINITIONS,
  ...CLOUD_TOOL_DEFINITIONS,
  ...OPENCLAW_TOOL_DEFINITIONS,
  ...RESYNC_TOOL_DEFINITIONS,
  ...INVESTIGATE_SHELL_TOOL_DEFINITIONS,
];

/** The five real LSP tools: lsp_diagnostics/hover/go_to_definition/references/completions. */
export const LSP_TOOL_DEFINITIONS: Tool[] = [...LSP_CODE_TOOL_DEFINITIONS];

/**
 * Center of Operations extension tools: operational pillars, person model,
 * team, persona, onboarding plan, transition engine, work router, human
 * growth, observation layer, collective intelligence. Merged into the
 * orchestrator catalog by local-orchestrator.ts.
 */
export const COS_EXTENSION_TOOL_DEFINITIONS: Tool[] = [
  ...OPERATIONAL_PILLARS_TOOL_DEFINITIONS,
  ...PERSON_MODEL_TOOL_DEFINITIONS,
  ...TEAM_TOOL_DEFINITIONS,
  ...PERSONA_TOOL_DEFINITIONS,
  ...ONBOARDING_PLAN_TOOL_DEFINITIONS,
  ...TRANSITION_TOOL_DEFINITIONS,
  ...WORK_ROUTER_TOOL_DEFINITIONS,
  ...HUMAN_GROWTH_TOOL_DEFINITIONS,
  ...OBSERVATION_TOOL_DEFINITIONS,
  ...COLLECTIVE_INTELLIGENCE_TOOL_DEFINITIONS,
];
