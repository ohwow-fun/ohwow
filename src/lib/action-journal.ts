/**
 * Action Journal — Local Workspace
 *
 * Logs side-effecting tool calls to SQLite for audit trail.
 * Simplified vs cloud: no revert execution (local tools are mostly
 * read-only or filesystem-based), but maintains the journal for
 * transparency and debugging.
 */

import crypto from 'crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ActionJournalEntry {
  id: string;
  taskId: string;
  agentId: string;
  workspaceId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  reversibility: string;
  status: 'active' | 'reverted' | 'expired';
  createdAt: string;
  expiresAt: string;
}

// ============================================================================
// SERVICE
// ============================================================================

export class LocalActionJournalService {
  constructor(
    private db: DatabaseAdapter,
    private workspaceId: string,
  ) {}

  /**
   * Log a tool call to the local action journal.
   */
  async logAction(params: {
    taskId: string;
    agentId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    toolOutput: unknown;
    reversibility: string;
  }): Promise<void> {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await this.db.from('agent_workforce_action_journal').insert({
      id: crypto.randomUUID(),
      workspace_id: this.workspaceId,
      agent_id: params.agentId,
      task_id: params.taskId,
      tool_name: params.toolName,
      tool_input: JSON.stringify(params.toolInput),
      tool_output: JSON.stringify(params.toolOutput ?? null),
      reversibility: params.reversibility,
      status: 'active',
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
    });
  }

  /**
   * List recent actions for a task.
   */
  async listActions(taskId: string, limit = 50): Promise<ActionJournalEntry[]> {
    const { data } = await this.db
      .from<Record<string, unknown>>('agent_workforce_action_journal')
      .select('*')
      .eq('workspace_id', this.workspaceId)
      .eq('task_id', taskId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (!data) return [];
    return (data ?? []).map((row) => ({
      id: row.id as string,
      taskId: row.task_id as string,
      agentId: row.agent_id as string,
      workspaceId: row.workspace_id as string,
      toolName: row.tool_name as string,
      toolInput: typeof row.tool_input === 'string' ? JSON.parse(row.tool_input) : row.tool_input as Record<string, unknown>,
      toolOutput: typeof row.tool_output === 'string' ? JSON.parse(row.tool_output) : row.tool_output,
      reversibility: row.reversibility as string,
      status: row.status as 'active' | 'reverted' | 'expired',
      createdAt: row.created_at as string,
      expiresAt: row.expires_at as string,
    }));
  }
}
