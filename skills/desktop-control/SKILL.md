---
name: desktop-control
description: Control the user's desktop through ohwow agents. Use when the user wants to automate macOS tasks, operate apps, fill forms, take screenshots, or do anything on their computer that requires mouse, keyboard, or screen interaction.
tools: [mcp__ohwow_ohwow_chat, mcp__ohwow_ohwow_run_agent, mcp__ohwow_ohwow_get_task, mcp__ohwow_ohwow_list_agents]
---

# Desktop Control

You are helping the user automate tasks on their macOS desktop through ohwow's desktop control agents. These agents can see the screen, move the mouse, type on the keyboard, and operate any app.

## How it works

ohwow's desktop control uses a perception/reasoning/action loop:
1. Agent takes a screenshot of the screen
2. Vision model analyzes what's visible
3. Agent decides the next action (click, type, scroll, key press)
4. Executes the action
5. Takes another screenshot to verify the result
6. Repeats until the task is done

## Step 1: Describe the task clearly

Desktop tasks need precise instructions. Help the user formulate a clear task description that includes:
- Which app to open or use
- What actions to perform (in order)
- What the expected end state looks like

## Step 2: Execute via the orchestrator

Use `ohwow_chat` to instruct the desktop control agent. Frame the message as a specific desktop task:

Example messages:
- "Use desktop control to open Safari, navigate to google.com, and search for 'ohwow AI'"
- "Use desktop control to open the Notes app and create a new note with the title 'Meeting Notes'"
- "Use desktop control to take a screenshot of the current screen"
- "Use desktop control to open Figma and export the first artboard as PNG to the Desktop"

## Step 3: Monitor and verify

After dispatching:
- Use `ohwow_get_task` to check progress
- The agent may need multiple perception/action cycles
- If the task seems stuck, check the task output for what the agent is seeing on screen

## Safety

- Desktop control requires explicit user permission before activating
- Dangerous actions (typing in Terminal, changing system settings) trigger additional approval prompts
- The user can stop the agent at any point
- Always confirm the task with the user before dispatching, especially for actions that modify files or send data

## Tips

- Desktop control works on macOS only. Other platforms are not supported.
- For repetitive desktop tasks, suggest creating a workflow automation instead of running desktop control each time
- Complex multi-app tasks work best when broken into sequential steps
- If the user wants to automate something in a browser, suggest browser automation tools first (faster and more reliable). Use desktop control for native apps that can't be automated through the browser.

$ARGUMENTS
