/**
 * useTasks Hook
 * Queries tasks from SQLite with periodic refresh and filtering.
 */

import { useState, useEffect } from 'react';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { TaskRow } from '../types.js';
import { useEventRefresh } from './use-event-bus.js';

interface ParsedTask {
  id: string;
  agent_id: string;
  title: string;
  description: string | null;
  status: string;
  tokens_used: number | null;
  cost_cents: number | null;
  duration_seconds: number | null;
  error_message: string | null;
  priority: string | null;
  due_date: string | null;
  created_at: string;
  completed_at: string | null;
}

export function useTasks(db: DatabaseAdapter | null, filter?: { status?: string; agentId?: string }) {
  const [list, setList] = useState<ParsedTask[]>([]);
  const refresh = useEventRefresh(['task:started', 'task:completed', 'task:failed']);

  useEffect(() => {
    if (!db) return;

    const fetch = async () => {
      let query = db
        .from<TaskRow>('agent_workforce_tasks')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (filter?.status) {
        query = query.eq('status', filter.status);
      }
      if (filter?.agentId) {
        query = query.eq('agent_id', filter.agentId);
      }

      const { data } = await query;

      if (data) {
        const tasks = data.map(t => ({
          id: t.id,
          agent_id: t.agent_id,
          title: t.title,
          description: t.description,
          status: t.status,
          tokens_used: t.tokens_used,
          cost_cents: t.cost_cents,
          duration_seconds: t.duration_seconds,
          error_message: t.error_message,
          priority: t.priority,
          due_date: t.due_date,
          created_at: t.created_at,
          completed_at: t.completed_at,
        }));
        setList(tasks);
      }
    };

    fetch();
    const timer = setInterval(fetch, 3000);
    return () => clearInterval(timer);
  }, [db, refresh, filter?.status, filter?.agentId]);

  return { list };
}
