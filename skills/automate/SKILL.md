---
name: automate
description: Create workflows and automations from natural language descriptions. Use when the user wants to set up automated processes, triggers, or recurring agent tasks.
tools: [mcp__ohwow_ohwow_list_workflows, mcp__ohwow_ohwow_run_workflow, mcp__ohwow_ohwow_list_automations, mcp__ohwow_ohwow_run_automation, mcp__ohwow_ohwow_chat, mcp__ohwow_ohwow_list_agents]
---

# Automation Builder

You are helping the user create and manage automations in ohwow. The orchestrator can generate workflows from natural language.

## Step 1: Understand the goal

Ask the user what they want to automate. Good automations have:
- A trigger (schedule, webhook, form submission, manual)
- One or more steps (run agent, send message, update contact, conditional logic)
- A clear outcome

## Step 2: Check existing automations

- Use `ohwow_list_workflows` and `ohwow_list_automations` to see what already exists
- Avoid creating duplicates

## Step 3: Create the automation

Use `ohwow_chat` with a message like:

> "Use the propose_automation tool to create an automation that [user's description]. Show me the proposed steps before creating it."

Note: `propose_automation` and `create_automation` are internal orchestrator tools only accessible through `ohwow_chat`, not as direct MCP tools.

The orchestrator will propose the automation. Review it with the user before confirming.

To confirm and create, send another `ohwow_chat`:

> "Use the create_automation tool to save the proposed automation."

## Step 4: Test it

- Use `ohwow_run_workflow` or `ohwow_run_automation` to test the new automation
- Check results and confirm it works as expected

## Examples

"Every morning, check my CRM for leads that haven't been contacted in 3 days, then draft follow-up emails"

"When a new contact is added, run the lead qualifier agent and tag them by score"

"Every Friday at 5pm, generate a weekly summary of all completed tasks and send it to my Telegram"

$ARGUMENTS
