/**
 * State Agent Tools
 * Tool definitions for cross-task persistent state.
 * Available to all agents — allows reading/writing structured state
 * that persists across task runs (e.g. counters, last-seen values, progress).
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';

export const STATE_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'get_state',
    description:
      'Read a persistent state value that was saved in a previous task run. Use this to recall counters, progress, last-seen data, or any structured state you previously stored with set_state. Returns null if the key does not exist.',
    input_schema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The state key to retrieve (e.g. "posts_completed", "last_price_check")',
        },
        scope: {
          type: 'string',
          enum: ['agent', 'goal', 'schedule'],
          description: 'State scope. "agent" = shared across all tasks for this agent. "goal" = scoped to a specific goal. "schedule" = scoped to a specific schedule. Default: "agent"',
        },
        scope_id: {
          type: 'string',
          description: 'ID of the goal or schedule when scope is "goal" or "schedule". Ignored for "agent" scope.',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'set_state',
    description:
      'Save a persistent state value that will be available in future task runs. Use this to track counters, progress, structured data, or any information the agent needs to remember across executions. Values are stored as JSON.',
    input_schema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The state key to store (e.g. "posts_completed", "competitor_prices")',
        },
        value: {
          description: 'The value to store. Can be a string, number, boolean, array, or object. Will be serialized to JSON.',
        },
        scope: {
          type: 'string',
          enum: ['agent', 'goal', 'schedule'],
          description: 'State scope. "agent" = shared across all tasks for this agent. "goal" = scoped to a specific goal. "schedule" = scoped to a specific schedule. Default: "agent"',
        },
        scope_id: {
          type: 'string',
          description: 'ID of the goal or schedule when scope is "goal" or "schedule". Ignored for "agent" scope.',
        },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'list_state',
    description:
      'List all persistent state keys and values for this agent. Use this to see what state has been saved across previous task runs.',
    input_schema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['agent', 'goal', 'schedule'],
          description: 'Filter by scope. If omitted, returns all scopes.',
        },
        scope_id: {
          type: 'string',
          description: 'Filter by scope ID (goal or schedule ID).',
        },
      },
      required: [],
    },
  },
  {
    name: 'delete_state',
    description:
      'Delete a persistent state key. Use when a value is no longer needed.',
    input_schema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The state key to delete',
        },
        scope: {
          type: 'string',
          enum: ['agent', 'goal', 'schedule'],
          description: 'State scope. Default: "agent"',
        },
        scope_id: {
          type: 'string',
          description: 'ID of the goal or schedule when scope is "goal" or "schedule".',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'update_goal_progress',
    description:
      'Set the current progress value for a goal. Use this when the task achieves measurable progress (e.g. "15 posts published") instead of relying on the default +1 increment per task completion.',
    input_schema: {
      type: 'object',
      properties: {
        value: {
          type: 'number',
          description: 'The new progress value to set (non-negative integer)',
        },
        goal_id: {
          type: 'string',
          description: 'Goal ID to update. If omitted, uses the goal linked to the current task.',
        },
      },
      required: ['value'],
    },
  },
];

export function isStateTool(name: string): boolean {
  return name === 'get_state' || name === 'set_state' || name === 'list_state' || name === 'delete_state' || name === 'update_goal_progress';
}
