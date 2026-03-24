/**
 * TasksList Screen
 * Task list with filtering, sorting, and search.
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { ScrollableList } from '../components/scrollable-list.js';
import { TaskRow } from '../components/task-row.js';
import { InputField } from '../components/input-field.js';

interface Task {
  id: string;
  agent_id: string;
  title: string;
  status: string;
  tokens_used: number | null;
  priority?: string | null;
  created_at: string;
}

interface Agent {
  id: string;
  name: string;
}

interface TasksListProps {
  tasks: Task[];
  agents: Agent[];
  onSelect: (id: string) => void;
}

type StatusFilter = 'all' | 'pending' | 'in_progress' | 'completed' | 'failed' | 'needs_approval';
type SortMode = 'date' | 'priority' | 'status';

const STATUS_FILTERS: StatusFilter[] = ['all', 'pending', 'in_progress', 'completed', 'failed', 'needs_approval'];
const SORT_MODES: SortMode[] = ['date', 'priority', 'status'];

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  needs_approval: 1,
  pending: 2,
  completed: 3,
  approved: 4,
  failed: 5,
};

function getTimeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export function TasksList({ tasks, agents, onSelect }: TasksListProps) {
  const agentMap = useMemo(() => new Map(agents.map(a => [a.id, a.name])), [agents]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('date');
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);

  useInput((input, key) => {
    if (searching) {
      if (key.escape) {
        setSearching(false);
        setSearch('');
      }
      return;
    }

    if (input === 'f') {
      const idx = STATUS_FILTERS.indexOf(statusFilter);
      setStatusFilter(STATUS_FILTERS[(idx + 1) % STATUS_FILTERS.length]);
      return;
    }

    if (input === 's') {
      const idx = SORT_MODES.indexOf(sortMode);
      setSortMode(SORT_MODES[(idx + 1) % SORT_MODES.length]);
      return;
    }

    if (input === '/') {
      setSearching(true);
      return;
    }
  });

  const filtered = useMemo(() => {
    let result = tasks;

    // Status filter
    if (statusFilter !== 'all') {
      result = result.filter(t => t.status === statusFilter);
    }

    // Search filter
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(t =>
        t.title.toLowerCase().includes(q) ||
        (agentMap.get(t.agent_id) || '').toLowerCase().includes(q)
      );
    }

    // Sort
    result = [...result].sort((a, b) => {
      if (sortMode === 'priority') {
        const pa = PRIORITY_ORDER[a.priority || 'normal'] ?? 2;
        const pb = PRIORITY_ORDER[b.priority || 'normal'] ?? 2;
        if (pa !== pb) return pa - pb;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
      if (sortMode === 'status') {
        const sa = STATUS_ORDER[a.status] ?? 5;
        const sb = STATUS_ORDER[b.status] ?? 5;
        if (sa !== sb) return sa - sb;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    return result;
  }, [tasks, statusFilter, sortMode, search, agentMap]);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>Tasks ({filtered.length}/{tasks.length})</Text>
        {statusFilter !== 'all' && <Text color="yellow">  [filter:{statusFilter}]</Text>}
        {sortMode !== 'date' && <Text color="cyan">  [sort:{sortMode}]</Text>}
        {search && <Text color="green">  [search:{search}]</Text>}
      </Box>

      {searching && (
        <Box marginTop={1}>
          <InputField
            label="Search"
            value={search}
            onChange={setSearch}
            onSubmit={() => setSearching(false)}
            placeholder="Type to filter tasks..."
          />
        </Box>
      )}

      <Box marginTop={1}>
        <ScrollableList
          items={filtered}
          onSelect={(task) => onSelect(task.id)}
          emptyMessage={statusFilter !== 'all'
            ? `No ${statusFilter.replace('_', ' ')} tasks. Press f to change filter.`
            : "No tasks yet. Dispatch a task with 'n' or wait for cloud commands."
          }
          renderItem={(task, _, isSelected) => (
            <TaskRow
              title={task.title}
              status={task.status}
              agentName={agentMap.get(task.agent_id)}
              timeAgo={getTimeAgo(task.created_at)}
              tokensUsed={task.tokens_used}
              priority={task.priority}
              isSelected={isSelected}
            />
          )}
        />
      </Box>

      <Box marginTop={1}>
        <Text color="gray">
          <Text bold color="white">f</Text>:filter  <Text bold color="white">s</Text>:sort  <Text bold color="white">/</Text>:search  <Text bold color="white">n</Text>:new task
        </Text>
      </Box>
    </Box>
  );
}
