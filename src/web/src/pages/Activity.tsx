import { useState, useMemo, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { ClockCounterClockwise, MagnifyingGlass } from '@phosphor-icons/react';
import { useWsRefresh } from '../hooks/useWebSocket';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { RowSkeleton } from '../components/Skeleton';
import { api } from '../api/client';

interface ActivityEntry {
  id: string;
  activity_type: string;
  title: string;
  description: string | null;
  agent_id: string | null;
  created_at: string;
}

interface TypeCount { type: string; count: number }

const TYPE_COLORS: Record<string, string> = {
  task_completed: 'text-success',
  task_failed: 'text-critical',
  task_started: 'text-white',
  task_needs_approval: 'text-warning',
  trigger_fired: 'text-warning',
  schedule_fired: 'text-warning',
  agent_created: 'text-white',
  orchestrator_tool: 'text-neutral-300',
  orchestrator_tool_failed: 'text-critical',
  permission_requested: 'text-warning',
  permission_approved: 'text-success',
  permission_denied: 'text-critical',
  memory_extracted: 'text-warning',
};

const PAGE_SIZE = 50;

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

function parseUtc(dateStr: string): Date {
  // Server now normalizes to ISO-8601 UTC. Older legacy strings without a
  // timezone suffix are still treated as UTC to match historical writer intent.
  if (!dateStr) return new Date(NaN);
  if (/Z$|[+-]\d\d:?\d\d$/.test(dateStr)) return new Date(dateStr);
  return new Date(dateStr.replace(' ', 'T') + 'Z');
}

function getTimeAgo(dateStr: string): string {
  const diffMs = Date.now() - parseUtc(dateStr).getTime();
  if (diffMs < 0) return 'just now';
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 30) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export function ActivityPage() {
  const wsTick = useWsRefresh(['task:started', 'task:completed', 'task:failed', 'memory:extracted']);

  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [dateRange, setDateRange] = useState<DateRange>('all');
  const [search, setSearch] = useState('');

  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [types, setTypes] = useState<TypeCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const buildQuery = useCallback((offset: number) => {
    const parts = [`limit=${PAGE_SIZE}`, `offset=${offset}`];
    if (typeFilter !== 'all') parts.push(`activityType=${typeFilter}`);
    return `/api/activity?${parts.join('&')}`;
  }, [typeFilter]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<{ data: ActivityEntry[]; total: number; types: TypeCount[] }>(buildQuery(0))
      .then(res => {
        if (cancelled) return;
        setActivity(res.data);
        setTotal(res.total);
        setTypes(res.types);
      })
      .catch(() => { if (!cancelled) { setActivity([]); setTotal(0); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [buildQuery, wsTick]);

  const loadMore = async () => {
    if (!activity || loadingMore || activity.length >= total) return;
    setLoadingMore(true);
    try {
      const res = await api<{ data: ActivityEntry[]; total: number }>(buildQuery(activity.length));
      setActivity([...activity, ...res.data]);
      setTotal(res.total);
    } finally {
      setLoadingMore(false);
    }
  };

  const filtered = useMemo(() => {
    if (!activity) return [];
    let result = activity;

    // Date range and search are still client-side (operates on loaded window).
    const cutoff = getDateCutoff(dateRange);
    if (cutoff) {
      result = result.filter(e => parseUtc(e.created_at) >= cutoff);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(e =>
        e.title.toLowerCase().includes(q) ||
        (e.description || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [activity, dateRange, search]);

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Activity"
        subtitle={total > 0
          ? `${activity?.length ?? 0} of ${total}${typeFilter === 'all' ? '' : ` ${typeFilter.replace(/_/g, ' ')}`} shown`
          : 'Recent events'}
      />

      {/* Type filter — derived from real DB distribution */}
      <div className="flex gap-1 mb-3 overflow-x-auto">
        <button
          onClick={() => setTypeFilter('all')}
          className={`px-3 py-1 rounded text-xs whitespace-nowrap transition-colors ${
            typeFilter === 'all' ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'
          }`}
        >
          All
        </button>
        {types.map(({ type, count }) => (
          <button
            key={type}
            onClick={() => setTypeFilter(type)}
            className={`px-3 py-1 rounded text-xs whitespace-nowrap transition-colors ${
              typeFilter === type ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'
            }`}
          >
            {type.replace(/_/g, ' ')} <span className="text-neutral-500">{count}</span>
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
          {!loading && activity && activity.length < total && !search && dateRange === 'all' && (
            <div className="flex justify-center pt-3">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="px-4 py-2 text-xs text-neutral-300 border border-white/10 rounded-md hover:bg-white/5 transition-colors disabled:opacity-50"
              >
                {loadingMore ? 'Loading...' : `Load ${Math.min(PAGE_SIZE, total - activity.length)} more`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
