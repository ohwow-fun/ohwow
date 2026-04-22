/**
 * ActivityLog Screen
 * Real-time activity feed with type filter, date range, and search.
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { useActivity } from '../hooks/use-activity.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { ActivityEntry } from '../components/activity-entry.js';
import { InputField } from '../components/input-field.js';

interface ActivityLogProps {
  db: DatabaseAdapter | null;
}

type TypeFilter = 'all' | 'task_completed' | 'task_failed' | 'task_started' | 'task_needs_approval';
type DateFilter = 'all' | 'today' | '7d' | '30d';

const TYPE_FILTERS: TypeFilter[] = ['all', 'task_completed', 'task_failed', 'task_started', 'task_needs_approval'];
const DATE_FILTERS: DateFilter[] = ['all', 'today', '7d', '30d'];

const TYPE_LABELS: Record<TypeFilter, string> = {
  all: 'all',
  task_completed: 'completed',
  task_failed: 'failed',
  task_started: 'started',
  task_needs_approval: 'approval',
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

function getDateCutoff(dateFilter: DateFilter): Date | null {
  if (dateFilter === 'all') return null;
  const now = new Date();
  if (dateFilter === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (dateFilter === '7d') {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
  // 30d
  return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
}

export function ActivityLog({ db }: ActivityLogProps) {
  const { list } = useActivity(db);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
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
      const idx = TYPE_FILTERS.indexOf(typeFilter);
      setTypeFilter(TYPE_FILTERS[(idx + 1) % TYPE_FILTERS.length]);
      return;
    }

    if (input === 'd') {
      const idx = DATE_FILTERS.indexOf(dateFilter);
      setDateFilter(DATE_FILTERS[(idx + 1) % DATE_FILTERS.length]);
      return;
    }

    if (input === '/') {
      setSearching(true);
      return;
    }
  });

  const filtered = useMemo(() => {
    let result = list;

    // Type filter
    if (typeFilter !== 'all') {
      result = result.filter(a => a.activity_type === typeFilter);
    }

    // Date filter
    const cutoff = getDateCutoff(dateFilter);
    if (cutoff) {
      result = result.filter(a => new Date(a.created_at) >= cutoff);
    }

    // Search
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(a =>
        a.title.toLowerCase().includes(q) ||
        (a.description || '').toLowerCase().includes(q)
      );
    }

    return result;
  }, [list, typeFilter, dateFilter, search]);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>Activity ({filtered.length}/{list.length})</Text>
        {typeFilter !== 'all' && <Text color="yellow">  [type:{TYPE_LABELS[typeFilter]}]</Text>}
        {dateFilter !== 'all' && <Text color="cyan">  [range:{dateFilter}]</Text>}
        {search && <Text color="green">  [search:{search}]</Text>}
      </Box>

      {searching && (
        <Box marginTop={1}>
          <InputField
            label="Search"
            value={search}
            onChange={setSearch}
            onSubmit={() => setSearching(false)}
            placeholder="Type to filter activity..."
          />
        </Box>
      )}

      <Box marginTop={1}>
        <ScrollableList
          items={filtered}
          emptyMessage={typeFilter !== 'all' || dateFilter !== 'all'
            ? 'No matching activity. Press f/d to change filters.'
            : '◌ No activity yet. Your operatives will log their work here.'
          }
          renderItem={(activity, _, isSelected) => (
            <ActivityEntry
              activityType={activity.activity_type}
              title={activity.title}
              description={activity.description}
              timeAgo={getTimeAgo(activity.created_at)}
              isSelected={isSelected}
            />
          )}
        />
      </Box>

      <Box marginTop={1}>
        <Text color="gray">
          <Text bold color="white">f</Text>:type  <Text bold color="white">d</Text>:date range  <Text bold color="white">/</Text>:search
        </Text>
      </Box>
    </Box>
  );
}
