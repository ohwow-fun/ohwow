/**
 * Bash/Shell Agent Tools
 * Tool definitions for executing bash commands on the host device.
 * These tools are available to agents when bash_enabled is true
 * and allowed directories are configured via FileAccessGuard.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const BASH_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'run_bash',
    description:
      'Execute a bash command on the user\'s device. Commands run within allowed directories only. Use for system tasks, build commands, git operations, data processing, and scripting. Prefer local_read_file for simple file reads. Each call runs in a fresh shell — `cd` and shell variables do NOT persist between calls. Chain multi-step work in a single command with `&&`, or pass `working_directory` each time.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The bash command to execute. Supports pipes, chaining (&&, ||), and shell features.',
        },
        working_directory: {
          type: 'string',
          description: 'Working directory for the command. Must be within allowed paths. Defaults to the first allowed directory.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Timeout in milliseconds (1000-300000). Default: 30000 (30s). Command is killed if it exceeds this.',
        },
      },
      required: ['command'],
    },
  },
];

export const BASH_TOOL_NAMES = BASH_TOOL_DEFINITIONS.map((t) => t.name);

/** Check if a tool name is a bash tool. */
export function isBashTool(toolName: string): boolean {
  return BASH_TOOL_NAMES.includes(toolName);
}

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

export const BASH_SYSTEM_PROMPT = `
## Bash Command Execution
You can execute bash commands on the user's device using the **run_bash** tool.

**Capabilities:**
- Run any shell command: system utils, build tools, git, package managers, compilers
- Pipe commands together, use && / || chaining, subshells
- Write and execute scripts
- Process data with standard unix tools (awk, sed, jq, etc.)

**When to use bash vs other tools:**
- Use \`local_read_file\` for simply reading a file's contents
- Use \`local_list_directory\` for listing directory contents
- Use \`run_bash\` when you need to: run builds, execute scripts, check system stats, use git, process data with shell pipelines, install packages, or any task requiring shell execution

**Constraints:**
- Commands run within allowed directories only
- Output is capped at 50KB per stream (stdout/stderr)
- Default timeout is 30 seconds (max 5 minutes)
- Certain dangerous commands are blocked (rm -rf /, shutdown, reboot, etc.)
- Environment variables containing secrets are scrubbed
- **Each call runs in a fresh shell.** \`cd\`, \`export\`, and shell variables do NOT persist between calls. To do multi-step work, chain with \`&&\` in one command, or pass \`working_directory\` each call.

**Best practices:**
- Verify paths before destructive operations
- Break long-running work into smaller steps
- Check exit codes in chained commands
- Use absolute paths when possible
`;
