import { useState, useMemo, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  Megaphone,
  MagnifyingGlass,
  XLogo,
  EnvelopeSimple,
  ChatCircle,
  CheckCircle,
  XCircle,
  Clock,
  ArrowClockwise,
} from '@phosphor-icons/react';
import { useWsRefresh } from '../hooks/useWebSocket';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { RowSkeleton } from '../components/Skeleton';
import { api } from '../api/client';

interface MarketingPost {
  id: string;
  provider: string | null;
  deliverable_type: string | null;
  status: string;
  title: string | null;
  text_preview: string;
  agent_name: string | null;
  agent_role: string | null;
  task_title: string | null;
  delivery_ok: boolean | null;
  delivery_error: string | null;
  delivered_at: string | null;
  created_at: string;
  auto_created: boolean;
}

interface ApiResponse {
  data: MarketingPost[];
  total: number;
  limit: number;
  offset: number;
  statusCounts: Record<string, number>;
}

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  delivered:       { bg: 'bg-success/10', text: 'text-success',  label: 'Delivered' },
  approved:        { bg: 'bg-info/10',    text: 'text-info',     label: 'Approved' },
  pending_review:  { bg: 'bg-warning/10', text: 'text-warning',  label: 'Pending' },
  rejected:        { bg: 'bg-critical/10', text: 'text-critical', label: 'Rejected' },
};

const CHANNEL_ICON: Record<string, typeof XLogo> = {
  x: XLogo,
  email: EnvelopeSimple,
  gmail: EnvelopeSimple,
  dm: ChatCircle,
};

type StatusFilter = 'all' | 'delivered' | 'approved' | 'rejected' | 'pending_review';
type DateRange = 'all' | 'today' | '7d' | '30d';

const PAGE_SIZE = 50;

function parseUtc(dateStr: string): Date {
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

function getDateCutoff(range: DateRange): Date | null {
  if (range === 'all') return null;
  const now = new Date();
  if (range === 'today') { now.setHours(0, 0, 0, 0); return now; }
  if (range === '7d') { now.setDate(now.getDate() - 7); return now; }
  now.setDate(now.getDate() - 30);
  return now;
}

function ChannelBadge({ provider }: { provider: string | null }) {
  const Icon = CHANNEL_ICON[provider ?? ''] ?? Megaphone;
  const label = provider === 'x' ? 'X' : provider === 'gmail' ? 'Email' : provider ?? 'Post';
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-white/5 text-neutral-400">
      <Icon size={12} weight="bold" />
      {label}
    </span>
  );
}

function DeliveryIndicator({ ok, error }: { ok: boolean | null; error: string | null }) {
  if (ok === true) return <CheckCircle size={16} weight="fill" className="text-success shrink-0" />;
  if (ok === false) return (
    <span title={error ?? 'Failed'}>
      <XCircle size={16} weight="fill" className="text-critical shrink-0" />
    </span>
  );
  return <Clock size={16} className="text-neutral-500 shrink-0" />;
}

export function MarketingPage() {
  const wsTick = useWsRefresh(['task:completed', 'task:failed']);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [dateRange, setDateRange] = useState<DateRange>('all');
  const [search, setSearch] = useState('');

  const [posts, setPosts] = useState<MarketingPost[] | null>(null);
  const [total, setTotal] = useState(0);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const buildQuery = useCallback((offset: number) => {
    const parts = [`limit=${PAGE_SIZE}`, `offset=${offset}`];
    if (statusFilter !== 'all') parts.push(`status=${statusFilter}`);
    if (providerFilter !== 'all') parts.push(`provider=${providerFilter}`);
    return `/api/marketing/posts?${parts.join('&')}`;
  }, [statusFilter, providerFilter]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<ApiResponse>(buildQuery(0))
      .then(res => {
        if (cancelled) return;
        setPosts(res.data);
        setTotal(res.total);
        setStatusCounts(res.statusCounts);
      })
      .catch(() => { if (!cancelled) { setPosts([]); setTotal(0); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [buildQuery, wsTick]);

  const loadMore = async () => {
    if (!posts || loadingMore || posts.length >= total) return;
    setLoadingMore(true);
    try {
      const res = await api<ApiResponse>(buildQuery(posts.length));
      setPosts([...posts, ...res.data]);
      setTotal(res.total);
    } finally {
      setLoadingMore(false);
    }
  };

  const filtered = useMemo(() => {
    if (!posts) return [];
    let result = posts;

    const cutoff = getDateCutoff(dateRange);
    if (cutoff) {
      result = result.filter(p => parseUtc(p.created_at) >= cutoff);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(p =>
        p.text_preview.toLowerCase().includes(q) ||
        (p.title ?? '').toLowerCase().includes(q) ||
        (p.agent_name ?? '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [posts, dateRange, search]);

  const totalAll = (statusCounts.delivered ?? 0) + (statusCounts.approved ?? 0)
    + (statusCounts.rejected ?? 0) + (statusCounts.pending_review ?? 0);

  return (
    <div className="p-6 max-w-5xl">
      <PageHeader
        title="Marketing"
        subtitle={total > 0
          ? `${posts?.length ?? 0} of ${total} posts shown`
          : 'All outbound content across channels'}
      />

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        {[
          { label: 'Total', value: totalAll, color: 'text-white' },
          { label: 'Delivered', value: statusCounts.delivered ?? 0, color: 'text-success' },
          { label: 'Pending', value: (statusCounts.approved ?? 0) + (statusCounts.pending_review ?? 0), color: 'text-warning' },
          { label: 'Rejected', value: statusCounts.rejected ?? 0, color: 'text-critical' },
        ].map(stat => (
          <div key={stat.label} className="px-4 py-3 rounded-lg border border-white/[0.06] bg-white/[0.02]">
            <p className="text-xs text-neutral-500">{stat.label}</p>
            <p className={`text-2xl font-semibold ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 mb-3 overflow-x-auto">
        {([
          { key: 'all' as StatusFilter, label: 'All', count: totalAll },
          { key: 'delivered' as StatusFilter, label: 'Delivered', count: statusCounts.delivered ?? 0 },
          { key: 'approved' as StatusFilter, label: 'Approved', count: statusCounts.approved ?? 0 },
          { key: 'pending_review' as StatusFilter, label: 'Pending', count: statusCounts.pending_review ?? 0 },
          { key: 'rejected' as StatusFilter, label: 'Rejected', count: statusCounts.rejected ?? 0 },
        ]).map(tab => (
          <button
            key={tab.key}
            onClick={() => setStatusFilter(tab.key)}
            className={`px-3 py-1 rounded text-xs whitespace-nowrap transition-colors ${
              statusFilter === tab.key ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'
            }`}
          >
            {tab.label} <span className="text-neutral-500">{tab.count}</span>
          </button>
        ))}
      </div>

      {/* Channel + date range + search */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="flex gap-1">
          {[
            { key: 'all', label: 'All channels' },
            { key: 'x', label: 'X' },
            { key: 'gmail', label: 'Email' },
          ].map(ch => (
            <button
              key={ch.key}
              onClick={() => setProviderFilter(ch.key)}
              className={`px-2.5 py-1 rounded text-xs transition-colors ${
                providerFilter === ch.key ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'
              }`}
            >
              {ch.label}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-white/10" />

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

        <div className="relative flex-1 min-w-[200px]">
          <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search content..."
            className="w-full bg-white/5 border border-white/10 rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
          />
        </div>
      </div>

      {/* Post list */}
      {loading ? (
        <RowSkeleton count={8} />
      ) : !filtered.length ? (
        <EmptyState
          icon={<Megaphone size={32} />}
          title="No posts yet"
          description={search || statusFilter !== 'all' || providerFilter !== 'all' || dateRange !== 'all'
            ? 'No posts matching your filters.'
            : 'Content will appear here as agents post across channels.'}
        />
      ) : (
        <div className="space-y-1">
          {filtered.map((post, i) => {
            const style = STATUS_STYLES[post.status] ?? STATUS_STYLES.pending_review;
            return (
              <motion.div
                key={post.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.02, 0.3) }}
                className="flex items-start gap-3 px-4 py-3 rounded-lg border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
              >
                {/* Status + channel */}
                <div className="flex flex-col items-center gap-1 shrink-0 pt-0.5">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${style.bg} ${style.text}`}>
                    {style.label}
                  </span>
                  <ChannelBadge provider={post.provider} />
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white leading-relaxed">
                    {post.text_preview || post.title || 'No content'}
                  </p>
                  <div className="flex items-center gap-3 mt-1.5">
                    {post.agent_name && (
                      <span className="text-[11px] text-neutral-500">
                        by {post.agent_name}
                      </span>
                    )}
                    {post.auto_created && (
                      <span className="inline-flex items-center gap-0.5 text-[11px] text-neutral-600">
                        <ArrowClockwise size={10} /> auto
                      </span>
                    )}
                  </div>
                </div>

                {/* Result + time */}
                <div className="flex items-center gap-3 shrink-0">
                  <DeliveryIndicator ok={post.delivery_ok} error={post.delivery_error} />
                  <span className="text-xs text-neutral-500 w-16 text-right">
                    {getTimeAgo(post.delivered_at ?? post.created_at)}
                  </span>
                </div>
              </motion.div>
            );
          })}

          {!loading && posts && posts.length < total && !search && dateRange === 'all' && (
            <div className="flex justify-center pt-3">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="px-4 py-2 text-xs text-neutral-300 border border-white/10 rounded-md hover:bg-white/5 transition-colors disabled:opacity-50"
              >
                {loadingMore ? 'Loading...' : `Load ${Math.min(PAGE_SIZE, total - posts.length)} more`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
