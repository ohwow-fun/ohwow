/**
 * useAgents Hook
 * Queries agents from SQLite with periodic refresh.
 */

import { useState, useEffect } from 'react';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { AgentRow } from '../types.js';
import { useEventRefresh } from './use-event-bus.js';

interface ParsedAgent {
  id: string;
  name: string;
  role: string;
  description: string | null;
  status: string;
  stats: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export function useAgents(db: DatabaseAdapter | null, workspaceId: string | null | undefined) {
  const [list, setList] = useState<ParsedAgent[]>([]);
  const refresh = useEventRefresh(['task:completed', 'task:failed']);

  useEffect(() => {
    if (!db || !workspaceId) return;

    const fetch = async () => {
      const { data } = await db
        .from<AgentRow>('agent_workforce_agents')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: true });

      if (data) {
        const agents = data.map(a => ({
          id: a.id,
          name: a.name,
          role: a.role,
          description: a.description,
          status: a.status,
          stats: typeof a.stats === 'string' ? JSON.parse(a.stats) : (a.stats || {}),
          created_at: a.created_at,
          updated_at: a.updated_at,
        }));
        setList(agents);
      }
    };

    fetch();
    const timer = setInterval(fetch, 3000);
    return () => clearInterval(timer);
  }, [db, workspaceId, refresh]);

  return { list };
}
