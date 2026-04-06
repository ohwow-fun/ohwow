import { useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, ListChecks, DotsSixVertical } from '@phosphor-icons/react';
import { motion } from 'framer-motion';
import { useApi } from '../hooks/useApi';
import { useWsRefresh } from '../hooks/useWebSocket';
import { StatusBadge } from '../components/StatusBadge';
import { TabSwitcher } from '../components/TabSwitcher';
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
  tokens_used: number | null;
  created_at: string;
}

const KANBAN_COLUMNS = [
  { id: 'pending', label: 'Pending', textColor: 'text-neutral-400', bgColor: 'bg-white/[0.04]' },
  { id: 'in_progress', label: 'In Progress', textColor: 'text-blue-400', bgColor: 'bg-blue-500/[0.08]' },
  { id: 'completed', label: 'Completed', textColor: 'text-success', bgColor: 'bg-success/[0.08]' },
  { id: 'failed', label: 'Failed', textColor: 'text-critical', bgColor: 'bg-critical/[0.08]' },
] as const;

function KanbanCard({ task }: { task: Task }) {
  return (
    <Link
      to={`/tasks/${task.id}`}
      className="block border border-white/[0.08] bg-white/[0.02] rounded-lg p-3 hover:bg-white/[0.04] transition-colors group"
    >
      <div className="flex items-start gap-2">
        <DotsSixVertical size={14} className="text-neutral-600 mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{task.title}</p>
          <div className="flex items-center gap-2 mt-1.5">
            {task.priority && task.priority !== 'normal' && (
              <span className="text-xs text-warning">{task.priority}</span>
            )}
            {task.tokens_used ? (
              <span className="text-xs text-neutral-500">{task.tokens_used.toLocaleString()} tok</span>
            ) : null}
          </div>
          <p className="text-xs text-neutral-500 mt-1">{new Date(task.created_at).toLocaleDateString()}</p>
        </div>
      </div>
    </Link>
  );
}

function KanbanBoard({ tasks }: { tasks: Task[] }) {
  const columns = useMemo(() =>
    KANBAN_COLUMNS.map(col => ({
      ...col,
      tasks: tasks.filter(t => t.status === col.id),
    })),
    [tasks]
  );

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {columns.map(col => (
        <div key={col.id} className="min-w-[240px] flex-1">
          <div className={`flex items-center justify-between rounded-lg px-3 py-2 mb-3 ${col.bgColor}`}>
            <span className={`text-xs font-semibold uppercase tracking-wider ${col.textColor}`}>{col.label}</span>
            <span className={`text-xs ${col.textColor} opacity-70`}>{col.tasks.length}</span>
          </div>
          <div className="space-y-2">
            {col.tasks.length === 0 ? (
              <p className="text-xs text-neutral-600 text-center py-6">No tasks</p>
            ) : (
              col.tasks.map(task => (
                <motion.div
                  key={task.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <KanbanCard task={task} />
                </motion.div>
              ))
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

const VIEW_TABS = [
  { id: 'board', label: 'Board' },
  { id: 'list', label: 'List' },
];

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<'board' | 'list'>('board');
  const wsTick = useWsRefresh(['task:started', 'task:completed', 'task:failed']);
  const { data: project, loading } = useApi<Project>(id ? `/api/projects/${id}` : null);
  const { data: tasks } = useApi<Task[]>(id ? `/api/projects/${id}/tasks` : null, [wsTick]);

  if (loading) return <div className="p-6"><RowSkeleton count={4} /></div>;
  if (!project) return <div className="p-6 text-neutral-400">Project not found</div>;

  return (
    <div className="p-6 max-w-6xl">
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
      <div className="mb-4">
        <TabSwitcher
          tabs={VIEW_TABS}
          activeTab={view}
          onTabChange={(id) => setView(id as 'board' | 'list')}
          layoutId="project-view-tabs"
        />
      </div>

      {!tasks?.length ? (
        <EmptyState
          icon={<ListChecks size={32} />}
          title="No tasks in this project"
          description="Tasks assigned to this project will appear here."
        />
      ) : view === 'board' ? (
        <KanbanBoard tasks={tasks} />
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
