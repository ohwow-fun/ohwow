import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Kanban, Plus, MagnifyingGlass } from '@phosphor-icons/react';
import { useApi } from '../hooks/useApi';
import { useWsRefresh } from '../hooks/useWebSocket';
import { StatusBadge } from '../components/StatusBadge';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { RowSkeleton } from '../components/Skeleton';
import { api } from '../api/client';

interface Project {
  id: string;
  name: string;
  description: string | null;
  status: string;
  color: string | null;
  created_at: string;
}

const STATUSES = ['all', 'active', 'completed', 'archived'] as const;

const COLOR_MAP: Record<string, string> = {
  blue: 'bg-blue-500/20 border-blue-500/40',
  green: 'bg-success/20 border-success/40',
  red: 'bg-critical/20 border-critical/40',
  yellow: 'bg-warning/20 border-warning/40',
  purple: 'bg-warning/20 border-warning/40',
};

export function ProjectsPage() {
  const wsTick = useWsRefresh(['project:created', 'project:updated']);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);

  const { data: projects, loading, refetch } = useApi<Project[]>('/api/projects', [wsTick]);

  const filtered = useMemo(() => {
    if (!projects) return [];
    let result = projects;
    if (filter !== 'all') {
      result = result.filter(p => p.status === filter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(p =>
        p.name.toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [projects, filter, search]);

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Projects"
        subtitle="Organize work into projects"
        action={
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors"
          >
            <Plus size={14} /> New project
          </button>
        }
      />

      {showForm && (
        <NewProjectForm onClose={() => setShowForm(false)} onSuccess={refetch} />
      )}

      {/* Status filter */}
      <div className="flex gap-1 mb-4 overflow-x-auto">
        {STATUSES.map(s => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1 rounded text-xs capitalize transition-colors ${
              filter === s ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search projects..."
          className="w-full bg-white/5 border border-white/10 rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
        />
      </div>

      {loading ? (
        <RowSkeleton count={4} />
      ) : !filtered.length ? (
        <EmptyState
          icon={<Kanban size={32} />}
          title="No projects yet"
          description={search ? `No projects matching "${search}".` : 'Create your first project to organize work.'}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {filtered.map(project => (
            <Link
              key={project.id}
              to={`/projects/${project.id}`}
              className={`border rounded-lg p-4 hover:bg-white/[0.02] transition-colors ${
                project.color && COLOR_MAP[project.color] ? COLOR_MAP[project.color] : 'border-white/[0.08]'
              }`}
            >
              <div className="flex items-start justify-between mb-2">
                <h3 className="text-sm font-medium truncate">{project.name}</h3>
                <StatusBadge status={project.status} />
              </div>
              {project.description && (
                <p className="text-xs text-neutral-400 line-clamp-2">{project.description}</p>
              )}
              <p className="text-xs text-neutral-400 mt-2">{new Date(project.created_at).toLocaleDateString()}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function NewProjectForm({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          color: color || undefined,
        }),
      });
      onSuccess();
      onClose();
    } catch {
      // handled by toast
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="border border-white/[0.08] rounded-lg p-4 mb-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Project name"
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
          />
        </div>
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Color</label>
          <select
            value={color}
            onChange={e => setColor(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20"
          >
            <option value="">None</option>
            <option value="blue">Blue</option>
            <option value="green">Green</option>
            <option value="red">Red</option>
            <option value="yellow">Yellow</option>
            <option value="purple">Purple</option>
          </select>
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
          disabled={submitting || !name.trim()}
          className="px-3 py-1.5 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors"
        >
          {submitting ? 'Creating...' : 'Create project'}
        </button>
      </div>
    </form>
  );
}
