import { useState, useMemo, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ListChecks, Plus, MagnifyingGlass, FileText } from '@phosphor-icons/react';
import { useApi } from '../hooks/useApi';
import { useWsRefresh } from '../hooks/useWebSocket';
import { StatusBadge } from '../components/StatusBadge';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { RowSkeleton } from '../components/Skeleton';
import { api } from '../api/client';

interface Task {
  id: string;
  title: string;
  status: string;
  agent_id: string;
  tokens_used: number | null;
  cost_cents: number | null;
  priority: string | null;
  created_at: string;
}

interface Agent {
  id: string;
  name: string;
}

interface DeliverableRow {
  id: string;
  task_id: string | null;
  deliverable_type: string;
  title: string;
  status: string;
  auto_created: number;
  created_at: string;
}

const STATUSES = ['all', 'pending', 'in_progress', 'needs_approval', 'approved', 'completed', 'failed'] as const;
const PAGE_SIZE = 50;
const DELIVERABLE_STATUSES = ['all', 'pending_review', 'approved', 'delivered', 'rejected'] as const;

type SortMode = 'date' | 'priority' | 'status';

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const STATUS_ORDER: Record<string, number> = { in_progress: 0, pending: 1, needs_approval: 2, completed: 3, failed: 4 };

export function TasksPage() {
  const wsTick = useWsRefresh(['task:started', 'task:completed', 'task:failed']);
  const [viewMode, setViewMode] = useState<'tasks' | 'deliverables'>('tasks');
  const [filter, setFilter] = useState('all');
  const [delFilter, setDelFilter] = useState('all');
  const [showDispatch, setShowDispatch] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortMode>('date');

  const { data: agents } = useApi<Agent[]>('/api/agents');

  // Paginated task list. Refetch resets the list; "Load more" appends.
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const buildQuery = useCallback((offset: number) => {
    const parts = [`limit=${PAGE_SIZE}`, `offset=${offset}`];
    if (filter !== 'all') parts.push(`status=${filter}`);
    return `/api/tasks?${parts.join('&')}`;
  }, [filter]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<{ data: Task[]; total: number }>(buildQuery(0))
      .then(res => {
        if (cancelled) return;
        setTasks(res.data);
        setTotal(res.total);
      })
      .catch(() => { if (!cancelled) { setTasks([]); setTotal(0); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [buildQuery, wsTick]);

  const refetch = useCallback(() => {
    api<{ data: Task[]; total: number }>(buildQuery(0))
      .then(res => { setTasks(res.data); setTotal(res.total); })
      .catch(() => {});
  }, [buildQuery]);

  const loadMore = async () => {
    if (!tasks || loadingMore || tasks.length >= total) return;
    setLoadingMore(true);
    try {
      const res = await api<{ data: Task[]; total: number }>(buildQuery(tasks.length));
      setTasks([...tasks, ...res.data]);
      setTotal(res.total);
    } finally {
      setLoadingMore(false);
    }
  };

  const delStatusParam = delFilter === 'all' ? '' : `?status=${delFilter}`;
  const { data: deliverables, loading: delLoading } = useApi<DeliverableRow[]>(
    viewMode === 'deliverables' ? `/api/deliverables${delStatusParam}` : null,
    [wsTick, delFilter, viewMode],
  );

  const agentMap = useMemo(() => {
    const map = new Map<string, string>();
    agents?.forEach(a => map.set(a.id, a.name));
    return map;
  }, [agents]);

  const filteredAndSorted = useMemo(() => {
    if (!tasks) return [];
    let result = tasks;

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(t =>
        t.title.toLowerCase().includes(q) ||
        (agentMap.get(t.agent_id) || '').toLowerCase().includes(q)
      );
    }

    // Sort
    if (sort === 'priority') {
      result = [...result].sort((a, b) => {
        const pa = PRIORITY_ORDER[a.priority || 'normal'] ?? 2;
        const pb = PRIORITY_ORDER[b.priority || 'normal'] ?? 2;
        return pa - pb || new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
    } else if (sort === 'status') {
      result = [...result].sort((a, b) => {
        const sa = STATUS_ORDER[a.status] ?? 5;
        const sb = STATUS_ORDER[b.status] ?? 5;
        return sa - sb || new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
    }
    // 'date' sort is already the API default (newest first)

    return result;
  }, [tasks, search, sort, agentMap]);

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Tasks"
        subtitle={viewMode === 'tasks' && total > 0
          ? `${tasks?.length ?? 0} of ${total}${filter === 'all' ? '' : ` ${filter.replace(/_/g, ' ')}`} shown`
          : 'All agent tasks'}
        action={
          <button
            onClick={() => setShowDispatch(!showDispatch)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors"
          >
            <Plus size={14} /> New task
          </button>
        }
      />

      {/* View mode toggle */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setViewMode('tasks')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${viewMode === 'tasks' ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'}`}
        >
          <ListChecks size={14} /> Tasks
        </button>
        <button
          onClick={() => setViewMode('deliverables')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${viewMode === 'deliverables' ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'}`}
        >
          <FileText size={14} /> Deliverables
        </button>
      </div>

      {viewMode === 'tasks' ? (
        <>
          {showDispatch && agents?.length ? (
            <DispatchForm agents={agents} onClose={() => setShowDispatch(false)} onSuccess={refetch} />
          ) : null}

          {/* Filter tabs */}
          <div className="flex gap-1 mb-4 overflow-x-auto">
            {STATUSES.map(s => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={`px-3 py-1.5 rounded-md text-xs capitalize transition-colors ${
                  filter === s ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'
                }`}
              >
                {s.replace(/_/g, ' ')}
              </button>
            ))}
          </div>

          {/* Search + Sort */}
          <div className="flex items-center gap-3 mb-4">
            <div className="relative flex-1">
              <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search by title or agent..."
                className="w-full bg-white/5 border border-white/10 rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
              />
            </div>
            <select
              value={sort}
              onChange={e => setSort(e.target.value as SortMode)}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20"
            >
              <option value="date">Sort by date</option>
              <option value="priority">Sort by priority</option>
              <option value="status">Sort by status</option>
            </select>
          </div>

          {loading ? (
            <RowSkeleton count={5} />
          ) : !filteredAndSorted.length ? (
            <EmptyState
              icon={<ListChecks size={32} />}
              title="Nothing here yet"
              description={search ? `No tasks matching "${search}".` : filter === 'all' ? 'Tasks will appear as agents work.' : `No ${filter.replace(/_/g, ' ')} tasks.`}
            />
          ) : (
            <div className="bg-white/5 border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
              {filteredAndSorted.map(task => (
                <Link key={task.id} to={`/tasks/${task.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors">
                  <div className="min-w-0 mr-3">
                    <p className="text-sm font-medium truncate">{task.title}</p>
                    <p className="text-xs text-neutral-400">
                      {agentMap.get(task.agent_id) && <span className="text-white">{agentMap.get(task.agent_id)}</span>}
                      {agentMap.get(task.agent_id) && ' · '}
                      {new Date(task.created_at).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {task.priority && task.priority !== 'normal' && (
                      <span className="text-xs text-warning">{task.priority}</span>
                    )}
                    {task.tokens_used ? <span className="text-xs text-neutral-400">{task.tokens_used.toLocaleString()} tok</span> : null}
                    <StatusBadge status={task.status} />
                  </div>
                </Link>
              ))}
            </div>
          )}
          {!loading && tasks && tasks.length < total && !search && (
            <div className="flex justify-center mt-4">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="px-4 py-2 text-xs text-neutral-300 border border-white/10 rounded-md hover:bg-white/5 transition-colors disabled:opacity-50"
              >
                {loadingMore ? 'Loading...' : `Load ${Math.min(PAGE_SIZE, total - tasks.length)} more`}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Deliverables filter tabs */}
          <div className="flex gap-1 mb-4 overflow-x-auto">
            {DELIVERABLE_STATUSES.map(s => (
              <button
                key={s}
                onClick={() => setDelFilter(s)}
                className={`px-3 py-1.5 rounded-md text-xs capitalize transition-colors ${
                  delFilter === s ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'
                }`}
              >
                {s.replace(/_/g, ' ')}
              </button>
            ))}
          </div>

          {delLoading ? (
            <RowSkeleton count={5} />
          ) : !deliverables?.length ? (
            <EmptyState
              icon={<FileText size={32} />}
              title="No deliverables yet"
              description="Deliverables are created when agents produce work products like drafts, reports, and plans."
            />
          ) : (
            <div className="bg-white/5 border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
              {deliverables.map(d => {
                const typeBadge: Record<string, string> = {
                  email: 'bg-blue-500/15 text-blue-400',
                  code: 'bg-green-500/15 text-green-400',
                  report: 'bg-purple-500/15 text-purple-400',
                  creative: 'bg-pink-500/15 text-pink-400',
                  plan: 'bg-cyan-500/15 text-cyan-400',
                  data: 'bg-amber-500/15 text-amber-400',
                  document: 'bg-white/5 text-neutral-400',
                };
                const typeStyle = typeBadge[d.deliverable_type] || 'bg-white/5 text-neutral-400';

                return (
                  <div key={d.id} className="flex items-center justify-between px-4 py-3">
                    <div className="min-w-0 mr-3 flex items-center gap-2">
                      {d.task_id ? (
                        <Link to={`/tasks/${d.task_id}`} className="text-sm font-medium truncate hover:text-blue-400 transition-colors">
                          {d.title}
                        </Link>
                      ) : (
                        <span className="text-sm font-medium truncate">{d.title}</span>
                      )}
                      {d.auto_created === 1 && (
                        <span className="text-[10px] text-neutral-500 bg-white/5 px-1.5 py-0.5 rounded shrink-0">auto</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${typeStyle}`}>
                        {d.deliverable_type}
                      </span>
                      <StatusBadge status={d.status} />
                      <span className="text-xs text-neutral-500">{new Date(d.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DispatchForm({ agents, onClose, onSuccess }: { agents: Agent[]; onClose: () => void; onSuccess: () => void }) {
  const [agentId, setAgentId] = useState(agents[0]?.id || '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentId || !title.trim()) return;
    setSubmitting(true);
    try {
      await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ agentId, title: title.trim(), description: description.trim() || undefined }),
      });
      onSuccess();
      onClose();
    } catch {
      // Error handling via toast later
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white/5 border border-white/[0.08] rounded-lg p-4 mb-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Agent</label>
          <select
            value={agentId}
            onChange={e => setAgentId(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20"
          >
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Title</label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="What should this agent do?"
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
          />
        </div>
      </div>
      <div>
        <label className="text-xs text-neutral-400 block mb-1">Description (optional)</label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={2}
          className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20 resize-none"
        />
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors">Cancel</button>
        <button
          type="submit"
          disabled={submitting || !title.trim()}
          className="px-4 py-1.5 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors"
        >
          {submitting ? 'Dispatching...' : 'Dispatch'}
        </button>
      </div>
    </form>
  );
}
