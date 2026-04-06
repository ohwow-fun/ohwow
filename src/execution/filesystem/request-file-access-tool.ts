/**
 * Request File Access Gateway Tool
 * Lightweight tool included by default. When called, triggers a permission
 * prompt so the user can approve filesystem + shell access for the orchestrator.
 * Once approved, the real FILESYSTEM_TOOL_DEFINITIONS and BASH_TOOL_DEFINITIONS
 * replace this gateway tool for the remainder of the session.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';

export const REQUEST_FILE_ACCESS_TOOL: Tool = {
  name: 'request_file_access',
  description:
    'Request access to the local filesystem and shell. Call this when the task requires reading, writing, or searching files, or running shell commands. The user will be asked to approve access to a directory.',
  input_schema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Brief reason why filesystem and shell access is needed',
      },
      directory: {
        type: 'string',
        description: 'Specific directory to request access to. Defaults to the workspace directory.',
      },
    },
    required: ['reason'],
  },
};

export const FILE_ACCESS_ACTIVATION_MESSAGE = `Filesystem and shell access granted. You now have these tools available:
- local_list_directory: List files and subdirectories
- local_read_file: Read file contents
- local_search_files: Search for files by name pattern
- local_search_content: Search file contents with regex
- local_write_file: Write or create a file
- local_edit_file: Edit a file with find-and-replace
- run_bash: Execute shell commands

Use these tools to explore, read, modify, and run commands within the approved directory.`;
