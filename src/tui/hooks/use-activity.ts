/**
 * useActivity Hook
 * Activity log polling from SQLite.
 */

import { useState, useEffect } from 'react';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ActivityRow } from '../types.js';
import { useEventRefresh } from './use-event-bus.js';

interface ParsedActivity {
  id: string;
  activity_type: string;
  title: string;
  description: string | null;
  agent_id: string | null;
  task_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export function useActivity(db: DatabaseAdapter | null) {
  const [list, setList] = useState<ParsedActivity[]>([]);
  const refresh = useEventRefresh(['task:completed', 'task:failed', 'memory:extracted']);

  useEffect(() => {
    if (!db) return;

    const fetch = async () => {
      const { data } = await db
        .from<ActivityRow>('agent_workforce_activity')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (data) {
        const activities = data.map(a => ({
          id: a.id,
          activity_type: a.activity_type,
          title: a.title,
          description: a.description,
          agent_id: a.agent_id,
          task_id: a.task_id,
          metadata: typeof a.metadata === 'string' ? JSON.parse(a.metadata) : (a.metadata || {}),
          created_at: a.created_at,
        }));
        setList(activities);
      }
    };

    fetch();
    const timer = setInterval(fetch, 3000);
    return () => clearInterval(timer);
  }, [db, refresh]);

  return { list };
}
