import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { ClockCounterClockwise, MagnifyingGlass } from '@phosphor-icons/react';
import { useApi } from '../hooks/useApi';
import { useWsRefresh } from '../hooks/useWebSocket';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { RowSkeleton } from '../components/Skeleton';

interface ActivityEntry {
  id: string;
  activity_type: string;
  title: string;
  description: string | null;
  agent_id: string | null;
  created_at: string;
}

const TYPE_COLORS: Record<string, string> = {
  task_completed: 'text-success',
  task_failed: 'text-critical',
  task_started: 'text-white',
  task_needs_approval: 'text-warning',
  schedule_fired: 'text-warning',
  agent_created: 'text-white',
  memory_extracted: 'text-warning',
};

const ACTIVITY_TYPES = ['all', 'task_completed', 'task_failed', 'task_started', 'task_needs_approval', 'schedule_fired', 'agent_created', 'memory_extracted'] as const;

type DateRange = 'all' | 'today' | '7d' | '30d';

function getDateCutoff(range: DateRange): Date | null {
  if (range === 'all') return null;
  const now = new Date();
  if (range === 'today') {
    now.setHours(0, 0, 0, 0);
    return now;
  }
  if (range === '7d') {
    now.setDate(now.getDate() - 7);
    return now;
  }
  // 30d
  now.setDate(now.getDate() - 30);
  return now;
}

function getTimeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export function ActivityPage() {
  const wsTick = useWsRefresh(['task:started', 'task:completed', 'task:failed', 'memory:extracted']);
  const { data: activity, loading } = useApi<ActivityEntry[]>('/api/activity', [wsTick]);

  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [dateRange, setDateRange] = useState<DateRange>('all');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!activity) return [];
    let result = activity;

    // Type filter
    if (typeFilter !== 'all') {
      result = result.filter(e => e.activity_type === typeFilter);
    }

    // Date range filter
    const cutoff = getDateCutoff(dateRange);
    if (cutoff) {
      result = result.filter(e => new Date(e.created_at) >= cutoff);
    }

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(e =>
        e.title.toLowerCase().includes(q) ||
        (e.description || '').toLowerCase().includes(q)
      );
    }

    return result;
  }, [activity, typeFilter, dateRange, search]);

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader title="Activity" subtitle="Recent events" />

      {/* Type filter */}
      <div className="flex gap-1 mb-3 overflow-x-auto">
        {ACTIVITY_TYPES.map(t => (
          <button
            key={t}
            onClick={() => setTypeFilter(t)}
            className={`px-3 py-1 rounded text-xs whitespace-nowrap transition-colors ${
              typeFilter === t ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'
            }`}
          >
            {t === 'all' ? 'All' : t.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      {/* Date range + Search */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex gap-1">
          {(['all', 'today', '7d', '30d'] as DateRange[]).map(r => (
            <button
              key={r}
              onClick={() => setDateRange(r)}
              className={`px-2.5 py-1 rounded text-xs transition-colors ${
                dateRange === r ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'
              }`}
            >
              {r === 'all' ? 'All time' : r === 'today' ? 'Today' : r === '7d' ? '7 days' : '30 days'}
            </button>
          ))}
        </div>
        <div className="relative flex-1">
          <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search activity..."
            className="w-full bg-white/5 border border-white/10 rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
          />
        </div>
      </div>

      {loading ? (
        <RowSkeleton count={8} />
      ) : !filtered.length ? (
        <EmptyState
          icon={<ClockCounterClockwise size={32} />}
          title="Quiet so far"
          description={search || typeFilter !== 'all' || dateRange !== 'all'
            ? 'No activity matching your filters.'
            : 'Activity will show up here as agents complete tasks.'}
        />
      ) : (
        <div className="space-y-1">
          {filtered.map((entry, i) => (
            <motion.div
              key={entry.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.02 }}
              className="flex items-start gap-3 px-4 py-3 rounded-lg border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
            >
              <span className={`text-xs font-mono mt-0.5 shrink-0 ${TYPE_COLORS[entry.activity_type] || 'text-neutral-400'}`}>
                {entry.activity_type.replace(/_/g, ' ')}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm">{entry.title}</p>
                {entry.description && <p className="text-xs text-neutral-500 mt-0.5">{entry.description}</p>}
              </div>
              <span className="text-xs text-neutral-500 shrink-0">
                {getTimeAgo(entry.created_at)}
              </span>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
