import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ListChecks, Plus, MagnifyingGlass } from '@phosphor-icons/react';
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

const STATUSES = ['all', 'pending', 'in_progress', 'completed', 'needs_approval', 'failed'] as const;

type SortMode = 'date' | 'priority' | 'status';

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const STATUS_ORDER: Record<string, number> = { in_progress: 0, pending: 1, needs_approval: 2, completed: 3, failed: 4 };

export function TasksPage() {
  const wsTick = useWsRefresh(['task:started', 'task:completed', 'task:failed']);
  const [filter, setFilter] = useState('all');
  const [showDispatch, setShowDispatch] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortMode>('date');

  const statusParam = filter === 'all' ? '' : `&status=${filter}`;
  const { data: tasks, loading, refetch } = useApi<Task[]>(`/api/tasks?limit=50${statusParam}`, [wsTick, filter]);
  const { data: agents } = useApi<Agent[]>('/api/agents');

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
        subtitle="All agent tasks"
        action={
          <button
            onClick={() => setShowDispatch(!showDispatch)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors"
          >
            <Plus size={14} /> New task
          </button>
        }
      />

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
