---
name: manage-agents
description: List, run, and monitor ohwow AI agents. Use when the user wants to execute an agent, check task results, or see what agents are available.
tools: [mcp__ohwow_ohwow_list_agents, mcp__ohwow_ohwow_run_agent, mcp__ohwow_ohwow_get_task, mcp__ohwow_ohwow_list_tasks, mcp__ohwow_ohwow_workspace_status]
---

# Agent Management

You are helping the user manage their ohwow AI agents. Follow this workflow:

## Step 1: Discover

If the user hasn't specified an agent, list available agents first:
- Use `ohwow_list_agents` to see all agents with their roles and capabilities
- Present them in a concise table: name, role, status

## Step 2: Execute

When the user picks an agent or describes a task:
- Use `ohwow_run_agent` with the agent ID and a clear prompt
- Note the returned task ID

## Step 3: Monitor

After running an agent:
- Use `ohwow_get_task` to check if the task completed
- If still running, let the user know and offer to check again
- When complete, summarize the result

## Error Recovery

- If `ohwow_run_agent` returns an error, check daemon status with `ohwow_workspace_status`
- If the task shows status "failed", read the error details in the `ohwow_get_task` output
- For long-running agents, poll `ohwow_get_task` every 10-15 seconds until status is "completed" or "failed"

## Tips

- If the user says "run" or "execute" without specifying an agent, use `ohwow_list_agents` first to help them pick
- For complex multi-step work, suggest running multiple agents with `ohwow_chat` which has access to `spawn_agents` and `await_agent_results`
- Use `ohwow_workspace_status` if the user asks about overall system health

$ARGUMENTS
