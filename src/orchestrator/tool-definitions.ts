/**
 * Orchestrator Tool Definitions (Local Runtime)
 * Anthropic tool_use schema for the orchestrator chat.
 * Adapted from web app — removed navigate_user, get_credits, get_integration_status.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';

export const ORCHESTRATOR_TOOL_DEFINITIONS: Tool[] = [
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
      'Save a persistent state value for an agent. The value will be available in future task runs. Use for counters, progress tracking, structured data, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'The agent whose state to update' },
        key: { type: 'string', description: 'The state key to store' },
        value: { description: 'The value to store (string, number, boolean, array, or object)' },
        scope: { type: 'string', enum: ['agent', 'goal', 'schedule'], description: 'State scope. Default: "agent"' },
        scope_id: { type: 'string', description: 'Scope ID (goal or schedule ID) when scope is not "agent"' },
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

  // =========================================================================
  // MEDIA TOOLS
  // =========================================================================

  {
    name: 'generate_slides',
    description:
      'Generate an HTML slide presentation with a given topic and style. Produces a self-contained HTML file with navigation. Each slide has an image placeholder with a data-prompt attribute. After generating, you can create images for each placeholder to enhance the presentation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'Presentation topic or brief' },
        slide_count: { type: 'number', description: 'Number of slides (default 8, max 20)' },
        style: { type: 'string', enum: ['modern', 'minimal', 'corporate', 'creative'], description: 'Visual style theme' },
      },
      required: ['topic'],
    },
  },

  {
    name: 'export_slides_pdf',
    description:
      'Export an HTML slide presentation to PDF. Requires the path to an HTML slides file (from generate_slides). Renders one slide per page in landscape orientation with full styling preserved.',
    input_schema: {
      type: 'object' as const,
      properties: {
        html_path: { type: 'string', description: 'Absolute path to the HTML slides file' },
      },
      required: ['html_path'],
    },
  },

  {
    name: 'generate_music',
    description:
      'Generate music or sound effects from a text description using Google Lyria via OpenRouter. Produces an audio file saved to the media library. Great for background music, jingles, sound effects, ambient soundscapes, and instrumental tracks.',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'Description of the music to generate (e.g. "upbeat lo-fi hip hop beat with soft piano and vinyl crackle")' },
        duration_seconds: { type: 'number', description: 'Duration in seconds (5-30, default 15)' },
        genre: { type: 'string', enum: ['ambient', 'electronic', 'orchestral', 'jazz', 'rock', 'pop', 'lo-fi', 'cinematic', 'folk', 'hip-hop'], description: 'Genre hint' },
        mood: { type: 'string', enum: ['calm', 'energetic', 'dark', 'uplifting', 'melancholic', 'playful', 'dramatic', 'mysterious'], description: 'Mood hint' },
        bpm: { type: 'number', description: 'Tempo in BPM (60-180, optional)' },
      },
      required: ['prompt'],
    },
  },

  {
    name: 'generate_video',
    description:
      'Generate a short video from a text description using video generation models via OpenRouter. Produces an MP4 file saved to the media library. Good for social media clips, product demos, visual concepts, and short animations.',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'Description of the video to generate (e.g. "a golden retriever running through a field of wildflowers at sunset, cinematic, slow motion")' },
        duration_seconds: { type: 'number', description: 'Duration in seconds (2-10, default 4)' },
        aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'], description: 'Aspect ratio (default 16:9)' },
      },
      required: ['prompt'],
    },
  },

  {
    name: 'generate_voice',
    description:
      'Convert text to speech audio. Uses local Kokoro TTS when available (free, fast), otherwise falls back to cloud TTS via OpenRouter. Produces an MP3 file saved to the media library. Great for voiceovers, narration, audio content, and accessibility.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'The text to convert to speech' },
        voice: { type: 'string', description: 'Voice name (e.g. "af_heart", "alloy"). Available voices depend on the provider.' },
        speed: { type: 'number', description: 'Speech speed multiplier (0.5-2.0, default 1.0)' },
      },
      required: ['text'],
    },
  },

  // =========================================================================
  // KNOWLEDGE BASE
  // =========================================================================

  {
    name: 'list_knowledge',
    description:
      'List all knowledge base documents. Shows title, file type, processing status, and size.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Optional: filter by agent ID' },
      },
      required: [],
    },
  },
  {
    name: 'upload_knowledge',
    description:
      'Add a local file to the knowledge base by its absolute file path. Supports TXT, MD, CSV, PDF, DOCX, XLSX, JSON, HTML, XML.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file on disk' },
        title: { type: 'string', description: 'Optional title for the document' },
        agent_id: { type: 'string', description: 'Optional: assign to a specific agent (null = workspace-wide)' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'add_knowledge_from_url',
    description:
      'Scrape a URL and add the extracted text to the knowledge base.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL to scrape' },
        title: { type: 'string', description: 'Optional title for the document' },
        agent_id: { type: 'string', description: 'Optional: assign to a specific agent' },
      },
      required: ['url'],
    },
  },
  {
    name: 'assign_knowledge',
    description:
      'Configure how a knowledge document is used by a specific agent. Can opt an agent out of a workspace-wide doc, or change the injection mode.',
    input_schema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'Knowledge document ID' },
        agent_id: { type: 'string', description: 'Agent ID' },
        opted_out: { type: 'boolean', description: 'If true, agent will not receive this workspace-wide doc' },
        injection_mode: { type: 'string', enum: ['always', 'auto', 'on_demand'], description: 'How the doc is injected into the agent prompt' },
      },
      required: ['document_id', 'agent_id'],
    },
  },
  {
    name: 'delete_knowledge',
    description:
      'Delete a knowledge base document and all its chunks.',
    input_schema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'Knowledge document ID to delete' },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'search_knowledge',
    description: 'Search the knowledge base for content relevant to a query. Uses BM25 retrieval to find the most relevant chunks. Use when asked about specific topics that may have been uploaded to the knowledge base.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What to search for (natural language works)' },
        max_results: { type: 'number', description: 'Max chunks to return (default 5, max 10)' },
      },
      required: ['query'],
    },
  },

  // =========================================================================
  // DATA SOURCE CONNECTOR TOOLS
  // =========================================================================

  {
    name: 'list_connectors',
    description: 'List all configured data source connectors and their sync status. Data source connectors automatically import documents from external systems (GitHub, Google Drive, etc.) into the knowledge base.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'add_connector',
    description: 'Add a new data source connector to import documents into the knowledge base. Supported types: github, local-files, google-drive, notion, slack, confluence, imap.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Connector type (e.g. "github", "local-files")' },
        name: { type: 'string', description: 'Human-readable name for this connector' },
        settings: { type: 'object', description: 'Connector-specific settings (e.g. { "repo": "owner/repo", "token": "..." })' },
        sync_interval_minutes: { type: 'number', description: 'How often to sync (default: 30 minutes)' },
      },
      required: ['type', 'name'],
    },
  },
  {
    name: 'remove_connector',
    description: 'Remove a data source connector by ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        connector_id: { type: 'string', description: 'ID of the connector to remove' },
      },
      required: ['connector_id'],
    },
  },
  {
    name: 'sync_connector',
    description: 'Trigger an immediate sync for a data source connector, importing new or updated documents into the knowledge base.',
    input_schema: {
      type: 'object' as const,
      properties: {
        connector_id: { type: 'string', description: 'ID of the connector to sync' },
      },
      required: ['connector_id'],
    },
  },
  {
    name: 'test_connector',
    description: 'Test connectivity for a data source connector to verify it can reach the external system.',
    input_schema: {
      type: 'object' as const,
      properties: {
        connector_id: { type: 'string', description: 'ID of the connector to test' },
      },
      required: ['connector_id'],
    },
  },

  // =========================================================================
  // PDF FORM TOOLS
  // =========================================================================

  {
    name: 'pdf_inspect_fields',
    description: 'Inspect an AcroForm PDF to list all fillable fields, their types, current values, and available options. Use this before filling a PDF form to understand its structure.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pdf_base64: { type: 'string', description: 'Base64-encoded PDF file to inspect.' },
      },
      required: ['pdf_base64'],
    },
  },
  {
    name: 'pdf_fill_form',
    description: 'Fill out an AcroForm PDF by setting field values. Returns the filled PDF as base64. Use pdf_inspect_fields first to discover field names and types.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pdf_base64: { type: 'string', description: 'Base64-encoded PDF file to fill.' },
        fields: {
          type: 'object',
          description: 'Map of field names to values. For text fields, provide a string. For checkboxes, provide "true" or "false". For dropdowns/radio groups, provide the option value.',
        },
        flatten: {
          type: 'boolean',
          description: 'If true, flatten the form after filling (fields become non-editable). Default: false.',
        },
      },
      required: ['pdf_base64', 'fields'],
    },
  },

  // Cloud data query tools (proxy to cloud DB via control plane)
  {
    name: 'cloud_list_contacts',
    description: 'List contacts from the CLOUD CRM database (not local). Use this when you need the full customer/lead list from the web dashboard.',
    input_schema: { type: 'object' as const, properties: { contact_type: { type: 'string', description: 'Filter: lead, customer, partner' }, search: { type: 'string', description: 'Search by name or email' }, limit: { type: 'number', description: 'Max results (default 50)' } }, required: [] },
  },
  {
    name: 'cloud_list_schedules',
    description: 'List agent schedules from the CLOUD database with cron expressions and last/next run times.',
    input_schema: { type: 'object' as const, properties: { agent_id: { type: 'string', description: 'Filter by agent ID' }, enabled: { type: 'boolean', description: 'Filter by enabled status' } }, required: [] },
  },
  {
    name: 'cloud_list_agents',
    description: 'List all agents from the CLOUD database with full config, stats, and departments.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'cloud_list_tasks',
    description: 'List tasks from the CLOUD database with output, truth scores, and metadata.',
    input_schema: { type: 'object' as const, properties: { agent_id: { type: 'string', description: 'Filter by agent ID' }, status: { type: 'string', description: 'Filter: pending, completed, failed, needs_approval' }, limit: { type: 'number', description: 'Max results (default 50)' } }, required: [] },
  },
  {
    name: 'cloud_get_analytics',
    description: 'Get workspace analytics from the CLOUD: total tasks, agents, contacts, credits, weekly stats.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'cloud_list_members',
    description: 'List workspace members from the CLOUD with roles and profile info.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
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

];

// =========================================================================
// INTENT-BASED TOOL FILTERING
// =========================================================================

export type IntentSection =
  | 'pulse' | 'agents' | 'projects' | 'business' | 'memory' | 'rag'
  | 'vision' | 'filesystem' | 'channels' | 'browser' | 'desktop' | 'project_instructions'
  | 'dev';

/**
 * Maps each tool name to the intent sections where it's relevant.
 * Tools not listed here are included in ALL sections (always available).
 */
const TOOL_SECTION_MAP: Record<string, IntentSection[]> = {
  // Always included (not in map): update_plan

  // Agent/task management → 'agents' section
  list_agents: ['agents'],
  list_tasks: ['agents'],
  get_task_detail: ['agents'],
  get_pending_approvals: ['agents'],
  approve_task: ['agents'],
  reject_task: ['agents'],
  run_agent: ['agents'],
  run_sequence: ['agents'],
  evolve_task: ['agents'],
  spawn_agents: ['agents'],
  await_agent_results: ['agents'],
  queue_task: ['agents'],
  retry_task: ['agents'],
  cancel_task: ['agents'],
  get_agent_suggestions: ['agents'],
  list_available_presets: ['agents'],
  setup_agents: ['agents'],
  bootstrap_workspace: ['agents'],

  // Workspace stats/activity → 'pulse'
  get_workspace_stats: ['pulse'],
  get_activity_feed: ['pulse'],

  // Cloud data tools — NOT in section map so they're always available.
  // (Removing from map = included in every intent section.)

  // Automation builder → 'agents'
  discover_capabilities: ['agents'],
  propose_automation: ['agents'],
  create_automation: ['agents'],

  // Workflows → 'agents' (workflow management is agent-adjacent)
  list_workflows: ['agents'],
  run_workflow: ['agents'],
  get_workflow_detail: ['agents'],
  generate_workflow: ['agents'],
  create_workflow: ['agents'],
  update_workflow: ['agents'],
  delete_workflow: ['agents'],
  list_workflow_triggers: ['agents'],
  create_workflow_trigger: ['agents'],
  update_workflow_trigger: ['agents'],
  delete_workflow_trigger: ['agents'],
  get_agent_schedules: ['agents'],
  update_agent_schedule: ['agents'],

  // Projects/goals → 'projects'
  list_projects: ['projects'],
  create_project: ['projects'],
  update_project: ['projects'],
  get_project_board: ['projects'],
  move_task_column: ['projects'],
  list_goals: ['projects'],
  create_goal: ['projects'],
  update_goal: ['projects'],
  link_task_to_goal: ['projects'],
  link_project_to_goal: ['projects'],
  get_agent_state: ['agents'],
  set_agent_state: ['agents'],
  list_agent_state: ['agents'],
  delete_agent_state: ['agents'],

  // A2A / Peers → 'agents'
  list_a2a_connections: ['agents'],
  send_a2a_task: ['agents'],
  test_a2a_connection: ['agents'],
  list_peers: ['agents'],
  delegate_to_peer: ['agents'],
  ask_peer: ['agents'],
  list_peer_agents: ['agents'],

  // Channels → 'channels'
  connect_whatsapp: ['channels'],
  disconnect_whatsapp: ['channels'],
  get_whatsapp_status: ['channels'],
  update_whatsapp_chat: ['channels'],
  send_whatsapp_message: ['channels'],
  list_whatsapp_chats: ['channels'],
  list_whatsapp_connections: ['channels'],
  add_whatsapp_chat: ['channels'],
  remove_whatsapp_chat: ['channels'],
  get_whatsapp_messages: ['channels'],
  send_telegram_message: ['channels'],
  list_telegram_chats: ['channels'],
  list_telegram_connections: ['channels'],

  // Business intelligence → 'business', 'pulse'
  get_business_pulse: ['business', 'pulse'],
  get_body_state: ['business', 'pulse'],
  get_contact_pipeline: ['business'],
  get_daily_reps_status: ['business', 'pulse'],

  // CRM → 'business' (CRM intent maps to business section tools)
  list_contacts: ['business'],
  create_contact: ['business'],
  update_contact: ['business'],
  log_contact_event: ['business'],
  search_contacts: ['business'],

  // Scraping/research — always available (agents need web access by default)
  // scrape_url, scrape_search, deep_research: removed from map → always included
  scrape_bulk: ['rag', 'browser'],

  // Audio transcription → 'rag', 'vision'
  transcribe_audio: ['rag', 'vision'],

  // Meeting listener → always available (user may ask at any time)
  // start_meeting_listener, stop_meeting_listener, get_meeting_notes: removed from map → always included

  // Internet tools — always available (zero-cost fetch-based, no reason to gate)
  // youtube_transcript, read_rss_feed, github_search: removed from map → always included

  // OCR/vision → 'vision'
  ocr_extract_text: ['vision'],
  analyze_image: ['vision'],

  // Doc mounts → 'rag'
  mount_docs: ['rag'],
  unmount_docs: ['rag'],
  list_doc_mounts: ['rag'],
  search_mounted_docs: ['rag'],

  // Knowledge base → 'rag'
  list_knowledge: ['rag'],
  upload_knowledge: ['rag'],
  add_knowledge_from_url: ['rag'],
  assign_knowledge: ['rag'],
  delete_knowledge: ['rag'],
  search_knowledge: ['rag'],

  // PDF → 'vision' (document processing)
  pdf_inspect_fields: ['vision'],
  pdf_fill_form: ['vision'],

  // Filesystem tools → 'filesystem'
  local_list_directory: ['filesystem'],
  local_read_file: ['filesystem'],
  local_search_files: ['filesystem'],
  local_search_content: ['filesystem'],
  local_write_file: ['filesystem'],
  local_edit_file: ['filesystem'],

  // Bash tools → 'filesystem' (shell access is filesystem-adjacent)
  run_bash: ['filesystem'],

  // File access gateway → 'filesystem'
  request_file_access: ['filesystem'],

  // LSP code intelligence → 'dev' + 'filesystem'
  lsp_diagnostics: ['dev', 'filesystem'],
  lsp_hover: ['dev', 'filesystem'],
  lsp_go_to_definition: ['dev', 'filesystem'],
  lsp_references: ['dev', 'filesystem'],
  lsp_completions: ['dev', 'filesystem'],

  // Browser tools → 'browser'
  request_browser: ['browser'],

  // Desktop tools → 'desktop'
  request_desktop: ['desktop'],

  // Media tools → 'agents' (media generation is agent-adjacent)
  generate_slides: ['agents'],
  export_slides_pdf: ['agents'],
};

/** Always-included tools regardless of intent. */
const ALWAYS_INCLUDED_TOOLS = new Set([
  'update_plan', 'delegate_subtask',
  'cloud_list_contacts', 'cloud_list_schedules', 'cloud_list_agents',
  'cloud_list_tasks', 'cloud_get_analytics', 'cloud_list_members',
]);

/**
 * Tool priority tiers for progressive revelation.
 * P1 = core tools always loaded, P2 = common extensions, P3 = rare/advanced.
 * Tools not listed default to P2 (included unless budget is very tight).
 */
const TOOL_PRIORITY: Record<string, 1 | 2 | 3> = {
  // P1: Core tools per section (3-5 per section)
  run_agent: 1, run_sequence: 2, evolve_task: 2, list_agents: 1, list_tasks: 1, approve_task: 1, get_task_detail: 1,
  local_read_file: 1, local_list_directory: 1, local_write_file: 1, run_bash: 1,
  search_contacts: 1, list_contacts: 1, create_contact: 1,
  get_workspace_stats: 1, get_activity_feed: 1,
  cloud_get_analytics: 1, cloud_list_contacts: 2, cloud_list_schedules: 2, cloud_list_agents: 2, cloud_list_tasks: 2, cloud_list_members: 3,
  request_file_access: 1, request_browser: 1, request_desktop: 1,
  scrape_url: 1, deep_research: 1, mount_docs: 1, list_doc_mounts: 1, unmount_docs: 1, search_mounted_docs: 1,
  send_whatsapp_message: 1, list_whatsapp_chats: 1, connect_whatsapp: 1,
  send_telegram_message: 1, list_telegram_chats: 1,
  ocr_extract_text: 1, analyze_image: 1,
  search_knowledge: 1,
  lsp_diagnostics: 1,

  // P2: Common extensions (default for unlisted tools)
  queue_task: 2, reject_task: 2, retry_task: 2, cancel_task: 2,
  get_pending_approvals: 2, spawn_agents: 2, await_agent_results: 2,
  local_search_files: 2, local_search_content: 2, local_edit_file: 2,
  lsp_hover: 2, lsp_go_to_definition: 2, lsp_references: 2, lsp_completions: 3,
  update_contact: 2, log_contact_event: 2,
  get_business_pulse: 2, get_body_state: 2, get_contact_pipeline: 2, get_daily_reps_status: 2,
  get_whatsapp_status: 2, add_whatsapp_chat: 2, remove_whatsapp_chat: 2,
  get_whatsapp_messages: 2, disconnect_whatsapp: 2, update_whatsapp_chat: 2,
  list_whatsapp_connections: 2, list_telegram_connections: 2,
  discover_capabilities: 2, propose_automation: 2, create_automation: 2,
  list_projects: 2, create_project: 2, list_goals: 2, create_goal: 2,
  scrape_search: 2, list_knowledge: 2,
  get_agent_suggestions: 2,
  transcribe_audio: 2,
  start_meeting_listener: 2, stop_meeting_listener: 2, get_meeting_notes: 2,
  youtube_transcript: 2, read_rss_feed: 2, github_search: 2,

  // P3: Rare/advanced tools
  list_workflows: 3, run_workflow: 3, get_workflow_detail: 3,
  generate_workflow: 3, create_workflow: 3, update_workflow: 3, delete_workflow: 3,
  list_workflow_triggers: 3, create_workflow_trigger: 3, update_workflow_trigger: 3, delete_workflow_trigger: 3,
  get_agent_schedules: 3, update_agent_schedule: 3,
  update_project: 3, get_project_board: 3, move_task_column: 3,
  update_goal: 3, link_task_to_goal: 3, link_project_to_goal: 3,
  get_agent_state: 3, set_agent_state: 3, list_agent_state: 3, delete_agent_state: 3,
  list_a2a_connections: 3, send_a2a_task: 3, test_a2a_connection: 3,
  list_peers: 3, delegate_to_peer: 3, ask_peer: 3, list_peer_agents: 3,
  scrape_bulk: 3, upload_knowledge: 3, add_knowledge_from_url: 3,
  assign_knowledge: 3, delete_knowledge: 3,
  pdf_inspect_fields: 3, pdf_fill_form: 3,
  list_available_presets: 3, setup_agents: 3, bootstrap_workspace: 3,
  generate_slides: 3, export_slides_pdf: 3,
};

/**
 * Determine the maximum tool priority tier based on model size and available context.
 * Smaller models / tighter contexts get fewer tools.
 */
export function getToolPriorityLimit(modelSizeGB: number, availableContextTokens: number): 1 | 2 | 3 {
  if (modelSizeGB < 1.5 || availableContextTokens < 6000) return 1;
  if (modelSizeGB < 5 || availableContextTokens < 12000) return 2;
  return 3;
}

/**
 * Filter tools to only those relevant to the active intent sections.
 * When `maxPriority` is set, additionally filters out tools above that priority tier.
 * Tools not in TOOL_SECTION_MAP or in ALWAYS_INCLUDED_TOOLS are always kept.
 */
export function filterToolsByIntent(tools: Tool[], sections: Set<IntentSection>, maxPriority?: 1 | 2 | 3): Tool[] {
  return tools.filter((t) => {
    if (ALWAYS_INCLUDED_TOOLS.has(t.name)) return true;

    // Priority filter
    if (maxPriority) {
      const priority = TOOL_PRIORITY[t.name] ?? 2; // default to P2
      if (priority > maxPriority) return false;
    }

    const mappedSections = TOOL_SECTION_MAP[t.name];
    if (!mappedSections) return true; // Not mapped → always include
    return mappedSections.some((s) => sections.has(s));
  });
}
