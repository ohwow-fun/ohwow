import { useState, useMemo, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  ChatsCircle,
  MagnifyingGlass,
  XLogo,
  ThreadsLogo,
  ChatCircle,
  Megaphone,
  Heart,
  ArrowsClockwise,
  Eye,
  ArrowUpRight,
} from '@phosphor-icons/react';
import { useWsRefresh } from '../hooks/useWebSocket';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { RowSkeleton } from '../components/Skeleton';
import { api } from '../api/client';

type Platform = 'x' | 'threads';
type Kind = 'post' | 'reply';
type PlatformFilter = Platform | 'all';
type KindFilter = Kind | 'all';
type DateRange = 'all' | 'today' | '7d' | '30d';

interface Engagement {
  likes: number;
  replies: number;
  reposts: number;
  views: number;
  permalink: string;
  last_seen_at: string;
}

interface SocialRow {
  id: string;
  platform: Platform;
  kind: Kind;
  text_preview: string;
  text_length: number;
  text_hash: string;
  posted_at: string;
  source: string | null;
  reply_to_url: string | null;
  approval_id: string | null;
  task_id: string | null;
  task_title: string | null;
  engagement: Engagement | null;
}

interface ApiResponse {
  data: SocialRow[];
  total: number;
  limit: number;
  offset: number;
  platformCounts: { x: number; threads: number };
  kindCounts: { post: number; reply: number };
}

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

function formatCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1e6) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}m`;
}

function shortenReplyUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\//, '');
  } catch {
    return url;
  }
}

function PlatformBadge({ platform }: { platform: Platform }) {
  if (platform === 'x') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-white/5 text-neutral-300">
        <XLogo size={11} weight="bold" /> X
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-white/5 text-neutral-300">
      <ThreadsLogo size={12} weight="bold" /> Threads
    </span>
  );
}

function KindBadge({ kind }: { kind: Kind }) {
  if (kind === 'reply') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-info/10 text-info">
        <ChatCircle size={10} weight="bold" /> Reply
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-white/5 text-neutral-300">
      <Megaphone size={10} weight="bold" /> Post
    </span>
  );
}

function EngagementStrip({ eng }: { eng: Engagement }) {
  return (
    <div className="flex items-center gap-3 text-[11px] text-neutral-500">
      <span className="inline-flex items-center gap-1" title={`${eng.likes} likes`}>
        <Heart size={11} weight="bold" /> {formatCompact(eng.likes)}
      </span>
      <span className="inline-flex items-center gap-1" title={`${eng.replies} replies`}>
        <ChatCircle size={11} weight="bold" /> {formatCompact(eng.replies)}
      </span>
      <span className="inline-flex items-center gap-1" title={`${eng.reposts} reposts`}>
        <ArrowsClockwise size={11} weight="bold" /> {formatCompact(eng.reposts)}
      </span>
      <span className="inline-flex items-center gap-1" title={`${eng.views} views`}>
        <Eye size={11} weight="bold" /> {formatCompact(eng.views)}
      </span>
      <a
        href={eng.permalink.startsWith('http') ? eng.permalink : `https://x.com${eng.permalink}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-0.5 text-neutral-500 hover:text-white transition-colors"
      >
        <ArrowUpRight size={10} weight="bold" /> view
      </a>
    </div>
  );
}

export function SocialPage() {
  const wsTick = useWsRefresh(['task:completed', 'task:failed']);

  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>('all');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [dateRange, setDateRange] = useState<DateRange>('all');
  const [search, setSearch] = useState('');

  const [rows, setRows] = useState<SocialRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [platformCounts, setPlatformCounts] = useState<{ x: number; threads: number }>({ x: 0, threads: 0 });
  const [kindCounts, setKindCounts] = useState<{ post: number; reply: number }>({ post: 0, reply: 0 });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const buildQuery = useCallback((offset: number) => {
    const parts = [`limit=${PAGE_SIZE}`, `offset=${offset}`];
    if (platformFilter !== 'all') parts.push(`platform=${platformFilter}`);
    if (kindFilter !== 'all') parts.push(`kind=${kindFilter}`);
    return `/api/social/posts?${parts.join('&')}`;
  }, [platformFilter, kindFilter]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<ApiResponse>(buildQuery(0))
      .then((res) => {
        if (cancelled) return;
        setRows(res.data);
        setTotal(res.total);
        setPlatformCounts(res.platformCounts);
        setKindCounts(res.kindCounts);
      })
      .catch(() => { if (!cancelled) { setRows([]); setTotal(0); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [buildQuery, wsTick]);

  const loadMore = async () => {
    if (!rows || loadingMore || rows.length >= total) return;
    setLoadingMore(true);
    try {
      const res = await api<ApiResponse>(buildQuery(rows.length));
      setRows([...rows, ...res.data]);
      setTotal(res.total);
    } finally {
      setLoadingMore(false);
    }
  };

  const filtered = useMemo(() => {
    if (!rows) return [];
    let result = rows;
    const cutoff = getDateCutoff(dateRange);
    if (cutoff) result = result.filter((r) => parseUtc(r.posted_at) >= cutoff);
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((r) =>
        r.text_preview.toLowerCase().includes(q) ||
        (r.task_title ?? '').toLowerCase().includes(q) ||
        (r.reply_to_url ?? '').toLowerCase().includes(q),
      );
    }
    return result;
  }, [rows, dateRange, search]);

  const totalAll = platformCounts.x + platformCounts.threads;

  return (
    <div className="p-6 max-w-5xl">
      <PageHeader
        title="Social"
        subtitle={total > 0
          ? `${rows?.length ?? 0} of ${total} shown`
          : 'Every posted X + Threads item, including replies'}
      />

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        {[
          { label: 'Total', value: totalAll, color: 'text-white' },
          { label: 'X', value: platformCounts.x, color: 'text-white' },
          { label: 'Threads', value: platformCounts.threads, color: 'text-white' },
          { label: 'Replies', value: kindCounts.reply, color: 'text-info' },
        ].map((stat) => (
          <div key={stat.label} className="px-4 py-3 rounded-lg border border-white/[0.06] bg-white/[0.02]">
            <p className="text-xs text-neutral-500">{stat.label}</p>
            <p className={`text-2xl font-semibold ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Platform tabs */}
      <div className="flex gap-1 mb-3 overflow-x-auto">
        {([
          { key: 'all' as PlatformFilter, label: 'All', count: totalAll },
          { key: 'x' as PlatformFilter, label: 'X', count: platformCounts.x },
          { key: 'threads' as PlatformFilter, label: 'Threads', count: platformCounts.threads },
        ]).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setPlatformFilter(tab.key)}
            className={`px-3 py-1 rounded text-xs whitespace-nowrap transition-colors ${
              platformFilter === tab.key ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'
            }`}
          >
            {tab.label} <span className="text-neutral-500">{tab.count}</span>
          </button>
        ))}
      </div>

      {/* Kind + date + search */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="flex gap-1">
          {([
            { key: 'all' as KindFilter, label: 'All kinds' },
            { key: 'post' as KindFilter, label: `Posts (${kindCounts.post})` },
            { key: 'reply' as KindFilter, label: `Replies (${kindCounts.reply})` },
          ]).map((k) => (
            <button
              key={k.key}
              onClick={() => setKindFilter(k.key)}
              className={`px-2.5 py-1 rounded text-xs transition-colors ${
                kindFilter === k.key ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-white/10" />

        <div className="flex gap-1">
          {(['all', 'today', '7d', '30d'] as DateRange[]).map((r) => (
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
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search text, task, reply target..."
            className="w-full bg-white/5 border border-white/10 rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
          />
        </div>
      </div>

      {/* Row list */}
      {loading ? (
        <RowSkeleton count={8} />
      ) : !filtered.length ? (
        <EmptyState
          icon={<ChatsCircle size={32} />}
          title="Nothing posted yet"
          description={search || platformFilter !== 'all' || kindFilter !== 'all' || dateRange !== 'all'
            ? 'No posts matching your filters.'
            : 'Published X and Threads content will show up here.'}
        />
      ) : (
        <div className="space-y-1">
          {filtered.map((row, i) => (
            <motion.div
              key={row.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.02, 0.3) }}
              className="flex items-start gap-3 px-4 py-3 rounded-lg border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
            >
              {/* Platform + kind */}
              <div className="flex flex-col items-start gap-1 shrink-0 pt-0.5 w-24">
                <KindBadge kind={row.kind} />
                <PlatformBadge platform={row.platform} />
              </div>

              {/* Content */}
              <div className="min-w-0 flex-1">
                <p className="text-sm text-white leading-relaxed whitespace-pre-wrap">
                  {row.text_preview || '(no preview)'}
                </p>
                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                  {row.kind === 'reply' && row.reply_to_url && (
                    <a
                      href={row.reply_to_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-info hover:underline inline-flex items-center gap-0.5"
                      title={row.reply_to_url}
                    >
                      <ArrowUpRight size={10} weight="bold" />
                      to {shortenReplyUrl(row.reply_to_url)}
                    </a>
                  )}
                  {row.task_title && (
                    <span className="text-[11px] text-neutral-500 truncate max-w-[240px]">
                      {row.task_title}
                    </span>
                  )}
                  {row.engagement && <EngagementStrip eng={row.engagement} />}
                </div>
              </div>

              {/* Time */}
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-xs text-neutral-500 w-16 text-right">
                  {getTimeAgo(row.posted_at)}
                </span>
              </div>
            </motion.div>
          ))}

          {!loading && rows && rows.length < total && !search && dateRange === 'all' && (
            <div className="flex justify-center pt-3">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="px-4 py-2 text-xs text-neutral-300 border border-white/10 rounded-md hover:bg-white/5 transition-colors disabled:opacity-50"
              >
                {loadingMore ? 'Loading...' : `Load ${Math.min(PAGE_SIZE, total - rows.length)} more`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
