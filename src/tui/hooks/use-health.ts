/**
 * useHealth Hook
 * Aggregates health metrics from SQLite.
 */

import { useState, useEffect } from 'react';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { HealthMetrics } from '../types.js';
import { useEventRefresh } from './use-event-bus.js';

const DEFAULT_METRICS: HealthMetrics = {
  uptime: 0,
  memoryPercent: 0,
  totalAgents: 0,
  totalTasks: 0,
  activeTasks: 0,
  totalTokens: 0,
  totalCostCents: 0,
  cloudConnected: false,
};

export function useHealth(db: DatabaseAdapter | null, cloudConnected: boolean): HealthMetrics {
  const [metrics, setMetrics] = useState<HealthMetrics>(DEFAULT_METRICS);
  const refresh = useEventRefresh(['task:completed', 'task:failed']);

  useEffect(() => {
    if (!db) return;

    const startTime = Date.now();

    const fetch = async () => {
      const uptime = Math.round((Date.now() - startTime) / 1000);
      const mem = process.memoryUsage();
      const memoryPercent = Math.round((mem.heapUsed / mem.heapTotal) * 100);

      // Count agents
      const { count: agentCount } = await db
        .from('agent_workforce_agents')
        .select('*', { count: 'exact', head: true });

      // Count tasks
      const { count: taskCount } = await db
        .from('agent_workforce_tasks')
        .select('*', { count: 'exact', head: true });

      // Count active tasks
      const { count: activeCount } = await db
        .from('agent_workforce_tasks')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'in_progress');

      // Sum tokens and cost
      const { data: taskData } = await db
        .from<{ tokens_used: number | null; cost_cents: number | null }>('agent_workforce_tasks')
        .select('tokens_used, cost_cents');

      let totalTokens = 0;
      let totalCost = 0;
      if (taskData) {
        for (const row of taskData) {
          totalTokens += row.tokens_used || 0;
          totalCost += row.cost_cents || 0;
        }
      }

      setMetrics({
        uptime,
        memoryPercent,
        totalAgents: agentCount ?? 0,
        totalTasks: taskCount ?? 0,
        activeTasks: activeCount ?? 0,
        totalTokens,
        totalCostCents: totalCost,
        cloudConnected,
      });
    };

    fetch();
    const timer = setInterval(fetch, 3000);
    return () => clearInterval(timer);
  }, [db, cloudConnected, refresh]);

  return metrics;
}
