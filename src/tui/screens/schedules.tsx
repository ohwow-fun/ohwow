/**
 * Schedules Screen
 * List and manage agent schedules. Accessed from Settings via 's' key.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { ScrollableList } from '../components/scrollable-list.js';

interface SchedulesProps {
  db: DatabaseAdapter | null;
  onBack: () => void;
  embedded?: boolean;
}

interface Schedule {
  id: string;
  label: string;
  cron_expression: string;
  agent_id: string;
  agent_name: string;
  is_active: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
}

function formatNextRun(dateStr: string | null): string {
  if (!dateStr) return 'N/A';
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff < 0) return 'overdue';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  return `in ${Math.floor(hrs / 24)}d`;
}

export function Schedules({ db, onBack, embedded }: SchedulesProps) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  useEffect(() => {
    if (!db) return;

    const fetch = async () => {
      const { data } = await db
        .from('agent_workforce_schedules')
        .select('id, label, cron, cron_expression, agent_id, enabled, is_active, next_run_at, last_run_at')
        .order('created_at', { ascending: false });

      if (!data) return;

      const rows = data as Array<Record<string, unknown>>;
      const agentIds = [...new Set(rows.map(r => r.agent_id).filter(Boolean))] as string[];
      let agentMap: Record<string, string> = {};
      if (agentIds.length > 0) {
        const { data: agents } = await db.from('agent_workforce_agents').select('id, name').in('id', agentIds);
        if (agents) {
          agentMap = Object.fromEntries((agents as Array<{ id: string; name: string }>).map(a => [a.id, a.name]));
        }
      }

      setSchedules(rows.map(r => ({
        id: r.id as string,
        label: (r.label as string) || 'Unnamed',
        cron_expression: (r.cron as string) || (r.cron_expression as string) || '',
        agent_id: r.agent_id as string,
        agent_name: agentMap[r.agent_id as string] || 'Unknown',
        is_active: Boolean(r.enabled ?? r.is_active),
        next_run_at: r.next_run_at as string | null,
        last_run_at: r.last_run_at as string | null,
      })));
    };

    fetch();
  }, [db]);

  const toggleEnabled = async (schedule: Schedule) => {
    if (!db) return;
    const newActive = !schedule.is_active;

    await db.from('agent_workforce_schedules').update({
      enabled: newActive ? 1 : 0,
      updated_at: new Date().toISOString(),
    }).eq('id', schedule.id);

    setSchedules(prev => prev.map(s =>
      s.id === schedule.id ? { ...s, is_active: newActive } : s
    ));
  };

  useInput((_input, key) => {
    if (!embedded && key.escape) {
      onBack();
      return;
    }
  });

  return (
    <Box flexDirection="column">
      {!embedded && <Text bold>Schedules ({schedules.length})</Text>}
      <Box marginTop={1}>
        <ScrollableList
          items={schedules}
          onSelect={(schedule) => toggleEnabled(schedule)}
          emptyMessage="No schedules configured. Create schedules from the web dashboard."
          renderItem={(schedule, _, isSelected) => (
            <Box>
              <Text color={schedule.is_active ? 'green' : 'gray'}>
                {schedule.is_active ? '\u25CF' : '\u25CB'}
              </Text>
              <Text> </Text>
              <Text bold={isSelected}>{schedule.label.slice(0, 25).padEnd(25)}</Text>
              <Text color="cyan">{schedule.cron_expression.padEnd(15)}</Text>
              <Text color="gray">{schedule.agent_name.slice(0, 15).padEnd(15)}</Text>
              <Text color="gray">{formatNextRun(schedule.next_run_at).padEnd(10)}</Text>
              {schedule.last_run_at && (
                <Text color="gray"> last: {formatNextRun(schedule.last_run_at)}</Text>
              )}
            </Box>
          )}
        />
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          <Text bold color="white">Enter</Text>:toggle enabled{!embedded && <>{' '}<Text bold color="white">Esc</Text>:back</>}
        </Text>
      </Box>
    </Box>
  );
}
