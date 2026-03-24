/**
 * Filesystem Agent Tools
 * Tool definitions for read-only local file access.
 * These tools are available to agents when local_files_enabled is true
 * and allowed directories are configured.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const FILESYSTEM_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'local_list_directory',
    description:
      'List files and folders in a directory on the user\'s device. Only works within allowed directories.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "Directory to list. Defaults to '.' (current working directory) if not provided." },
        recursive: { type: 'boolean', description: 'List recursively (max depth 3). Default: false' },
        pattern: { type: 'string', description: 'Glob pattern to filter results (e.g. "*.csv", "*.json")' },
      },
      required: [],
    },
  },
  {
    name: 'local_read_file',
    description:
      'Read the contents of a single file on the user\'s device. For directories, use local_list_directory instead. Returns UTF-8 text for text files, base64 for binary. 2MB size limit. Only works within allowed directories.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to read (must be a file, not a directory)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'local_search_files',
    description:
      'Search for files by name pattern across all allowed directories. Returns matching file paths. Max 50 results.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match filenames (e.g. "*.csv", "report*", "**/*.json")' },
        type: { type: 'string', description: 'File type filter (e.g. "ts", "json", "py"). Filters by extension.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'local_search_content',
    description:
      'Search for text or regex within files across allowed directories. Returns matching lines with context. Max 100 matches.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for (case-insensitive by default), or a regex pattern if regex=true' },
        pattern: { type: 'string', description: 'Optional glob pattern to filter which files to search (e.g. "*.csv")' },
        path: { type: 'string', description: 'Directory or file to search within. Defaults to all allowed directories.' },
        regex: { type: 'boolean', description: 'Treat query as a regex pattern. Default: false (literal text).' },
        context: { type: 'number', description: 'Lines of context before/after each match (like grep -C). Default: 0.' },
        type: { type: 'string', description: 'File type to search (e.g. "ts", "py", "json"). Filters by extension.' },
        case_sensitive: { type: 'boolean', description: 'Case-sensitive search. Default: false (insensitive).' },
        output_mode: { type: 'string', enum: ['content', 'files', 'count'], description: 'Output mode: "content" (matching lines, default), "files" (file paths only), "count" (match counts per file).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'local_write_file',
    description:
      'Write content to a file on the user\'s device. Creates the file and any parent directories if they don\'t exist. Overwrites existing content. Only works within allowed directories.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to write' },
        content: { type: 'string', description: 'Full text content to write to the file' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'local_edit_file',
    description:
      'Edit a file by replacing an exact string. The old_string must appear exactly once — if it appears 0 or more than 1 time, the edit is rejected. Use local_read_file first to get the exact text to replace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to edit' },
        old_string: { type: 'string', description: 'Exact string to find and replace (must appear exactly once in the file)' },
        new_string: { type: 'string', description: 'Replacement string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
];

export const FILESYSTEM_TOOL_NAMES = FILESYSTEM_TOOL_DEFINITIONS.map((t) => t.name);

/** Check if a tool name is a filesystem tool. */
export function isFilesystemTool(toolName: string): boolean {
  return FILESYSTEM_TOOL_NAMES.includes(toolName);
}

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

export const FILESYSTEM_SYSTEM_PROMPT = `
## Local File Access
You can read files from the user's device using these tools:
- **local_list_directory**: List files and folders with sizes. Use \`recursive: true\` for full tree (like ls -R). Call with no arguments (\`{}\`) or \`{ path: '.' }\` to orient yourself in the current working directory first.
- **local_read_file**: Read file contents (text or binary, 2MB limit)
- **local_search_files**: Find files by name pattern across allowed directories
- **local_search_content**: Search for text or regex within files. Scope to a path with \`path\`, add context lines with \`context\`, use regex patterns with \`regex: true\`. Use \`type: "ts"\` to scope to a specific file type. Use \`output_mode: "files"\` when you just need file paths, not content. Use \`case_sensitive: true\` when exact case matters.

You only have access to directories the user has specifically allowed. All access is read-only.
If you receive a permission prompt for a path outside your allowed directories, wait for the user to respond before retrying.
`;
