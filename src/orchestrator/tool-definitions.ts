/**
 * Orchestrator Tool Definitions (Local Runtime)
 * Anthropic tool_use schema for the orchestrator chat.
 * Adapted from web app — removed navigate_user, get_credits, get_integration_status.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { PDF_TOOL_DEFINITIONS } from './tools/pdf.js';
import { CONNECTORS_TOOL_DEFINITIONS } from './tools/connectors.js';
import { CLOUD_TOOL_DEFINITIONS } from './tools/cloud-data.js';
import { MEDIA_TOOL_DEFINITIONS } from './tools/media.js';
import { KNOWLEDGE_TOOL_DEFINITIONS } from './tools/knowledge.js';
import { WIKI_TOOL_DEFINITIONS } from './tools/wiki.js';
import {
  X_POSTING_HEAD_TOOL_DEFINITIONS,
  X_POSTING_DELETE_TOOL_DEFINITIONS,
} from './tools/x-posting.js';
import { LLM_TOOL_DEFINITIONS } from './tools/llm.js';
import { DAEMON_INFO_TOOL_DEFINITIONS } from './tools/daemon-info.js';
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
import { SYNTHESIZE_FOR_GOAL_TOOL_DEFINITIONS } from './tools/synthesize-for-goal.js';
import { SYNTHESIS_ACCEPTANCE_TOOL_DEFINITIONS } from './tools/synthesis-acceptance.js';

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
  ...SYNTHESIZE_FOR_GOAL_TOOL_DEFINITIONS,
  ...SYNTHESIS_ACCEPTANCE_TOOL_DEFINITIONS,
  ...X_POSTING_DELETE_TOOL_DEFINITIONS,

  ...CONNECTORS_TOOL_DEFINITIONS,
  ...PDF_TOOL_DEFINITIONS,
  ...CLOUD_TOOL_DEFINITIONS,
];

// =========================================================================
// LOCAL FILE ACCESS (conditionally added)
// =========================================================================

import {
  FILESYSTEM_TOOL_DEFINITIONS,
  REQUEST_FILE_ACCESS_TOOL,
} from '../execution/filesystem/index.js';

export { FILESYSTEM_TOOL_DEFINITIONS, REQUEST_FILE_ACCESS_TOOL };

// =========================================================================
// BASH COMMAND EXECUTION (conditionally added)
// =========================================================================

import {
  BASH_TOOL_DEFINITIONS,
} from '../execution/bash/index.js';

export { BASH_TOOL_DEFINITIONS };

// =========================================================================
// LSP CODE INTELLIGENCE TOOLS
// =========================================================================

export const LSP_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'lsp_diagnostics',
    description: 'Get compiler errors and warnings for a file using the language server. Use before and after edits to verify correctness.',
    input_schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path (absolute or relative to workspace)' },
      },
      required: ['file'],
    },
  },
  {
    name: 'lsp_hover',
    description: 'Get type information and documentation for a symbol at a specific position in a file.',
    input_schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Line number (1-based)' },
        character: { type: 'number', description: 'Column number (1-based)' },
      },
      required: ['file', 'line', 'character'],
    },
  },
  {
    name: 'lsp_go_to_definition',
    description: 'Jump to the definition of a symbol at a given position. Returns the file and location with surrounding code context.',
    input_schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Line number (1-based)' },
        character: { type: 'number', description: 'Column number (1-based)' },
      },
      required: ['file', 'line', 'character'],
    },
  },
  {
    name: 'lsp_references',
    description: 'Find all references to a symbol at a given position across the project.',
    input_schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Line number (1-based)' },
        character: { type: 'number', description: 'Column number (1-based)' },
      },
      required: ['file', 'line', 'character'],
    },
  },
  {
    name: 'lsp_completions',
    description: 'Get code completions at a position. Useful for discovering available methods, properties, or imports.',
    input_schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Line number (1-based)' },
        character: { type: 'number', description: 'Column number (1-based)' },
      },
      required: ['file', 'line', 'character'],
    },
  },

  // --- Operational Pillars (Proactive Intelligence) ---
  {
    name: 'assess_operations',
    description: 'Analyze the workspace\'s current operational health against what it SHOULD be doing at its growth stage and business type. Returns a gap analysis with critical, important, and recommended pillars. Use proactively when the user asks what to focus on, or in early conversations.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category_filter: { type: 'string', description: 'Filter by category: acquisition, retention, operations, finance, product, team, strategy' },
        include_dismissed: { type: 'boolean', description: 'Include dismissed pillars (default false)' },
      },
      required: [],
    },
  },
  {
    name: 'get_pillar_detail',
    description: 'Get detailed info about a specific operational pillar: setup steps, KPIs, and current workspace status.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pillar_slug: { type: 'string', description: 'Pillar slug (e.g. "content_pipeline", "outbound_outreach")' },
      },
      required: ['pillar_slug'],
    },
  },
  {
    name: 'build_pillar',
    description: 'Start building an operational pillar. Creates a blueprint with setup steps and marks as "building".',
    input_schema: {
      type: 'object' as const,
      properties: {
        pillar_slug: { type: 'string', description: 'Pillar slug to build' },
        custom_context: { type: 'string', description: 'Optional context about user preferences for this pillar' },
      },
      required: ['pillar_slug'],
    },
  },
  {
    name: 'update_pillar_status',
    description: 'Update an operational pillar status to running, optimizing, paused, or dismissed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pillar_slug: { type: 'string', description: 'Pillar slug to update' },
        status: { type: 'string', description: 'New status: running, optimizing, paused, dismissed' },
      },
      required: ['pillar_slug', 'status'],
    },
  },

  // --- Person Model (Deep Person Ingestion) ---
  {
    name: 'get_person_model',
    description: 'Get the Person Model for a team member or workspace owner. Returns skills, domain expertise, communication style, energy patterns, motivations, growth arc, and more.',
    input_schema: {
      type: 'object' as const,
      properties: {
        person_id: { type: 'string', description: 'Person model ID. If omitted, returns the first model in the workspace.' },
      },
      required: [],
    },
  },
  {
    name: 'list_person_models',
    description: 'List all Person Models in the workspace.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'start_person_ingestion',
    description: 'Start Person Ingestion for a new or existing team member. Creates a Person Model and returns an interview guide for conversational profiling. Use variant "founder" for workspace owner, "team_member" for team.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Person name' },
        email: { type: 'string', description: 'Email (optional)' },
        role_title: { type: 'string', description: 'Role/title (optional)' },
        variant: { type: 'string', description: '"founder" or "team_member" (default)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_person_model',
    description: 'Update Person Model dimensions after learning something new. Call silently whenever you learn about a person.',
    input_schema: {
      type: 'object' as const,
      properties: {
        person_id: { type: 'string', description: 'Person model ID' },
        updates: { type: 'object', description: 'Dimension key-value pairs to update (skills_map, communication_style, friction_points, etc.)' },
        observation: { type: 'string', description: 'Natural language description of what was observed' },
        observation_type: { type: 'string', description: 'Type: task_outcome, communication, feedback, self_report, behavioral, correction' },
      },
      required: ['person_id', 'updates'],
    },
  },

  // --- Team members (human collaborators) ---
  {
    name: 'create_team_member',
    description: 'Add a new human team member to the workspace. Use this when the user says "X is joining the team" or "hire Y" or "onboard Z". Returns the new member record; follow up with assign_guide_agent and start_person_ingestion to run the full onboarding flow.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Full name (required)' },
        email: { type: 'string', description: 'Email address' },
        role: { type: 'string', description: 'Role or job title (e.g. "Growth Lead")' },
        timezone: { type: 'string', description: 'IANA timezone like America/Los_Angeles' },
        phone: { type: 'string', description: 'Phone (optional)' },
        group_label: { type: 'string', description: 'Free-form team label: "engineering", "gtm", etc.' },
        capacity_hours: { type: 'number', description: 'Weekly capacity in hours' },
        skills: { type: 'array', items: { type: 'string' }, description: 'List of skill tags' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_team_members',
    description: 'List all human team members in the workspace with their guide agent, onboarding status, and invite status.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'update_team_member',
    description: 'Edit an existing team member record. Pass only the fields you want to change.',
    input_schema: {
      type: 'object' as const,
      properties: {
        team_member_id: { type: 'string', description: 'Team member id (from create_team_member or list_team_members)' },
        name: { type: 'string' },
        email: { type: 'string' },
        role: { type: 'string' },
        timezone: { type: 'string' },
        phone: { type: 'string' },
        group_label: { type: 'string' },
        capacity_hours: { type: 'number' },
        skills: { type: 'array', items: { type: 'string' } },
        onboarding_status: { type: 'string', description: 'not_started | in_progress | ready | active' },
      },
      required: ['team_member_id'],
    },
  },
  {
    name: 'assign_guide_agent',
    description: 'Assign a dedicated "chief of staff" guide agent to a team member. If agent_id is omitted, a new Chief of Staff agent is auto-spawned for them. The guide becomes the member\'s always-on AI partner.',
    input_schema: {
      type: 'object' as const,
      properties: {
        team_member_id: { type: 'string', description: 'Team member id' },
        agent_id: { type: 'string', description: 'Optional: pick an existing agent instead of spawning one' },
      },
      required: ['team_member_id'],
    },
  },
  {
    name: 'draft_cloud_invite',
    description: 'Draft (do NOT send yet) a cloud dashboard invite email for a team member. Returns a preview email body the founder can review before calling send_cloud_invite. Use this when the founder wants to review before sending.',
    input_schema: {
      type: 'object' as const,
      properties: {
        team_member_id: { type: 'string', description: 'Team member id' },
        role: { type: 'string', description: 'Cloud role: admin, member, viewer. Default: member.' },
      },
      required: ['team_member_id'],
    },
  },
  {
    name: 'send_cloud_invite',
    description: 'Actually send a cloud dashboard invite to a team member via email. Creates a workspace_invites row on the cloud, sends the invite email, and stores the token on the local team_members row so we can track acceptance. The member will receive a real email with a 7-day invite link. Use this when the founder says something like "send the invite", "invite them", or "send mario the link" — it replaces the draft-only flow.',
    input_schema: {
      type: 'object' as const,
      properties: {
        team_member_id: { type: 'string', description: 'Team member id' },
        role: { type: 'string', description: 'Cloud role: admin, member, viewer. Default: member.' },
      },
      required: ['team_member_id'],
    },
  },
  {
    name: 'list_member_tasks',
    description: 'List work routed to a specific human team member via the work router.',
    input_schema: {
      type: 'object' as const,
      properties: {
        team_member_id: { type: 'string', description: 'Team member id' },
      },
      required: ['team_member_id'],
    },
  },

  // --- Conversation persona ---
  {
    name: 'activate_guide_persona',
    description: 'Install a team member\'s assigned guide agent (Chief of Staff) as the driver of this chat session. From the next turn on, replies use the agent\'s system prompt, model_policy, and voice instead of the generic orchestrator. Call this the moment a human team member starts being onboarded or asks to talk to their guide directly.',
    input_schema: {
      type: 'object' as const,
      properties: {
        team_member_id: { type: 'string', description: 'Team member whose assigned guide should take over' },
      },
      required: ['team_member_id'],
    },
  },
  {
    name: 'activate_persona',
    description: 'Install any agent in the workspace as the driver of this chat session, without requiring a team_member. Useful when a sales, support, or specialist agent should take over a thread directly.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Agent id to install as persona' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'deactivate_persona',
    description: 'Clear the active persona for this chat session and return control to the orchestrator voice.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_active_persona',
    description: 'Check whether this chat session currently has an agent persona active, and if so which one.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },

  // --- Onboarding plan (first-month ramp) ---
  {
    name: 'propose_first_month_plan',
    description: 'CRITICAL: when a new human team member has gone through enough intake (at least 3 populated person_model dimensions), STOP asking interview questions and call this tool. It synthesizes a grounded 4-week ramp plan from what you already know about them and returns a markdown draft you should present in the chat. Do not ask the member "what do you want to accomplish in your first month" — new hires are the least-qualified to answer that. Propose, then invite pushback.',
    input_schema: {
      type: 'object' as const,
      properties: {
        team_member_id: { type: 'string', description: 'Team member to generate the plan for' },
      },
      required: ['team_member_id'],
    },
  },
  {
    name: 'accept_onboarding_plan',
    description: 'Materialize a draft onboarding plan into real tasks + goals. Only call this AFTER the member has actually agreed to the plan shown in chat. Creates one goal per week and one task per week task, routes human-owned tasks to the member via work_routing_decisions, and emits an activity feed event.',
    input_schema: {
      type: 'object' as const,
      properties: {
        plan_id: { type: 'string', description: 'Plan id returned from propose_first_month_plan' },
      },
      required: ['plan_id'],
    },
  },
  {
    name: 'get_onboarding_plan',
    description: 'Fetch an onboarding plan by plan_id, or the most recent plan for a team_member_id. Returns status, rationale, weeks, and materialization state.',
    input_schema: {
      type: 'object' as const,
      properties: {
        plan_id: { type: 'string' },
        team_member_id: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'list_onboarding_plans',
    description: 'List onboarding plans in the workspace, newest first.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },

  // --- Transition Engine ---
  {
    name: 'get_transition_status',
    description: 'Show all task patterns and their transition stages (Shadow/Suggest/Draft/Autopilot/Autonomous). Shows time saved and automation progress.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'override_transition_stage',
    description: 'Manually promote or demote a task pattern to a different stage. Requires confirmation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        transition_id: { type: 'string', description: 'Transition ID' },
        new_stage: { type: 'number', description: '1=Shadow, 2=Suggest, 3=Draft, 4=Autopilot, 5=Autonomous' },
        reason: { type: 'string', description: 'Why the override' },
      },
      required: ['transition_id', 'new_stage', 'reason'],
    },
  },
  {
    name: 'detect_task_patterns',
    description: 'Scan recent task history for recurring patterns. Creates task patterns from clusters of 3+ similar tasks.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_time_saved',
    description: 'Get aggregate time saved by the Transition Engine. Shows hours saved, patterns tracked, automation rate.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },

  // Work Router tools (Phase 3: Intelligent Work Router)
  {
    name: 'route_task',
    description: 'Route a task to the best person or agent. Scores candidates on skill match, capacity, energy alignment, growth value, transition stage, cost, and team balance. Auto-assigns when confidence is high.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_title: { type: 'string', description: 'Title/description of the task to route' },
        task_id: { type: 'string', description: 'Optional task ID to link the routing decision' },
        urgency: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'Task urgency (default: normal)' },
        required_skills: { type: 'array', items: { type: 'string' }, description: 'Skills needed for this task' },
        estimated_effort_minutes: { type: 'number', description: 'Estimated effort in minutes' },
        preferred_assignee_id: { type: 'string', description: 'Optional preferred person/agent ID' },
        department_id: { type: 'string', description: 'Limit agent candidates to this department' },
      },
      required: ['task_title'],
    },
  },
  {
    name: 'get_routing_recommendations',
    description: 'Get routing recommendations for a task without recording a decision. Shows scored candidates with breakdown.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_title: { type: 'string', description: 'Title/description of the task' },
        urgency: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
        required_skills: { type: 'array', items: { type: 'string' } },
        estimated_effort_minutes: { type: 'number' },
      },
      required: ['task_title'],
    },
  },
  {
    name: 'get_workload_balance',
    description: 'Show workload distribution across people and agents this week. Active tasks, completions, quality scores.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'record_routing_outcome',
    description: 'Record the outcome of a routing decision. Tracks quality to improve future routing.',
    input_schema: {
      type: 'object' as const,
      properties: {
        decision_id: { type: 'string', description: 'Routing decision ID' },
        outcome: { type: 'string', enum: ['completed', 'reassigned', 'rejected', 'timed_out'] },
        quality_score: { type: 'number', description: '0-1 quality score' },
        actual_effort_minutes: { type: 'number', description: 'Actual effort in minutes' },
      },
      required: ['decision_id', 'outcome'],
    },
  },
  {
    name: 'get_task_augmentation',
    description: 'Get pre/co/post work augmentations for a routing decision. Shows what agents prepared or handled around a human task.',
    input_schema: {
      type: 'object' as const,
      properties: {
        decision_id: { type: 'string', description: 'Routing decision ID' },
      },
      required: ['decision_id'],
    },
  },
  {
    name: 'trigger_pre_work',
    description: 'Create a pre-work augmentation for a routed task. Agents gather context, pull docs, draft outlines before the human starts.',
    input_schema: {
      type: 'object' as const,
      properties: {
        decision_id: { type: 'string', description: 'Routing decision ID' },
        augmentation_type: { type: 'string', description: 'Type: context_gathering, doc_summary, outline_draft, prior_art' },
        description: { type: 'string', description: 'What the pre-work should prepare' },
        agent_id: { type: 'string', description: 'Specific agent to handle it' },
      },
      required: ['decision_id'],
    },
  },

  // Human Growth Engine tools (Phase 4)
  {
    name: 'get_human_growth',
    description: 'Get a person\'s growth arc: competence, autonomy, specialization, relationship health. Computes a fresh snapshot from recent data. Detects burnout risk, plateau, motivation drift, and role evolution.',
    input_schema: {
      type: 'object' as const,
      properties: {
        person_id: { type: 'string', description: 'Person model ID' },
      },
      required: ['person_id'],
    },
  },
  {
    name: 'get_skill_paths',
    description: 'Get active skill development paths for a person. Shows milestones, progress, scaffolding levels, and suggested tasks.',
    input_schema: {
      type: 'object' as const,
      properties: {
        person_id: { type: 'string', description: 'Person model ID' },
      },
      required: ['person_id'],
    },
  },
  {
    name: 'create_skill_path',
    description: 'Generate a skill development path with progressive milestones. Scaffolding decreases as difficulty increases (high at beginner, none at expert).',
    input_schema: {
      type: 'object' as const,
      properties: {
        person_id: { type: 'string', description: 'Person model ID' },
        skill_name: { type: 'string', description: 'Skill to develop (e.g., content_writing, sales, analytics)' },
        target_level: { type: 'number', description: 'Target proficiency 0-1 (default: 0.75 = advanced)' },
      },
      required: ['person_id', 'skill_name'],
    },
  },
  {
    name: 'get_team_health',
    description: 'Assess team-wide health: who is growing, plateauing, or declining. Surfaces burnout signals, motivation drift, and plateau alerts with severity levels and suggested interventions.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_delegation_metrics',
    description: 'Get founder delegation tracking: total decisions, delegation rate, trend, successes vs reverts. Suggests tasks that could be delegated to agents.',
    input_schema: {
      type: 'object' as const,
      properties: {
        person_id: { type: 'string', description: 'Person model ID (typically the founder)' },
      },
      required: ['person_id'],
    },
  },
  {
    name: 'record_skill_assessment',
    description: 'Log a skill assessment (self-report or peer observation). Updates the person\'s skill level and checks milestone achievements.',
    input_schema: {
      type: 'object' as const,
      properties: {
        person_id: { type: 'string', description: 'Person model ID' },
        skill_name: { type: 'string', description: 'Skill name' },
        new_level: { type: 'number', description: 'New proficiency level 0-1' },
        source: { type: 'string', enum: ['self_assessment', 'peer_observation', 'task_outcome', 'training', 'routing_feedback'], description: 'Source of the assessment' },
        task_id: { type: 'string', description: 'Optional: task that prompted this assessment' },
        notes: { type: 'string', description: 'Optional: notes about the assessment' },
      },
      required: ['person_id', 'skill_name', 'new_level'],
    },
  },

  // Observation Layer tools (Phase 5)
  {
    name: 'get_work_patterns',
    description: 'Get the Work Pattern Map for a person: communication patterns, task engagement, time allocation, automation adoption, knowledge consumption, operational health. Computes fresh if stale (>30min). Shows insights and suggestions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        person_id: { type: 'string', description: 'Person model ID' },
      },
      required: ['person_id'],
    },
  },
  {
    name: 'get_time_allocation',
    description: 'Detailed time allocation breakdown for a person this week: deep work, communication, meetings, approvals, operations. Shows percentage split.',
    input_schema: {
      type: 'object' as const,
      properties: {
        person_id: { type: 'string', description: 'Person model ID' },
      },
      required: ['person_id'],
    },
  },
  {
    name: 'detect_automation_opportunities',
    description: 'Find recurring tasks that aren\'t in the Transition Engine yet. Scans completed task titles for clusters of 3+ similar tasks not being tracked.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_observation_insights',
    description: 'Surface top insights from work pattern analysis: time sinks, automation candidates, communication overload, deep work deficits, approval bottlenecks.',
    input_schema: {
      type: 'object' as const,
      properties: {
        person_id: { type: 'string', description: 'Person model ID' },
      },
      required: ['person_id'],
    },
  },

  // Collective Intelligence tools (Phase 6)
  {
    name: 'get_cross_pollination',
    description: 'Find knowledge transfer opportunities across people and agents. Detects when someone excels at a skill another person is trying to develop.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'schedule_team_council',
    description: 'Suggest data-enriched council topics from current team state: workload imbalances, growth concerns, operational gaps, strategy questions.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_collective_briefing',
    description: 'Assemble a collective intelligence briefing for a person: team growth trends, cross-pollination suggestions, workload alerts, council insights, team capacity.',
    input_schema: {
      type: 'object' as const,
      properties: {
        person_id: { type: 'string', description: 'Person model ID' },
      },
      required: ['person_id'],
    },
  },
  {
    name: 'rebalance_workload',
    description: 'Analyze team workload and suggest rebalancing. Identifies overloaded people with tasks that agents could handle. Shows team capacity and headroom.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },

];

// Intent-based tool filtering lives in tool-intent-filter.ts. Re-exported
// here so existing callers that import filtering helpers from
// `./tool-definitions.js` keep working unchanged.
export {
  type IntentSection,
  getToolPriorityLimit,
  extractExplicitToolNames,
  filterToolsByIntent,
} from './tool-intent-filter.js';

