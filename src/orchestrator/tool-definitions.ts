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

export const ORCHESTRATOR_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'llm',
    description:
      'Invoke an LLM for a specific sub-task. Agents act as sub-orchestrators: call this tool with a `purpose` that matches what the brain step is doing (reasoning, generation, summarization, extraction, critique, translation, classification, planning, etc.). The router picks the right model based on the agent\'s model_policy, workspace defaults, and call-site constraints. Use this instead of assuming any specific model. Returns { text, model_used, provider, tokens, cost_cents, latency_ms }.',
    input_schema: {
      type: 'object' as const,
      properties: {
        purpose: {
          type: 'string',
          enum: [
            'orchestrator_chat', 'agent_task', 'planning', 'browser_automation',
            'memory_extraction', 'ocr', 'workflow_step', 'simple_classification',
            'desktop_control', 'reasoning', 'generation', 'summarization',
            'extraction', 'critique', 'translation', 'embedding',
          ],
          description: 'The semantic purpose of this call. Drives model selection. Default: reasoning.',
        },
        prompt: {
          oneOf: [
            { type: 'string', description: 'A plain user prompt.' },
            {
              type: 'object',
              properties: {
                system: { type: 'string', description: 'Optional system prompt.' },
                messages: {
                  type: 'array',
                  description: 'Chat-style messages with role + content.',
                  items: {
                    type: 'object',
                    properties: {
                      role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
                      content: { type: 'string' },
                    },
                    required: ['role', 'content'],
                  },
                },
              },
            },
          ],
          description: 'Either a plain string or { system?, messages[] }.',
        },
        system: { type: 'string', description: 'Optional system prompt when `prompt` is a plain string.' },
        max_tokens: { type: 'number', description: 'Maximum output tokens.' },
        temperature: { type: 'number', description: 'Sampling temperature (provider default when omitted).' },
        local_only: { type: 'boolean', description: 'Force local inference; do not use cloud providers.' },
        prefer_model: { type: 'string', description: 'Call-site model override. Tightest win over agent and workspace defaults.' },
        max_cost_cents: { type: 'number', description: 'Advisory cost ceiling in cents. Warnings surface in cap_warning if exceeded.' },
        difficulty: { type: 'string', enum: ['simple', 'moderate', 'complex'], description: 'Hint for difficulty-aware routing.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'get_daemon_info',
    description: 'Return canonical paths, database location, and key table names for the running ohwow daemon. Call this BEFORE guessing file paths or sqlite commands — it gives you the absolute runtime.db path, auth token path, screenshots dir, repo locations, and an example sqlite3 command. Always available regardless of intent. Use it whenever an agent task involves local filesystem reads, sqlite queries, or anything that depends on where the daemon keeps its state.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
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
  {
    name: 'list_agents',
    description:
      'Get all AI agents with their status, role, and schedules. Use when the user asks about their team or agents.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_tasks',
    description:
      'Get recent tasks. Can filter by status (pending, running, completed, failed, needs_approval, cancelled) and/or agent ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'needs_approval', 'cancelled'] },
        agent_id: { type: 'string', description: 'Filter by agent ID' },
        project_id: { type: 'string', description: 'Filter by project ID' },
        limit: { type: 'number', description: 'Max tasks to return (default 10)' },
      },
      required: [],
    },
  },
  {
    name: 'get_task_detail',
    description:
      'Get full details of a specific task including output, error, tokens, and cost.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'The task ID' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_pending_approvals',
    description:
      'Get all tasks waiting for user approval.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'approve_task',
    description:
      'Approve a task in needs_approval status. Always describe what you\'re approving and confirm first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'The task ID to approve' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'reject_task',
    description:
      'Reject a task in needs_approval status with a reason. Always confirm first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'The task ID to reject' },
        reason: { type: 'string', description: 'Reason for rejection' },
        retry: { type: 'boolean', description: 'If true, create a new task with rejection feedback and re-execute the agent' },
      },
      required: ['task_id', 'reason'],
    },
  },
  {
    name: 'run_agent',
    description:
      'Execute an agent IMMEDIATELY with a specific task prompt. Use ONLY for immediate execution. Always confirm first. NEVER call this again for the same agent if you already ran it — use get_task_detail with the task ID to check progress instead. Do NOT use for queuing — use queue_task instead.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'The agent ID' },
        prompt: { type: 'string', description: 'The task prompt' },
        project_id: { type: 'string', description: 'Optional project ID' },
        model_tier: {
          type: 'string',
          enum: ['fast', 'balanced', 'strong'],
          description: 'Model selection hint. "fast" for lookups/status checks. "balanced" for standard work. "strong" for complex reasoning, analysis, multi-step procedures, or desktop/browser automation. Omit for auto-detection from task complexity.',
        },
      },
      required: ['agent_id', 'prompt'],
    },
  },
  {
    name: 'spawn_agents',
    description:
      'Launch multiple agents in parallel (fire-and-forget). Returns immediately with task IDs. Use when you need 2+ agents to work simultaneously. Check progress with list_tasks or get_task_detail.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agents: {
          type: 'array',
          description: 'Array of agents to spawn',
          items: {
            type: 'object',
            properties: {
              agent_id: { type: 'string', description: 'The agent ID' },
              prompt: { type: 'string', description: 'The task prompt for this agent' },
              project_id: { type: 'string', description: 'Optional project ID' },
              model_tier: {
                type: 'string',
                enum: ['fast', 'balanced', 'strong'],
                description: 'Model tier hint for this agent',
              },
            },
            required: ['agent_id', 'prompt'],
          },
        },
      },
      required: ['agents'],
    },
  },
  {
    name: 'await_agent_results',
    description:
      'Wait for one or more spawned agent tasks to complete and return their aggregated results. Use after spawn_agents to collect results instead of polling with get_task_detail.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_ids: {
          type: 'array',
          description: 'Task IDs to wait for (from spawn_agents response)',
          items: { type: 'string' },
        },
        timeout_seconds: {
          type: 'number',
          description: 'Max seconds to wait (default 120). Returns partial results on timeout.',
        },
      },
      required: ['task_ids'],
    },
  },
  {
    name: 'queue_task',
    description:
      'Queue a task for later (NOT immediately). Creates a pending task without running it. Use when the user says "queue", "add to backlog", "plan for later". For recurring/scheduled execution, use propose_automation with trigger_type="schedule" instead.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'The agent ID' },
        prompt: { type: 'string', description: 'The task prompt' },
        title: { type: 'string', description: 'Optional short title' },
        project_id: { type: 'string', description: 'Optional project ID' },
      },
      required: ['agent_id', 'prompt'],
    },
  },
  {
    name: 'retry_task',
    description:
      'Retry a failed task. Only works on failed tasks. Always confirm first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'The failed task ID' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'cancel_task',
    description:
      'Cancel a running or pending task.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'The task ID to cancel' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'save_deliverable',
    description:
      'Save a work product from this conversation as a deliverable. Use when you have produced substantial content the user may want to reference later (a draft, report, plan, analysis, creative writing, code, etc.). Always ask the user before saving.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Descriptive title for the deliverable' },
        content: { type: 'string', description: 'The full deliverable content to save' },
        type: {
          type: 'string',
          enum: ['document', 'email', 'report', 'code', 'creative', 'plan', 'data', 'other'],
          description: 'Type of deliverable',
        },
      },
      required: ['title', 'content', 'type'],
    },
  },
  {
    name: 'get_workspace_stats',
    description:
      'Get workspace statistics: total tasks, completed this week, failed, agent count, costs.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_activity_feed',
    description:
      'Get recent activity entries from the workspace.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max entries (default 10)' },
      },
      required: [],
    },
  },
  {
    name: 'list_workflows',
    description:
      'Get all workflows in the workspace.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'run_workflow',
    description:
      'Execute a workflow by ID. Always confirm first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string', description: 'The workflow ID' },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'get_workflow_detail',
    description:
      'Get full details of a workflow including its step definitions and recent run history.',
    input_schema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string', description: 'The workflow ID' },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'generate_workflow',
    description:
      'Generate a workflow from a natural language description using AI. Auto-saves by default. Confirm before generating.',
    input_schema: {
      type: 'object' as const,
      properties: {
        description: { type: 'string', description: 'Natural language description of the workflow' },
        auto_save: { type: 'boolean', description: 'Auto-save the generated workflow (default true)' },
      },
      required: ['description'],
    },
  },
  {
    name: 'create_workflow',
    description:
      'Create a workflow with explicit step definitions. Use generate_workflow for natural language descriptions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Workflow name' },
        description: { type: 'string', description: 'Optional description' },
        definition: {
          type: 'object',
          description: 'Workflow definition with a steps array',
          properties: {
            steps: { type: 'array', description: 'Array of workflow steps' },
          },
          required: ['steps'],
        },
      },
      required: ['name', 'definition'],
    },
  },
  {
    name: 'update_workflow',
    description:
      'Update a workflow\'s name, description, status, or step definitions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string', description: 'The workflow ID' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['active', 'paused'] },
        definition: { type: 'object', description: 'Updated definition with steps' },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'delete_workflow',
    description:
      'Delete a workflow. Always confirm first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string', description: 'The workflow ID' },
      },
      required: ['workflow_id'],
    },
  },
  // Workflow trigger tools
  {
    name: 'list_workflow_triggers',
    description:
      'List event-based workflow triggers. Optionally filter by workflow.',
    input_schema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string', description: 'Filter by workflow ID' },
      },
      required: [],
    },
  },
  {
    name: 'create_workflow_trigger',
    description:
      'Create an event-based trigger that auto-runs a workflow. Confirm first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string', description: 'The workflow to trigger' },
        name: { type: 'string', description: 'Trigger name' },
        trigger_event: {
          type: 'string',
          enum: ['task_completed', 'task_failed', 'task_needs_approval', 'task_approved', 'task_rejected', 'human_task_completed', 'task_handoff', 'email_received', 'contact_created'],
          description: 'Event that fires the trigger',
        },
        conditions: { type: 'object', description: 'Optional conditions for the trigger' },
        cooldown_seconds: { type: 'number', description: 'Minimum seconds between trigger fires' },
        enabled: { type: 'boolean', description: 'Whether the trigger is active (default true)' },
      },
      required: ['workflow_id', 'name', 'trigger_event'],
    },
  },
  {
    name: 'update_workflow_trigger',
    description:
      'Update a workflow trigger (enable/disable, change event, reconfigure).',
    input_schema: {
      type: 'object' as const,
      properties: {
        trigger_id: { type: 'string', description: 'The trigger ID' },
        name: { type: 'string' },
        enabled: { type: 'boolean' },
        trigger_event: { type: 'string', enum: ['task_completed', 'task_failed', 'task_needs_approval', 'task_approved', 'task_rejected', 'human_task_completed', 'task_handoff', 'email_received', 'contact_created'] },
        conditions: { type: 'object' },
        cooldown_seconds: { type: 'number' },
        workflow_id: { type: 'string' },
      },
      required: ['trigger_id'],
    },
  },
  {
    name: 'delete_workflow_trigger',
    description:
      'Delete a workflow trigger. Always confirm first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        trigger_id: { type: 'string', description: 'The trigger ID' },
      },
      required: ['trigger_id'],
    },
  },
  {
    name: 'get_agent_schedules',
    description:
      'Get all cron schedules for agents and workflows.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'update_agent_schedule',
    description:
      'Update an existing cron schedule by schedule_id. For new schedules, prefer using propose_automation with trigger_type="schedule" and a run_agent step instead. Only use this to update existing standalone schedules.',
    input_schema: {
      type: 'object' as const,
      properties: {
        schedule_id: { type: 'string', description: 'Existing schedule ID to update' },
        agent_id: { type: 'string', description: 'Agent ID for new schedule' },
        workflow_id: { type: 'string', description: 'Workflow ID for new schedule' },
        cron: { type: 'string', description: 'Cron expression (e.g., "0 9 * * *")' },
        enabled: { type: 'boolean', description: 'Whether schedule is enabled' },
        label: { type: 'string', description: 'Optional label' },
        task_prompt: { type: 'string', description: 'What the agent should do when fired' },
      },
      required: ['cron'],
    },
  },
  // Project management tools
  {
    name: 'list_projects',
    description:
      'Get all projects with their progress.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['active', 'completed', 'archived'] },
      },
      required: [],
    },
  },
  {
    name: 'create_project',
    description:
      'Create a new project. Confirm first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Project name' },
        description: { type: 'string', description: 'Optional description' },
        color: { type: 'string', description: 'Optional hex color' },
        due_date: { type: 'string', description: 'Optional due date (ISO 8601)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_project',
    description:
      'Update a project\'s details or status.',
    input_schema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'string', description: 'The project ID' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['active', 'completed', 'archived'] },
        color: { type: 'string' },
        due_date: { type: 'string' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'get_project_board',
    description:
      'Get a project\'s Kanban board — tasks grouped by column.',
    input_schema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'string', description: 'The project ID' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'move_task_column',
    description:
      'Move a task to a different board column.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'The task ID' },
        board_column: { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'review', 'done'] },
      },
      required: ['task_id', 'board_column'],
    },
  },
  // Goal management tools
  {
    name: 'list_goals',
    description:
      'Get all strategic goals with their progress.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['active', 'completed', 'paused', 'archived'] },
      },
      required: [],
    },
  },
  {
    name: 'create_goal',
    description:
      'Create a new strategic goal. Confirm first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'The goal title' },
        description: { type: 'string', description: 'Why this goal matters' },
        target_metric: { type: 'string', description: 'Metric name (e.g., "MRR")' },
        target_value: { type: 'number', description: 'Target value' },
        current_value: { type: 'number', description: 'Current value' },
        unit: { type: 'string', description: 'Unit (e.g., "$", "%")' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        due_date: { type: 'string', description: 'Target date (ISO 8601)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_goal',
    description:
      'Update a goal\'s details, status, or metric progress.',
    input_schema: {
      type: 'object' as const,
      properties: {
        goal_id: { type: 'string', description: 'The goal ID' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['active', 'completed', 'paused', 'archived'] },
        current_value: { type: 'number' },
        target_value: { type: 'number' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      },
      required: ['goal_id'],
    },
  },
  {
    name: 'link_task_to_goal',
    description:
      'Link a task to a strategic goal for business context.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'The task ID' },
        goal_id: { type: 'string', description: 'The goal ID (empty to unlink)' },
      },
      required: ['task_id', 'goal_id'],
    },
  },
  {
    name: 'link_project_to_goal',
    description:
      'Link a project to a strategic goal.',
    input_schema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'string', description: 'The project ID' },
        goal_id: { type: 'string', description: 'The goal ID (empty to unlink)' },
      },
      required: ['project_id', 'goal_id'],
    },
  },
  // Agent state tools (cross-task persistence)
  {
    name: 'get_agent_state',
    description:
      'Read a persistent state value for an agent. State persists across task runs, enabling agents to track counters, progress, or structured data over time.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'The agent whose state to read' },
        key: { type: 'string', description: 'The state key to retrieve' },
        scope: { type: 'string', enum: ['agent', 'goal', 'schedule'], description: 'State scope. Default: "agent"' },
        scope_id: { type: 'string', description: 'Scope ID (goal or schedule ID) when scope is not "agent"' },
      },
      required: ['agent_id', 'key'],
    },
  },
  {
    name: 'set_agent_state',
    description:
      'Save a persistent state value for an agent. The value will be available in future task runs. Use for counters, progress tracking, structured data, etc. ' +
      'Pass ttl_seconds to expire the value automatically (e.g. 3600 for one hour). Keys matching incident_*, *_health_*, temp_*, scratch_* expire after 24h by default.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'The agent whose state to update' },
        key: { type: 'string', description: 'The state key to store' },
        value: { description: 'The value to store (string, number, boolean, array, or object)' },
        scope: { type: 'string', enum: ['agent', 'goal', 'schedule'], description: 'State scope. Default: "agent"' },
        scope_id: { type: 'string', description: 'Scope ID (goal or schedule ID) when scope is not "agent"' },
        ttl_seconds: { type: 'number', description: 'Optional expiry. Positive integer = expire after N seconds. 0 or negative = persistent (no expiry). Omit to use the key-shape default.' },
      },
      required: ['agent_id', 'key', 'value'],
    },
  },
  {
    name: 'list_agent_state',
    description:
      'List all persistent state keys and values for an agent. Shows what data the agent has stored across task runs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'The agent whose state to list' },
        scope: { type: 'string', enum: ['agent', 'goal', 'schedule'], description: 'Filter by scope' },
        scope_id: { type: 'string', description: 'Filter by scope ID' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'delete_agent_state',
    description:
      'Delete a persistent state key for an agent.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'The agent whose state to modify' },
        key: { type: 'string', description: 'The state key to delete' },
        scope: { type: 'string', enum: ['agent', 'goal', 'schedule'], description: 'State scope. Default: "agent"' },
        scope_id: { type: 'string', description: 'Scope ID (goal or schedule ID) when scope is not "agent"' },
      },
      required: ['agent_id', 'key'],
    },
  },
  {
    name: 'clear_agent_state',
    description:
      'Bulk-delete state rows by key prefix. Use to purge polluted or stale state ' +
      '(e.g. clear every incident_* row when an incident is resolved). If agent_id is ' +
      'omitted, clears across every agent in the workspace. key_prefix is required to ' +
      'prevent accidental "delete everything."',
    input_schema: {
      type: 'object' as const,
      properties: {
        key_prefix: { type: 'string', description: 'Required. Match keys starting with this prefix.' },
        agent_id: { type: 'string', description: 'Optional. Limit purge to one agent. Omit for workspace-wide.' },
        scope: { type: 'string', enum: ['agent', 'goal', 'schedule'], description: 'Optional scope filter.' },
        scope_id: { type: 'string', description: 'Optional scope ID filter.' },
      },
      required: ['key_prefix'],
    },
  },
  // A2A tools
  {
    name: 'list_a2a_connections',
    description:
      'List all A2A connections with their status, trust level, and skills.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'send_a2a_task',
    description:
      'Send a task to an external agent via A2A connection. Always confirm first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'The A2A connection ID' },
        message: { type: 'string', description: 'Task message for the external agent' },
      },
      required: ['connection_id', 'message'],
    },
  },
  {
    name: 'test_a2a_connection',
    description:
      'Health-check an A2A connection to verify the external agent is reachable.',
    input_schema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'The A2A connection ID' },
      },
      required: ['connection_id'],
    },
  },
  // Peer tools
  {
    name: 'list_peers',
    description:
      'List all peered workspaces with their connection status and capabilities.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'delegate_to_peer',
    description:
      'Send a task to an agent on a peered workspace. The task runs on the peer and returns a result.',
    input_schema: {
      type: 'object' as const,
      properties: {
        peer_id: { type: 'string', description: 'The peer workspace ID' },
        agent_id: { type: 'string', description: 'The agent ID on the peer workspace' },
        prompt: { type: 'string', description: 'Task instructions for the agent' },
        project_id: { type: 'string', description: 'Optional project ID on the peer' },
      },
      required: ['peer_id', 'agent_id', 'prompt'],
    },
  },
  {
    name: 'ask_peer',
    description:
      'Chat with a peered workspace\'s orchestrator. Ask questions about its status, running tasks, or coordinate work.',
    input_schema: {
      type: 'object' as const,
      properties: {
        peer_id: { type: 'string', description: 'The peer workspace ID' },
        message: { type: 'string', description: 'Message to send to the peer orchestrator' },
      },
      required: ['peer_id', 'message'],
    },
  },
  {
    name: 'list_peer_agents',
    description:
      'List all agents available on a peered workspace.',
    input_schema: {
      type: 'object' as const,
      properties: {
        peer_id: { type: 'string', description: 'The peer workspace ID' },
      },
      required: ['peer_id'],
    },
  },
  // WhatsApp tools
  {
    name: 'connect_whatsapp',
    description:
      'Link WhatsApp by scanning a QR code. Only needed when WhatsApp is not connected yet.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'disconnect_whatsapp',
    description:
      'Disconnect from WhatsApp. Closes the active session.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_whatsapp_status',
    description:
      'Check the current WhatsApp connection status, phone number, and allowed chat count without listing all chats.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'update_whatsapp_chat',
    description:
      'Update the display name of an allowed WhatsApp chat. Accepts a contact name, phone digits, or full JID to identify the chat.',
    input_schema: {
      type: 'object' as const,
      properties: {
        chat_id: { type: 'string', description: 'The chat to update: a contact name, phone digits, or full JID' },
        name: { type: 'string', description: 'The new display name for the chat' },
      },
      required: ['chat_id', 'name'],
    },
  },
  {
    name: 'send_whatsapp_message',
    description:
      'Send a WhatsApp message. Accepts a contact name (e.g. "Mom"), phone digits (e.g. "5551234567"), or full JID. Automatically adds the number to contacts if needed. For media, provide a file path. For multi-number workspaces, optionally specify which connection to send from.',
    input_schema: {
      type: 'object' as const,
      properties: {
        chat_id: { type: 'string', description: 'The recipient: a contact name (e.g. "Mom"), phone digits (e.g. "5551234567"), or full JID' },
        message: { type: 'string', description: 'The message text to send (required for text messages, optional caption for media)' },
        media_path: { type: 'string', description: 'Absolute path to a file to send (image, document, audio, or video). When provided, message becomes the caption.' },
        connection_id: { type: 'string', description: 'Optional: send from a specific WhatsApp connection (use list_whatsapp_connections to see IDs)' },
        from_number: { type: 'string', description: 'Optional: send from the connection matching this phone number' },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'list_whatsapp_chats',
    description:
      'List allowed WhatsApp chats and the current connection status.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_whatsapp_connections',
    description:
      'List all WhatsApp connections in the workspace, showing phone number, label, status, and chat count per connection. Useful when the workspace has multiple WhatsApp numbers.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'add_whatsapp_chat',
    description:
      'Add a phone number to the WhatsApp allowed chats list. After adding, messages can be sent to this chat.',
    input_schema: {
      type: 'object' as const,
      properties: {
        phone_number: { type: 'string', description: 'Phone number to add (digits only or full JID like 1234567890@s.whatsapp.net)' },
        name: { type: 'string', description: 'Optional display name for the chat' },
        type: { type: 'string', enum: ['individual', 'group'], description: 'Chat type (default: individual)' },
      },
      required: ['phone_number'],
    },
  },
  {
    name: 'remove_whatsapp_chat',
    description:
      'Remove a chat from the WhatsApp allowed list. Accepts a contact name, phone digits, or full JID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        chat_id: { type: 'string', description: 'The chat to remove: a contact name (e.g. "Mom"), phone digits, or full JID' },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'get_whatsapp_messages',
    description:
      'Retrieve WhatsApp message history. Filter by contact, date range, keyword search, or any combination.',
    input_schema: {
      type: 'object' as const,
      properties: {
        chat_id: { type: 'string', description: 'Contact name, phone digits, or JID. Omit for all chats.' },
        since: { type: 'string', description: 'Start date/time ISO format (e.g. "2026-03-06")' },
        until: { type: 'string', description: 'End date/time ISO format. Defaults to now.' },
        limit: { type: 'number', description: 'Max messages (default 100, max 500)' },
        include_replies: { type: 'boolean', description: 'Include assistant replies (default false)' },
        search: { type: 'string', description: 'Search keyword to filter messages by content (case-insensitive)' },
      },
      required: [],
    },
  },
  // Telegram tools
  {
    name: 'send_telegram_message',
    description:
      'Send a message to a Telegram chat via the connected bot. For multi-bot workspaces, optionally specify which bot to send from.',
    input_schema: {
      type: 'object' as const,
      properties: {
        chat_id: { type: 'string', description: 'The Telegram chat ID' },
        message: { type: 'string', description: 'The message text to send' },
        connection_id: { type: 'string', description: 'Optional: send from a specific Telegram bot connection (use list_telegram_connections to see IDs)' },
        bot_username: { type: 'string', description: 'Optional: send from the bot matching this username (e.g. "company_bot")' },
      },
      required: ['chat_id', 'message'],
    },
  },
  {
    name: 'list_telegram_chats',
    description:
      'Get the Telegram bot connection status.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_telegram_connections',
    description:
      'List all Telegram bot connections in the workspace, showing bot username, label, status per connection. Useful when the workspace has multiple Telegram bots.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  // Business intelligence tools
  {
    name: 'get_business_pulse',
    description:
      'Get a deep business analytics snapshot: tasks (today/week/30d), contacts by type, revenue trend, agent utilization, streak days. Use for detailed performance analysis beyond the embedded pulse.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_body_state',
    description:
      'Get system health: organ status (which integrations are active), agent performance (recent success rates), memory pressure, task pipeline status, and cost trajectory. Use to understand overall system health.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_contact_pipeline',
    description:
      'Get sales funnel data: contacts by type (lead/customer/partner), recently added, stale leads with no activity in 14 days, and recent activity breakdown. Use when discussing sales, leads, or customer growth.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_daily_reps_status',
    description:
      'Get today\'s daily reps progress: tasks completed, contact touchpoints, approvals processed — each vs recommended minimums. Includes completion rate % and streak days. Use when the user asks about daily progress or what to do next.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  // CRM tools
  {
    name: 'list_contacts',
    description:
      'List contacts in the local CRM. Can filter by type and status.',
    input_schema: {
      type: 'object' as const,
      properties: {
        contact_type: { type: 'string', enum: ['lead', 'customer', 'partner', 'other'] },
        status: { type: 'string', enum: ['active', 'inactive'] },
        limit: { type: 'number', description: 'Max contacts to return (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'create_contact',
    description:
      'Create a new contact in the local CRM. Confirm details before creating.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Contact name' },
        email: { type: 'string', description: 'Email address' },
        phone: { type: 'string', description: 'Phone number' },
        company: { type: 'string', description: 'Company name' },
        contact_type: { type: 'string', enum: ['lead', 'customer', 'partner', 'other'] },
        notes: { type: 'string', description: 'Additional notes' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_contact',
    description:
      'Update an existing contact in the local CRM.',
    input_schema: {
      type: 'object' as const,
      properties: {
        contact_id: { type: 'string', description: 'The contact ID' },
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        company: { type: 'string' },
        contact_type: { type: 'string', enum: ['lead', 'customer', 'partner', 'other'] },
        status: { type: 'string', enum: ['active', 'inactive'] },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'log_contact_event',
    description:
      'Log an event for a contact (call, email, meeting, note).',
    input_schema: {
      type: 'object' as const,
      properties: {
        contact_id: { type: 'string', description: 'The contact ID' },
        event_type: { type: 'string', description: 'Type of event (e.g., call, email, meeting, note)' },
        title: { type: 'string', description: 'Event title' },
        description: { type: 'string', description: 'Event details' },
      },
      required: ['contact_id', 'event_type', 'title'],
    },
  },
  {
    name: 'search_contacts',
    description:
      'Search contacts by name, email, or company.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  // Scraping tools
  {
    name: 'scrape_url',
    description:
      'Fetch and extract content from a URL. Automatically tries fast HTTP first, then stealth (anti-bot bypass), then full browser rendering. Use when the user wants to read or extract info from a web page.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL to scrape' },
        selector: { type: 'string', description: 'Optional CSS selector to extract specific elements' },
        format: { type: 'string', enum: ['html', 'markdown', 'text'], description: 'Output format (default: markdown)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'scrape_bulk',
    description:
      'Fetch multiple URLs at once and return combined results. Use for comparing pages or collecting data from several sources.',
    input_schema: {
      type: 'object' as const,
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'URLs to scrape (max 20)',
        },
        selector: { type: 'string', description: 'Optional CSS selector to extract from each page' },
        format: { type: 'string', enum: ['html', 'markdown', 'text'], description: 'Output format (default: markdown)' },
      },
      required: ['urls'],
    },
  },
  {
    name: 'scrape_search',
    description:
      'Search the web for a query and scrape the top results for detailed content. Goes deeper than a simple web search by fetching and reading each result page.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The search query' },
        max_results: { type: 'number', description: 'Max pages to scrape (default: 5, max: 10)' },
      },
      required: ['query'],
    },
  },
  // Research
  {
    name: 'deep_research',
    description:
      'Conduct deep research on a topic. Generates multiple search queries, searches the web, and synthesizes findings into a structured report with citations.',
    input_schema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string', description: 'The research question to investigate' },
        depth: {
          type: 'string',
          enum: ['quick', 'thorough', 'comprehensive'],
          description: 'Research depth: quick (2 queries), thorough (4 queries, default), comprehensive (6 queries)',
        },
      },
      required: ['question'],
    },
  },
  // Audio transcription
  {
    name: 'transcribe_audio',
    description:
      'Transcribe audio to text using the best available speech-to-text provider (Voicebox Whisper, Gemma Audio, or OpenAI Whisper). Optionally analyze the transcript with a follow-up prompt. IMPORTANT: Only call this when you have actual base64-encoded audio data to process.',
    input_schema: {
      type: 'object' as const,
      properties: {
        audio_base64: {
          type: 'string',
          minLength: 100,
          description: 'Base64-encoded audio data (WAV, MP3, OGG, WebM, or M4A). Must be real audio file data, not a placeholder.',
        },
        language: {
          type: 'string',
          description: 'Language hint for transcription accuracy (e.g., "en", "es", "fr"). Optional.',
        },
        prompt: {
          type: 'string',
          description: 'Optional analysis prompt applied to the transcript after transcription. Use for summarizing, extracting action items, translating, or any other processing.',
        },
      },
      required: ['audio_base64'],
    },
  },
  // Meeting listener tools
  {
    name: 'start_meeting_listener',
    description:
      'Start listening to a meeting via system audio capture. Captures audio from Zoom, Teams, or all system audio, transcribes in real-time, and builds structured meeting notes (summary, decisions, action items). Notes sync to the cloud dashboard. macOS only, requires screen recording permission on first use.',
    input_schema: {
      type: 'object' as const,
      properties: {
        app: {
          type: 'string',
          enum: ['zoom', 'teams', 'meet', 'all'],
          description: 'Which app to capture audio from. "all" captures all system audio. Default: "all".',
        },
      },
      required: [],
    },
  },
  {
    name: 'stop_meeting_listener',
    description:
      'Stop the active meeting listener. Triggers a final comprehensive analysis pass that produces a complete meeting summary with decisions, action items, open questions, and key quotes. Returns the full structured notes.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_meeting_notes',
    description:
      'Get the current running notes from an active or recently completed meeting session. Returns the latest summary, key points, decisions, action items, and open questions accumulated so far.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  // Internet tools (zero-cost, zero-config)
  {
    name: 'youtube_transcript',
    description:
      'Extract the transcript or subtitles from a YouTube video. Returns timestamped text content. Useful for summarizing, researching, or quoting video content without watching it. Requires yt-dlp installed locally.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'YouTube video URL' },
        language: { type: 'string', description: 'Subtitle language code (default: en)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'read_rss_feed',
    description:
      'Parse an RSS or Atom feed URL and return recent entries. Use for monitoring blogs, news sites, changelogs, podcast feeds, or any site with an RSS feed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'RSS or Atom feed URL' },
        limit: { type: 'number', description: 'Max entries to return (default 20, max 50)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'github_search',
    description:
      'Search GitHub for repositories, issues, pull requests, or code. Use for finding libraries, researching how others solved a problem, or tracking issues. Requires gh CLI installed and authenticated.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (supports GitHub search syntax)' },
        type: {
          type: 'string',
          enum: ['repos', 'issues', 'prs', 'code'],
          description: 'What to search for (default: repos)',
        },
        limit: { type: 'number', description: 'Max results to return (default 10, max 30)' },
      },
      required: ['query'],
    },
  },
  // OCR
  {
    name: 'ocr_extract_text',
    description:
      'Extract text from an image or PDF using the local OCR model. Supports documents, screenshots, photos of text, tables, receipts, and multi-page PDFs. Provide either image_base64 or pdf_base64 (not both). Requires the OCR model (DeepSeek OCR) to be downloaded via Ollama. IMPORTANT: Only call this when you have actual base64-encoded file data to process. If the user asks whether you can process files, answer conversationally instead of calling this tool.',
    input_schema: {
      type: 'object' as const,
      properties: {
        image_base64: { type: 'string', minLength: 100, description: 'Base64-encoded image data (PNG, JPEG, WebP, or GIF). Must be real base64 file data, not a placeholder. Use this OR pdf_base64.' },
        pdf_base64: { type: 'string', minLength: 100, description: 'Base64-encoded PDF file. Must be real base64 file data, not a placeholder. Each page is converted to an image and OCR\'d separately. Use this OR image_base64.' },
        max_pages: { type: 'number', description: 'Maximum number of PDF pages to process (default: 20). Ignored for images.' },
        output_format: {
          type: 'string',
          enum: ['text', 'markdown', 'json'],
          description: 'Output format: text (plain text), markdown (structured with headings/tables), json (structured fields). Default: markdown.',
        },
      },
      required: [],
    },
  },

  {
    name: 'analyze_image',
    description:
      'Analyze an image using the best available vision model (dedicated OCR model, vision-capable local model, or Claude). Describe images, identify objects, analyze screenshots, or answer specific questions about image content. IMPORTANT: Only call this when you have actual base64-encoded image data. If the user asks whether you can analyze images, answer conversationally.',
    input_schema: {
      type: 'object' as const,
      properties: {
        image_base64: { type: 'string', minLength: 100, description: 'Base64-encoded image data (PNG, JPEG, WebP, or GIF). Must be real base64 file data, not a placeholder.' },
        analysis_type: {
          type: 'string',
          enum: ['describe', 'objects', 'screenshot', 'general'],
          description: 'Type of analysis: describe (detailed description), objects (list objects/elements), screenshot (analyze UI/app screenshot), general (default overview).',
        },
        prompt: { type: 'string', description: 'Custom prompt for specific questions about the image. Overrides analysis_type when provided.' },
      },
      required: ['image_base64'],
    },
  },

  // ─── Sub-Orchestrator ──────────────────────────────────────────────────────
  {
    name: 'delegate_subtask',
    description:
      'Delegate a focused subtask to a lightweight sub-orchestrator. Use for multi-step research, data gathering, or analysis that would bloat your context. The sub-orchestrator runs its own tool loop and returns only a summary.',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'Clear description of the subtask to complete' },
        focus: {
          type: 'string',
          enum: ['research', 'agents', 'crm', 'projects', 'data'],
          description: 'Focus area: determines which tools the sub-orchestrator can use',
        },
      },
      required: ['prompt', 'focus'],
    },
  },

  // ─── Sequential Multi-Agent ──────────────────────────────────────────────
  {
    name: 'run_sequence',
    description:
      'Run a multi-agent Sequential chain: agents process in order, each seeing what predecessors actually produced. Use when a task benefits from multiple perspectives (research → analysis → synthesis). The system decides which agents participate and in what order.',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'The task to accomplish through multi-agent coordination' },
        agent_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: specific agent IDs to include. If omitted, the system selects relevant agents automatically.',
        },
      },
      required: ['prompt'],
    },
  },

  // ─── Co-Evolution ────────────────────────────────────────────────────────
  {
    name: 'evolve_task',
    description:
      'Run a co-evolution session: multiple agents independently attempt the same task across multiple rounds, each building on the best prior attempts and scored by an evaluator. Use this instead of run_agent when the user asks to "evolve", "iterate", "refine", "improve", or "optimize" something, OR when the task is creative/strategic (strategy, positioning, writing, proposals, pitches, analysis) and would benefit from diverse expert perspectives competing to produce the best version. Returns the highest-scoring deliverable.',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'The task or objective for agents to co-evolve a solution for' },
        agent_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: specific agent IDs to include (min 2). If omitted, active agents are selected automatically.',
        },
        max_rounds: {
          type: 'number',
          description: 'Maximum evolution rounds (default 3). More rounds = higher quality but more cost.',
        },
      },
      required: ['prompt'],
    },
  },

  // ─── Automation Builder Tools ─────────────────────────────────────────────
  {
    name: 'discover_capabilities',
    description:
      'Survey the workspace to discover what agents, triggers, step types, and channels are available for building an automation. Call this FIRST when the user describes an automation intent.',
    input_schema: {
      type: 'object' as const,
      properties: {
        intent: {
          type: 'string',
          description: 'The user\'s automation intent in natural language',
        },
      },
      required: ['intent'],
    },
  },
  {
    name: 'propose_automation',
    description:
      'Propose a complete automation for the user to review. Always call discover_capabilities first, then ask clarifying questions, then call this.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Short name for the automation' },
        description: { type: 'string', description: 'What this automation does' },
        reasoning: {
          type: 'string',
          description: 'Your reasoning for this design. Shown to the user as a "Thinking" section.',
        },
        trigger: {
          type: 'object',
          description: 'The trigger that starts this automation',
          properties: {
            type: { type: 'string', enum: ['webhook', 'schedule', 'event', 'manual'] },
            config: { type: 'object', description: 'Trigger configuration' },
          },
          required: ['type'],
        },
        steps: {
          type: 'array',
          description: 'Ordered list of automation steps',
          items: {
            type: 'object',
            properties: {
              step_type: {
                type: 'string',
                enum: [
                  'agent_prompt', 'a2a_call', 'run_agent', 'save_contact', 'update_contact',
                  'log_contact_event', 'webhook_forward', 'transform_data', 'conditional',
                  'create_task', 'send_notification', 'fill_pdf', 'save_attachment',
                  'take_screenshot', 'generate_chart',
                ],
              },
              label: { type: 'string', description: 'Human-readable label' },
              agent_id: { type: 'string' },
              agent_name: { type: 'string' },
              prompt: { type: 'string' },
              action_config: { type: 'object' },
              required_integrations: { type: 'array', items: { type: 'string' } },
            },
            required: ['step_type', 'label'],
          },
        },
        variables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              default_value: { type: 'string' },
            },
            required: ['name', 'description'],
          },
        },
      },
      required: ['name', 'description', 'reasoning', 'trigger', 'steps'],
    },
  },
  {
    name: 'create_automation',
    description:
      'Create and save an automation directly. Use this after propose_automation when the user confirms they want to create it (e.g. says "yes", "create it", "looks good"). This saves the automation immediately without requiring a UI approval step.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Short name for the automation' },
        description: { type: 'string', description: 'What this automation does' },
        trigger: {
          type: 'object',
          description: 'The trigger that starts this automation',
          properties: {
            type: { type: 'string', enum: ['webhook', 'schedule', 'event', 'manual'], description: 'Trigger type' },
            config: { type: 'object', description: 'Trigger configuration (e.g., cron expression, event type)' },
          },
          required: ['type'],
        },
        steps: {
          type: 'array',
          description: 'Ordered list of automation steps (same format as propose_automation)',
          items: {
            type: 'object',
            properties: {
              step_type: {
                type: 'string',
                enum: [
                  'agent_prompt', 'a2a_call', 'run_agent', 'save_contact', 'update_contact',
                  'log_contact_event', 'webhook_forward', 'transform_data', 'conditional',
                  'create_task', 'send_notification', 'fill_pdf', 'save_attachment',
                  'take_screenshot', 'generate_chart',
                ],
                description: 'Type of step',
              },
              label: { type: 'string', description: 'Human-readable label for this step' },
              agent_id: { type: 'string', description: 'Agent ID (for agent_prompt/run_agent steps)' },
              agent_name: { type: 'string', description: 'Agent name (for display)' },
              prompt: { type: 'string', description: 'Task prompt for the agent' },
              action_config: { type: 'object', description: 'All step settings' },
              required_integrations: {
                type: 'array',
                items: { type: 'string' },
                description: 'Integration providers this step requires',
              },
            },
            required: ['step_type', 'label'],
          },
        },
        variables: {
          type: 'array',
          description: 'Optional automation variables',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              default_value: { type: 'string' },
            },
            required: ['name', 'description'],
          },
        },
      },
      required: ['name', 'description', 'trigger', 'steps'],
    },
  },

  // Agent suggestions
  {
    name: 'get_agent_suggestions',
    description:
      'Analyze the workspace for capability gaps and suggest new agents. If refresh is true, runs a fresh analysis; otherwise returns cached suggestions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        refresh: { type: 'boolean', description: 'Run fresh analysis (default false, returns cached)' },
      },
      required: [],
    },
  },

  // Agent onboarding / setup
  {
    name: 'list_available_presets',
    description:
      'Browse the agent preset catalog. Returns available agent templates grouped by business type. Use this during initial workspace setup to see what agents can be created. If business_type is provided, returns only agents for that type.',
    input_schema: {
      type: 'object' as const,
      properties: {
        business_type: {
          type: 'string',
          description: 'Filter by business type (e.g. "saas_startup", "ecommerce", "agency", "content_creator", "service_business", "consulting", "tech_company"). Omit to see all types.',
        },
      },
      required: [],
    },
  },
  {
    name: 'setup_agents',
    description:
      'Create AI agents from the preset catalog. Call this after discussing with the user which agents they need. Pass the preset IDs from list_available_presets. Only use during initial workspace setup when the user has no agents yet.',
    input_schema: {
      type: 'object' as const,
      properties: {
        preset_ids: {
          type: 'array',
          description: 'Array of preset agent IDs to create (e.g. ["saas_content_writer", "saas_data_analyst"])',
          items: { type: 'string' },
        },
        business_type: {
          type: 'string',
          description: 'Business type to scope the presets (optional, helps resolve IDs)',
        },
      },
      required: ['preset_ids'],
    },
  },
  {
    name: 'bootstrap_workspace',
    description:
      'Set up the full workspace in one call: creates a goal, AI agents from presets, and their automations/schedules. Use this during initial onboarding after understanding the user\'s goal and pain points. Prefer this over setup_agents when a goal has been identified.',
    input_schema: {
      type: 'object' as const,
      properties: {
        goal_title: {
          type: 'string',
          description: 'The user\'s primary business goal (e.g. "Grow content presence and generate consistent leads")',
        },
        goal_description: {
          type: 'string',
          description: 'Optional longer description of the goal',
        },
        goal_metric: {
          type: 'string',
          description: 'Optional metric to track (e.g. "leads_per_month", "revenue", "blog_posts")',
        },
        goal_target: {
          type: 'number',
          description: 'Optional target value for the metric (e.g. 50)',
        },
        goal_unit: {
          type: 'string',
          description: 'Optional unit for the metric (e.g. "leads", "USD", "posts")',
        },
        preset_ids: {
          type: 'array',
          description: 'Array of agent preset IDs to create',
          items: { type: 'string' },
        },
        business_type: {
          type: 'string',
          description: 'Business type to scope the presets',
        },
      },
      required: ['goal_title', 'preset_ids'],
    },
  },

  ...MEDIA_TOOL_DEFINITIONS,
  ...KNOWLEDGE_TOOL_DEFINITIONS,
  ...WIKI_TOOL_DEFINITIONS,

  // =========================================================================
  // X / TWITTER POSTING TOOLS
  // =========================================================================
  // These tools drive the user's real Chrome (via CDP) to type and
  // publish posts to x.com. No API key, no cloud proxy: the browser
  // session is the user's own, so posts go out from their account
  // exactly as if they typed them by hand. Default dry_run=true so
  // accidental calls never publish.
  {
    name: 'x_compose_tweet',
    description: 'Compose a single tweet (≤280 chars) on x.com by driving the user\'s real logged-in Chrome. Navigates to the compose modal, types the text, and optionally publishes. DEFAULTS TO DRY RUN: the tool types the text into compose but does NOT click Post unless you explicitly pass dry_run=false. Use this for short posts. Use x_compose_thread for multi-tweet threads.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description: 'The tweet text, verbatim, ≤280 characters. Will be typed exactly as provided.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true (default), types the text in compose and screenshots it but does NOT publish. Set to false to actually publish. Always dry-run first unless the user explicitly asked to publish.',
        },
        profile: {
          type: 'string',
          description: 'Chrome profile to use for the real logged-in session. Accepts an email (e.g. "ogsus@ohwow.fun") or a profile directory name. Defaults to the owner\'s profile.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'x_compose_thread',
    description: 'Compose a multi-tweet thread on x.com by driving the user\'s real logged-in Chrome. Opens the compose modal once, types each tweet in sequence, chains them via the "Add another post" button, and optionally publishes them all. DEFAULTS TO DRY RUN. Use this for launch threads, countdown threads, and any multi-tweet content where each segment is ≤280 chars.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tweets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of tweet strings, in order. Each ≤280 chars. The tool chains them into a thread.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true (default), composes the thread in the modal and screenshots it but does NOT publish. Set to false to publish all tweets in one shot.',
        },
        profile: {
          type: 'string',
          description: 'Chrome profile to use. Same rules as x_compose_tweet.',
        },
      },
      required: ['tweets'],
    },
  },
  {
    name: 'x_compose_article',
    description: 'Compose a long-form X Article by driving the user\'s real Chrome. Navigates to /compose/articles, clicks Write to create a new draft, types the title and body, and optionally publishes. DEFAULTS TO DRY RUN. Use this for launch blog-style posts (Article #1, Article #2, etc.) where the content is longer than a thread. Requires X Premium on the active account — the tool returns a useful error if Articles is not available for this profile.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Article title. Required.',
        },
        body: {
          type: 'string',
          description: 'Article body markdown/plain text. Minimum 100 characters. The tool types this into the X article editor one character at a time.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true (default), drafts the article but does NOT click Publish. Set to false to actually publish.',
        },
        profile: {
          type: 'string',
          description: 'Chrome profile to use.',
        },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'x_list_dms',
    description: 'List the user\'s X DM inbox by driving the real Chrome. Returns an array of thread summaries with the conversation pair id, the primary correspondent name, a short preview of the last message, and an unread flag. Use this for DM triage: call it first to see what needs attention, then call x_send_dm to reply into a specific thread.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Max number of threads to return. Defaults to 20, capped at 50.',
        },
        profile: { type: 'string', description: 'Chrome profile to use.' },
      },
      required: [],
    },
  },
  {
    name: 'x_send_dm',
    description: 'Send a DM to an existing X conversation by driving the real Chrome. Opens the thread, types the message into the composer, and optionally clicks Send. DEFAULTS TO DRY RUN. Prefer passing conversation_pair (from x_list_dms) for deterministic targeting; handle fallback is best-effort.',
    input_schema: {
      type: 'object' as const,
      properties: {
        conversation_pair: {
          type: 'string',
          description: 'The conversation pair id from x_list_dms (e.g. "<userIdA>:<userIdB>" or "<userIdA>-<userIdB>"). Either this or handle is required.',
        },
        handle: {
          type: 'string',
          description: 'Recipient handle (without @) as a fallback when the pair is unknown. The tool will pick the first inbox thread whose preview mentions this handle — best-effort only.',
        },
        text: {
          type: 'string',
          description: 'Message body. Required.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true (default), types the message into the composer but does NOT click Send. Set to false to send for real.',
        },
        profile: { type: 'string', description: 'Chrome profile to use.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'synthesize_skill_for_goal',
    description: 'Autonomously synthesize a new deterministic TypeScript skill from a goal + target URL. Runs the real generator LLM (no canned fallback) against the strict template, probes the live surface via CDP, writes the file + inserts the skill row, and dry-run-tests the handler with a stub vision verdict. Always dry-run — no live side effects. Use this to teach ohwow a new read-only web skill on its own initiative.',
    input_schema: {
      type: 'object' as const,
      properties: {
        goal: {
          type: 'string',
          description: 'One-sentence description of what the skill should do. Gets copied into the generator prompt as the goal.',
        },
        target_url: {
          type: 'string',
          description: 'Absolute http(s) URL the generated tool will drive. The probe navigates here first.',
        },
        name_hint: {
          type: 'string',
          description: 'Optional human-readable naming hint. The generator LLM is still free to pick its own snake_case name.',
        },
        use_canned_llm: {
          type: 'boolean',
          description: 'Leave false for real-LLM generation. True is not supported by this tool — it has no canned fallback.',
        },
        test_input: {
          type: 'object',
          description: 'Optional input object the dry-run tester hands to the generated skill. Defaults to {} (always combined with dry_run: true). Supply this when the skill has required string parameters that would otherwise break with undefined — e.g. a description field the skill will fill in. Values never leave the browser because the tester always runs in dry-run mode.',
        },
      },
      required: ['goal', 'target_url'],
    },
  },
  {
    name: 'synthesis_run_acceptance',
    description: 'Skills-as-code pipeline end-to-end acceptance run. Given a failed agent_workforce_tasks row id, probes the target URL via CDP, generates a deterministic TypeScript tool with the generator, writes + registers it through the runtime skill loader, runs the dry-run tester (stub vision verdict), and optionally publishes + deletes a real test post to prove the full flow. Opt-in live side effects via publish_live=true + delete_after_publish defaults to true. Deliberately NOT in any intent section — call by explicit name only.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: {
          type: 'string',
          description: 'Row id in agent_workforce_tasks to rebuild the SynthesisCandidate from. Defaults to 580b8cc3e404e5beff83550db3d1cf77 (the launch-eve 408k-token tweet failure).',
        },
        target_url: {
          type: 'string',
          description: 'Absolute URL the generated tool will drive. Probe navigates here first. Defaults to https://x.com/compose/post.',
        },
        test_tweet_text: {
          type: 'string',
          description: 'Body text to type in the composer. Keep under 260 chars so there is room for a trailing unique marker used to clean up after publish.',
        },
        publish_live: {
          type: 'boolean',
          description: 'When true, invokes the synthesized skill with dry_run=false to actually publish a post. Defaults to false (dry-run only).',
        },
        delete_after_publish: {
          type: 'boolean',
          description: 'When publish_live is true, whether to delete the posted tweet via x_delete_tweet after a short settle. Defaults to true for safe acceptance runs that leave no visible footprint.',
        },
        use_canned_llm: {
          type: 'boolean',
          description: 'When true, bypass the real generator LLM and use a pre-baked canned response that mirrors the generator unit test fixture. Useful when the LLM is unavailable or producing unparseable output and you still need to exercise the runtime path.',
        },
        handle: {
          type: 'string',
          description: 'X handle (without @) used for the delete step. Defaults to ohwow_fun.',
        },
      },
      required: ['test_tweet_text'],
    },
  },
  {
    name: 'x_delete_tweet',
    description: 'Delete the user\'s most recent tweet matching a text marker. Used for cleanup after test posts. Opens the profile, finds an article whose text contains the marker, opens its menu, clicks Delete, and confirms. DEFAULTS TO DRY RUN.',
    input_schema: {
      type: 'object' as const,
      properties: {
        handle: {
          type: 'string',
          description: 'Profile handle (without @) to search on. Usually the active account.',
        },
        marker: {
          type: 'string',
          description: 'Unique substring that identifies the tweet to delete. The tool picks the first matching article.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true (default), locates the tweet but does NOT delete it. Set to false to actually delete.',
        },
        profile: { type: 'string', description: 'Chrome profile to use.' },
      },
      required: ['handle', 'marker'],
    },
  },

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

