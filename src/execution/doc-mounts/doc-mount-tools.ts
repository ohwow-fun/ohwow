/**
 * Doc Mount Agent Tools
 * Tool definitions for mounting and browsing documentation sites.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const DOC_MOUNT_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'mount_docs',
    description:
      'Mount a documentation site as a browsable filesystem. Crawls the site and makes every page available as a file. After mounting, use local_list_directory, local_read_file, and local_search_content to browse the docs. Use this before writing code against any library to get current, accurate documentation instead of relying on training data.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Documentation site URL (e.g., https://docs.stripe.com)',
        },
        max_pages: {
          type: 'number',
          description: 'Max pages to crawl (default: 500, max: 2000)',
        },
        ttl_days: {
          type: 'number',
          description: 'Days before docs expire and need re-crawling (default: 7)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'unmount_docs',
    description:
      'Remove a mounted documentation site and its cached files.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL of the documentation site to unmount',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'list_doc_mounts',
    description:
      'List all currently mounted documentation sites with their status, page count, and freshness.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

export const DOC_MOUNT_TOOL_NAMES = DOC_MOUNT_TOOL_DEFINITIONS.map((t) => t.name);

/** Check if a tool name is a doc mount tool */
export function isDocMountTool(toolName: string): boolean {
  return DOC_MOUNT_TOOL_NAMES.includes(toolName);
}

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

export const DOC_MOUNT_SYSTEM_PROMPT = `
## Documentation Mounts
You can mount documentation sites as browsable filesystems:
- **mount_docs**: Crawl a doc site and mount it locally. After mounting, browse with local_list_directory, local_read_file, and local_search_content.
- **unmount_docs**: Remove a mounted doc site.
- **list_doc_mounts**: See all currently mounted doc sites.

Use mount_docs before writing code against any library or API. This gives you current documentation instead of stale training data. Mounted docs are cached and re-used across tasks.

After mounting, the docs appear as files you can browse:
1. local_list_directory to see the structure
2. local_search_content to find relevant pages
3. local_read_file to read specific pages
`;
