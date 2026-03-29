/**
 * Cross-turn Tool Result Cache
 * Caches tool results across turns within a session to reduce API calls and latency.
 *
 * Features:
 * - Per-tool-category TTL (read-only: 5min, data-fetching: 2min, mutations: never cached)
 * - LRU eviction when max size is reached
 * - Automatic invalidation of read caches when related write tools execute
 * - MCP tool annotation support (readOnlyHint → auto-cacheable)
 */

import type { ToolResult } from './local-tool-types.js';
import type { McpToolAnnotations } from '../mcp/types.js';

interface CacheEntry {
  result: ToolResult;
  expiresAt: number;
  lastAccessed: number;
}

// Tools that are always safe to cache (read-only)
const READ_ONLY_TOOLS = new Set([
  'list_agents',
  'list_tasks',
  'get_task_detail',
  'get_pending_approvals',
  'get_agent_schedules',
  'list_workflows',
  'get_workflow_detail',
  'list_workflow_triggers',
  'get_workspace_stats',
  'get_activity_feed',
  'list_projects',
  'get_project_board',
  'list_goals',
  'list_a2a_connections',
  'list_whatsapp_chats',
  'list_whatsapp_connections',
  'get_whatsapp_messages',
  'list_telegram_connections',
  'list_telegram_chats',
  'get_business_pulse',
  'get_contact_pipeline',
  'get_daily_reps_status',
  'list_contacts',
  'search_contacts',
  'list_knowledge',
  'search_knowledge',
  'local_list_directory',
  'local_read_file',
  'local_search_files',
  'local_search_content',
  'list_peers',
  'list_peer_agents',
  'get_agent_suggestions',
  'discover_capabilities',
  'pdf_inspect_fields',
]);

// Tools that mutate data — never cached and invalidate related caches
const MUTATION_TOOLS = new Set([
  'update_agent_status',
  'run_agent',
  'spawn_agents',
  'approve_task',
  'reject_task',
  'queue_task',
  'retry_task',
  'cancel_task',
  'update_agent_schedule',
  'create_workflow',
  'update_workflow',
  'delete_workflow',
  'run_workflow',
  'create_workflow_trigger',
  'update_workflow_trigger',
  'delete_workflow_trigger',
  'create_project',
  'update_project',
  'move_task_column',
  'create_goal',
  'update_goal',
  'link_task_to_goal',
  'link_project_to_goal',
  'send_a2a_task',
  'send_whatsapp_message',
  'add_whatsapp_chat',
  'remove_whatsapp_chat',
  'send_telegram_message',
  'create_contact',
  'update_contact',
  'log_contact_event',
  'upload_knowledge',
  'add_knowledge_from_url',
  'assign_knowledge',
  'delete_knowledge',
  'local_write_file',
  'local_edit_file',
  'run_bash',
  'pdf_fill_form',
  'delegate_to_peer',
  'ask_peer',
  'propose_automation',
  'create_automation',
  'generate_workflow',
]);

// Maps mutation tools to the read tools they should invalidate
const INVALIDATION_MAP: Record<string, string[]> = {
  'update_agent_status': ['list_agents'],
  'run_agent': ['list_tasks', 'get_task_detail', 'list_agents'],
  'spawn_agents': ['list_tasks', 'list_agents'],
  'approve_task': ['list_tasks', 'get_task_detail', 'get_pending_approvals'],
  'reject_task': ['list_tasks', 'get_task_detail', 'get_pending_approvals'],
  'queue_task': ['list_tasks'],
  'retry_task': ['list_tasks', 'get_task_detail'],
  'cancel_task': ['list_tasks', 'get_task_detail'],
  'update_agent_schedule': ['get_agent_schedules', 'list_agents'],
  'create_workflow': ['list_workflows'],
  'update_workflow': ['list_workflows', 'get_workflow_detail'],
  'delete_workflow': ['list_workflows'],
  'run_workflow': ['list_workflows', 'get_workflow_detail'],
  'create_workflow_trigger': ['list_workflow_triggers'],
  'update_workflow_trigger': ['list_workflow_triggers'],
  'delete_workflow_trigger': ['list_workflow_triggers'],
  'create_project': ['list_projects'],
  'update_project': ['list_projects', 'get_project_board'],
  'move_task_column': ['get_project_board'],
  'create_goal': ['list_goals'],
  'update_goal': ['list_goals'],
  'create_contact': ['list_contacts', 'search_contacts'],
  'update_contact': ['list_contacts', 'search_contacts'],
  'upload_knowledge': ['list_knowledge', 'search_knowledge'],
  'delete_knowledge': ['list_knowledge', 'search_knowledge'],
  'local_write_file': ['local_read_file', 'local_list_directory', 'local_search_files', 'local_search_content'],
  'local_edit_file': ['local_read_file', 'local_search_content'],
  'run_bash': ['local_read_file', 'local_list_directory', 'local_search_files', 'local_search_content'],
};

const DEFAULT_READ_TTL_MS = 5 * 60 * 1000;  // 5 minutes
const DEFAULT_FETCH_TTL_MS = 2 * 60 * 1000; // 2 minutes
const DEFAULT_MAX_SIZE = 200;

export interface ToolCacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  size: number;
}

export class ToolCache {
  private cache = new Map<string, CacheEntry>();
  private stats: ToolCacheStats = { hits: 0, misses: 0, invalidations: 0, size: 0 };
  private maxSize: number;
  private mcpAnnotations: Map<string, McpToolAnnotations>;

  constructor(opts?: { maxSize?: number; mcpAnnotations?: Map<string, McpToolAnnotations> }) {
    this.maxSize = opts?.maxSize ?? DEFAULT_MAX_SIZE;
    this.mcpAnnotations = opts?.mcpAnnotations ?? new Map();
  }

  /**
   * Try to get a cached result for a tool call.
   * Returns undefined on cache miss.
   */
  get(toolName: string, input: Record<string, unknown>): ToolResult | undefined {
    if (!this.isCacheable(toolName)) {
      this.stats.misses++;
      return undefined;
    }

    const key = this.buildKey(toolName, input);
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.size = this.cache.size;
      this.stats.misses++;
      return undefined;
    }

    entry.lastAccessed = Date.now();
    this.stats.hits++;
    return entry.result;
  }

  /**
   * Store a tool result in the cache.
   * Only caches results from cacheable (read-only / data-fetching) tools.
   * Mutation tools trigger invalidation of related caches.
   */
  set(toolName: string, input: Record<string, unknown>, result: ToolResult): void {
    // Mutation tools invalidate related caches
    if (MUTATION_TOOLS.has(toolName)) {
      this.invalidateRelated(toolName);
      return;
    }

    if (!this.isCacheable(toolName)) return;
    if (!result.success) return; // don't cache errors

    const ttl = this.getTTL(toolName);
    if (ttl <= 0) return;

    // LRU eviction
    if (this.cache.size >= this.maxSize) {
      this.evictLRU();
    }

    const key = this.buildKey(toolName, input);
    this.cache.set(key, {
      result,
      expiresAt: Date.now() + ttl,
      lastAccessed: Date.now(),
    });
    this.stats.size = this.cache.size;
  }

  /**
   * Invalidate all cached results for tools related to a mutation.
   */
  private invalidateRelated(mutationTool: string): void {
    const relatedTools = INVALIDATION_MAP[mutationTool];
    if (!relatedTools) return;

    const keysToDelete: string[] = [];
    for (const key of this.cache.keys()) {
      const toolName = key.split(':')[0];
      if (relatedTools.includes(toolName)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
    }

    if (keysToDelete.length > 0) {
      this.stats.invalidations += keysToDelete.length;
      this.stats.size = this.cache.size;
    }
  }

  /** Evict the least recently accessed entry. */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /** Check if a tool is cacheable. */
  private isCacheable(toolName: string): boolean {
    if (MUTATION_TOOLS.has(toolName)) return false;
    if (READ_ONLY_TOOLS.has(toolName)) return true;

    // Check MCP annotations
    const annotations = this.mcpAnnotations.get(toolName);
    if (annotations?.readOnlyHint) return true;

    // Non-MCP tools not in the read-only set are not cached by default
    return false;
  }

  /** Get TTL for a tool. */
  private getTTL(toolName: string): number {
    if (READ_ONLY_TOOLS.has(toolName)) return DEFAULT_READ_TTL_MS;

    // MCP tools with readOnlyHint get the fetch TTL
    const annotations = this.mcpAnnotations.get(toolName);
    if (annotations?.readOnlyHint) return DEFAULT_FETCH_TTL_MS;

    return 0;
  }

  /** Build a stable cache key from tool name and input. */
  private buildKey(toolName: string, input: Record<string, unknown>): string {
    return `${toolName}:${JSON.stringify(input, Object.keys(input).sort())}`;
  }

  /** Get cache stats. */
  getStats(): ToolCacheStats {
    return { ...this.stats };
  }

  /** Clear all cached entries. */
  clear(): void {
    this.cache.clear();
    this.stats.size = 0;
  }
}
