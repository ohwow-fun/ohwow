import { useParams, Link } from 'react-router-dom';
import { ArrowLeft } from '@phosphor-icons/react';
import { useApi } from '../hooks/useApi';
import { StatusBadge } from '../components/StatusBadge';
import { PageHeader } from '../components/PageHeader';
import { RowSkeleton } from '../components/Skeleton';

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  agent_id: string;
  model_used: string | null;
  tokens_used: number | null;
  cost_cents: number | null;
  duration_seconds: number | null;
  output: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface Message {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

export function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: task, loading } = useApi<Task>(id ? `/api/tasks/${id}` : null);
  const { data: messages } = useApi<Message[]>(id ? `/api/tasks/${id}/messages` : null);

  if (loading) return <div className="p-6"><RowSkeleton count={6} /></div>;
  if (!task) return <div className="p-6 text-neutral-400">Task not found</div>;

  return (
    <div className="p-6 max-w-4xl">
      <Link to="/tasks" className="inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-white mb-4">
        <ArrowLeft size={14} /> Back to tasks
      </Link>

      <PageHeader
        title={task.title}
        action={<StatusBadge status={task.status} />}
      />

      {task.description && (
        <p className="text-sm text-neutral-400 mb-4">{task.description}</p>
      )}

      {/* Meta */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {task.model_used && (
          <div className="border border-white/[0.08] rounded-lg p-3">
            <p className="text-xs text-neutral-400">Model</p>
            <p className="text-sm font-medium mt-0.5">{task.model_used}</p>
          </div>
        )}
        {task.tokens_used != null && (
          <div className="border border-white/[0.08] rounded-lg p-3">
            <p className="text-xs text-neutral-400">Tokens</p>
            <p className="text-sm font-medium mt-0.5">{task.tokens_used.toLocaleString()}</p>
          </div>
        )}
        {task.cost_cents != null && (
          <div className="border border-white/[0.08] rounded-lg p-3">
            <p className="text-xs text-neutral-400">Cost</p>
            <p className="text-sm font-medium mt-0.5">${(task.cost_cents / 100).toFixed(4)}</p>
          </div>
        )}
        {task.duration_seconds != null && (
          <div className="border border-white/[0.08] rounded-lg p-3">
            <p className="text-xs text-neutral-400">Duration</p>
            <p className="text-sm font-medium mt-0.5">{task.duration_seconds}s</p>
          </div>
        )}
      </div>

      {/* Error */}
      {task.error_message && (
        <div className="bg-critical/10 border border-critical/30 rounded-lg p-4 mb-6">
          <p className="text-sm text-critical">{task.error_message}</p>
        </div>
      )}

      {/* Output */}
      {task.output && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wider mb-2">Output</h2>
          <div className="border border-white/[0.08] rounded-lg p-4">
            <pre className="text-sm whitespace-pre-wrap break-words">{typeof task.output === 'string' ? task.output : JSON.stringify(task.output, null, 2)}</pre>
          </div>
        </div>
      )}

      {/* Conversation */}
      {messages && messages.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wider mb-2">Conversation</h2>
          <div className="space-y-2">
            {messages.map(msg => (
              <div
                key={msg.id}
                className={`rounded-lg p-3 text-sm ${
                  msg.role === 'user'
                    ? 'bg-white/5 border border-white/[0.12]'
                    : 'border border-white/[0.08]'
                }`}
              >
                <p className="text-xs text-neutral-400 mb-1 capitalize">{msg.role}</p>
                <pre className="whitespace-pre-wrap break-words">{typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}</pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
