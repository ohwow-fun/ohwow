/**
 * Claude Code Session Persistence
 * Stores and retrieves Claude Code session IDs per agent for `--resume` support.
 * Sessions are cwd-aware: a session is only valid if the working directory matches.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';

export interface ClaudeCodeSessionStore {
  /**
   * Get the active session ID for an agent.
   * Returns null if no active session exists or if the working directory doesn't match.
   */
  getActiveSession(agentId: string, workingDir?: string): Promise<string | null>;

  /**
   * Save a session ID for an agent. Marks any previous session as stale.
   */
  saveSession(agentId: string, workspaceId: string, sessionId: string, workingDir?: string): Promise<void>;

  /**
   * Mark all sessions for an agent as stale (e.g., after a resume failure).
   */
  markStale(agentId: string): Promise<void>;
}

export function createSessionStore(db: DatabaseAdapter): ClaudeCodeSessionStore {
  return {
    async getActiveSession(agentId: string, workingDir?: string): Promise<string | null> {
      try {
        const { data } = await db
          .from('claude_code_sessions')
          .select('claude_session_id, working_directory')
          .eq('agent_id', agentId)
          .eq('status', 'active')
          .order('last_used_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!data) return null;
        const row = data as { claude_session_id: string; working_directory: string | null };

        // cwd-aware: only return session if working directory matches
        if (workingDir && row.working_directory && row.working_directory !== workingDir) {
          logger.debug(
            { agentId, stored: row.working_directory, requested: workingDir },
            '[claude-code-sessions] Session cwd mismatch, skipping resume',
          );
          return null;
        }

        // Update last_used_at
        await db
          .from('claude_code_sessions')
          .update({ last_used_at: new Date().toISOString() })
          .eq('agent_id', agentId)
          .eq('status', 'active');

        return row.claude_session_id;
      } catch (err) {
        logger.warn({ err }, '[claude-code-sessions] Failed to get session');
        return null;
      }
    },

    async saveSession(agentId: string, workspaceId: string, sessionId: string, workingDir?: string): Promise<void> {
      try {
        // Mark existing sessions for this agent as stale
        await db
          .from('claude_code_sessions')
          .update({ status: 'stale' })
          .eq('agent_id', agentId)
          .eq('status', 'active');

        // Insert new active session
        await db.from('claude_code_sessions').insert({
          agent_id: agentId,
          workspace_id: workspaceId,
          claude_session_id: sessionId,
          working_directory: workingDir || null,
          status: 'active',
        });
      } catch (err) {
        logger.warn({ err }, '[claude-code-sessions] Failed to save session');
      }
    },

    async markStale(agentId: string): Promise<void> {
      try {
        await db
          .from('claude_code_sessions')
          .update({ status: 'stale' })
          .eq('agent_id', agentId)
          .eq('status', 'active');
      } catch (err) {
        logger.warn({ err }, '[claude-code-sessions] Failed to mark stale');
      }
    },
  };
}
