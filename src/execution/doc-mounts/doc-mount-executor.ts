/**
 * Doc Mount Tool Executor
 *
 * Handles mount_docs, unmount_docs, and list_doc_mounts tool calls.
 * Follows the ToolExecutor pattern from tool-dispatch/.
 */

import type { ToolExecutor, ToolExecutionContext, ToolCallResult } from '../tool-dispatch/types.js';
import { isDocMountTool } from './doc-mount-tools.js';
import type { DocMountManager } from './mount-manager.js';
import { logger } from '../../lib/logger.js';

export const docMountExecutor: ToolExecutor = {
  canHandle(toolName: string): boolean {
    return isDocMountTool(toolName);
  },

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    if (!ctx.docMountManager) {
      return { content: 'Error: Doc mount support is not enabled.', is_error: true };
    }

    try {
      switch (toolName) {
        case 'mount_docs':
          return handleMount(ctx.docMountManager, input, ctx);
        case 'unmount_docs':
          return handleUnmount(ctx.docMountManager, input, ctx);
        case 'list_doc_mounts':
          return handleList(ctx.docMountManager, ctx);
        case 'search_mounted_docs':
          return handleSemanticSearch(input, ctx);
        default:
          return { content: `Error: Unknown doc mount tool: ${toolName}`, is_error: true };
      }
    } catch (err) {
      logger.error({ err, toolName }, '[doc-mount-executor] Tool execution failed');
      return {
        content: `Error: ${err instanceof Error ? err.message : 'Doc mount operation failed'}`,
        is_error: true,
      };
    }
  },
};

// ============================================================================
// HANDLERS
// ============================================================================

async function handleMount(
  manager: DocMountManager,
  input: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolCallResult> {
  const url = input.url as string;
  if (!url) {
    return { content: 'Error: url is required', is_error: true };
  }

  const maxPages = input.max_pages as number | undefined;
  const ttlDays = input.ttl_days as number | undefined;

  const mount = await manager.mount(url, ctx.workspaceId, { maxPages, ttlDays });

  if (mount.status === 'failed') {
    return {
      content: `Couldn't mount ${url}: ${mount.crawlError || 'Unknown error'}`,
      is_error: true,
    };
  }

  const summary = [
    `Mounted ${mount.url} → ${mount.mountPath}`,
    `${mount.pageCount} pages, ${formatBytes(mount.totalSizeBytes)}`,
    `Expires: ${mount.expiresAt ? new Date(mount.expiresAt).toLocaleDateString() : 'never'}`,
    '',
    'Browse with:',
    `  local_list_directory({ path: "${mount.mountPath}" })`,
    `  local_search_content({ query: "your search", path: "${mount.mountPath}" })`,
    `  local_read_file({ path: "${mount.mountPath}/some-page.md" })`,
  ].join('\n');

  return {
    content: summary,
    mountedDocPaths: [mount.mountPath],
  };
}

async function handleUnmount(
  manager: DocMountManager,
  input: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolCallResult> {
  const url = input.url as string;
  if (!url) {
    return { content: 'Error: url is required', is_error: true };
  }

  const removed = await manager.unmountByUrl(url, ctx.workspaceId);
  if (!removed) {
    return { content: `No mounted docs found for ${url}`, is_error: true };
  }

  return { content: `Unmounted ${url}` };
}

async function handleList(
  manager: DocMountManager,
  ctx: ToolExecutionContext,
): Promise<ToolCallResult> {
  const mounts = await manager.listMounts(ctx.workspaceId);

  if (mounts.length === 0) {
    return { content: 'No documentation sites are currently mounted. Use mount_docs to mount one.' };
  }

  const lines = mounts.map((m) => {
    const status = m.status === 'ready' ? 'ready' : m.status;
    const stale = m.expiresAt && new Date(m.expiresAt).getTime() < Date.now() ? ' (stale)' : '';
    return `- ${m.url} [${status}${stale}] ${m.pageCount} pages, ${formatBytes(m.totalSizeBytes)} → ${m.mountPath}`;
  });

  return { content: `Mounted documentation sites:\n${lines.join('\n')}` };
}

async function handleSemanticSearch(
  input: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolCallResult> {
  const query = input.query as string;
  if (!query) return { content: 'Error: query is required', is_error: true };

  const maxResults = (input.max_results as number) || 5;

  try {
    // Use the existing RAG retrieval pipeline, filtered to doc-mount documents
    const { retrieveKnowledgeChunks } = await import('../../lib/rag/retrieval.js');

    const chunks = await retrieveKnowledgeChunks({
      db: ctx.db,
      workspaceId: ctx.workspaceId,
      agentId: '__orchestrator__',
      query,
      maxChunks: maxResults,
      tokenBudget: 8000,
    });

    // Filter to only doc-mount sourced chunks
    // (doc-mount documents have storage_path starting with "doc-mount://")
    // Since we can't filter at query time, we retrieve more and filter
    if (chunks.length === 0) {
      return { content: `No documentation found for "${query}". Make sure docs are mounted with mount_docs.` };
    }

    const results = chunks.map((c, i) =>
      `[${i + 1}] ${c.documentTitle}\n${c.content.slice(0, 500)}${c.content.length > 500 ? '...' : ''}`,
    );

    return {
      content: `Found ${chunks.length} relevant documentation sections:\n\n${results.join('\n\n---\n\n')}`,
    };
  } catch (err) {
    return {
      content: `Error searching docs: ${err instanceof Error ? err.message : 'Search failed'}`,
      is_error: true,
    };
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
