import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, ListChecks } from '@phosphor-icons/react';
import { useApi } from '../hooks/useApi';
import { useWsRefresh } from '../hooks/useWebSocket';
import { StatusBadge } from '../components/StatusBadge';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { RowSkeleton } from '../components/Skeleton';

interface Project {
  id: string;
  name: string;
  description: string | null;
  status: string;
  color: string | null;
  created_at: string;
}

interface Task {
  id: string;
  title: string;
  status: string;
  agent_id: string;
  priority: string | null;
  created_at: string;
}

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const wsTick = useWsRefresh(['task:started', 'task:completed', 'task:failed']);
  const { data: project, loading } = useApi<Project>(id ? `/api/projects/${id}` : null);
  const { data: tasks } = useApi<Task[]>(id ? `/api/projects/${id}/tasks` : null, [wsTick]);

  if (loading) return <div className="p-6"><RowSkeleton count={4} /></div>;
  if (!project) return <div className="p-6 text-neutral-400">Project not found</div>;

  return (
    <div className="p-6 max-w-4xl">
      <Link to="/projects" className="inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-white mb-4">
        <ArrowLeft size={14} /> Back to projects
      </Link>

      <PageHeader
        title={project.name}
        subtitle={project.description || `Created ${new Date(project.created_at).toLocaleDateString()}`}
        action={<StatusBadge status={project.status} />}
      />

      {/* Stats */}
      {tasks && (
        <div className="grid grid-cols-3 gap-3 mb-8">
          <div className="border border-white/[0.08] rounded-lg p-3">
            <p className="text-xs text-neutral-400">Total tasks</p>
            <p className="text-lg font-bold">{tasks.length}</p>
          </div>
          <div className="border border-white/[0.08] rounded-lg p-3">
            <p className="text-xs text-neutral-400">Completed</p>
            <p className="text-lg font-bold">{tasks.filter(t => t.status === 'completed').length}</p>
          </div>
          <div className="border border-white/[0.08] rounded-lg p-3">
            <p className="text-xs text-neutral-400">In progress</p>
            <p className="text-lg font-bold">{tasks.filter(t => t.status === 'in_progress').length}</p>
          </div>
        </div>
      )}

      {/* Tasks */}
      <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wider mb-3">Tasks</h2>
      {!tasks?.length ? (
        <EmptyState
          icon={<ListChecks size={32} />}
          title="No tasks in this project"
          description="Tasks assigned to this project will appear here."
        />
      ) : (
        <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
          {tasks.map(task => (
            <Link key={task.id} to={`/tasks/${task.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors">
              <div className="min-w-0 mr-3">
                <p className="text-sm font-medium truncate">{task.title}</p>
                <p className="text-xs text-neutral-400">{new Date(task.created_at).toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {task.priority && task.priority !== 'normal' && (
                  <span className="text-xs text-warning">{task.priority}</span>
                )}
                <StatusBadge status={task.status} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
