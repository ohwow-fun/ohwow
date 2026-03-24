/**
 * OpenClaw Call Logger
 * Logs every OpenClaw skill call to SQLite for audit trail.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';
import type { OpenClawCallLog } from './types.js';

/**
 * Log an OpenClaw skill call to the database.
 */
export async function logOpenClawCall(
  db: DatabaseAdapter,
  log: Omit<OpenClawCallLog, 'id'>,
): Promise<void> {
  try {
    await db.from('openclaw_call_logs').insert({
      timestamp: log.timestamp,
      skill_id: log.skillId,
      agent_id: log.agentId,
      input: log.input,
      output: log.output,
      duration_ms: log.durationMs,
      success: log.success ? 1 : 0,
      error: log.error ?? null,
    });
  } catch (err) {
    logger.error({ err, skillId: log.skillId }, '[OpenClaw] Could not log call');
  }
}

/**
 * Query recent OpenClaw call logs.
 */
export async function getCallLogs(
  db: DatabaseAdapter,
  options?: { skillId?: string; limit?: number; since?: string },
): Promise<OpenClawCallLog[]> {
  let query = db.from('openclaw_call_logs')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(options?.limit ?? 50);

  if (options?.skillId) {
    query = query.eq('skill_id', options.skillId);
  }
  if (options?.since) {
    query = query.gte('timestamp', options.since);
  }

  const { data, error } = await query;
  if (error || !data) return [];

  return (data as Array<Record<string, unknown>>).map(row => ({
    id: row.id as number,
    timestamp: row.timestamp as string,
    skillId: row.skill_id as string,
    agentId: row.agent_id as string,
    input: row.input as string,
    output: row.output as string,
    durationMs: row.duration_ms as number,
    success: Boolean(row.success),
    error: row.error as string | undefined,
  }));
}
