/**
 * RPC Handlers for SQLite Adapter
 *
 * In Supabase, .rpc() calls server-side Postgres functions.
 * These JS functions replicate that behavior for the local SQLite runtime.
 */

import type Database from 'better-sqlite3';

/**
 * Create RPC handlers map for the SQLite adapter.
 * Each handler receives params and performs the equivalent DB operation.
 */
export function createRpcHandlers(db: Database.Database): Record<string, (params: Record<string, unknown>) => unknown> {
  return {
    /**
     * create_agent_activity — Insert a row into agent_workforce_activity
     * Mirrors the Supabase RPC that services call after task actions.
     */
    create_agent_activity(params: Record<string, unknown>) {
      const id = generateId();
      const stmt = db.prepare(`
        INSERT INTO agent_workforce_activity (id, workspace_id, activity_type, title, description, agent_id, task_id, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        id,
        params.p_workspace_id ?? null,
        params.p_activity_type ?? null,
        params.p_title ?? null,
        params.p_description ?? null,
        params.p_agent_id ?? null,
        params.p_task_id ?? null,
        JSON.stringify(params.p_metadata ?? {}),
        new Date().toISOString(),
      );

      return { id };
    },

    /**
     * increment_agent_stat — Atomically increment a stat counter on an agent
     * Uses typed columns (total_tasks, completed_tasks, etc.) instead of JSONB.
     * Valid stat keys: total_tasks, completed_tasks, failed_tasks, tokens_used, cost_cents_total
     */
    increment_agent_stat(params: Record<string, unknown>) {
      const agentId = params.p_agent_id as string;
      const statKey = params.p_stat_key as string;
      const increment = (params.p_increment as number) ?? 1;

      const validColumns = ['total_tasks', 'completed_tasks', 'failed_tasks', 'tokens_used', 'cost_cents_total'];
      if (!validColumns.includes(statKey)) {
        return null;
      }

      db.prepare(`UPDATE agent_workforce_agents SET ${statKey} = ${statKey} + ?, updated_at = datetime('now') WHERE id = ?`)
        .run(increment, agentId);

      const row = db.prepare(`SELECT ${validColumns.join(', ')} FROM agent_workforce_agents WHERE id = ?`).get(agentId) as Record<string, number> | undefined;
      return row ?? null;
    },

    /**
     * get_agent_memory_token_count — Sum token_count for active memories of an agent
     */
    get_agent_memory_token_count(params: Record<string, unknown>) {
      const agentId = params.p_agent_id as string;
      const row = db.prepare(
        'SELECT COALESCE(SUM(token_count), 0) as total FROM agent_workforce_agent_memory WHERE agent_id = ? AND is_active = 1'
      ).get(agentId) as { total: number };
      return row.total;
    },
  };
}

/** Generate a random hex ID (matches Supabase's UUID-like IDs) */
function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
