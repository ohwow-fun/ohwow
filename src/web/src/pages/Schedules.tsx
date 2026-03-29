import { useState } from 'react';
import { Calendar, Plus, Trash, PencilSimple } from '@phosphor-icons/react';
import { useApi } from '../hooks/useApi';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { RowSkeleton } from '../components/Skeleton';
import { Toggle } from '../components/Toggle';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CronPicker } from '../components/CronPicker';
import { api } from '../api/client';
import { toast } from '../components/Toast';

interface Schedule {
  id: string;
  agent_id: string | null;
  label: string;
  cron: string;
  cron_expression: string;
  task_prompt: string;
  enabled: number | boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

interface Agent {
  id: string;
  name: string;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function timeUntil(dateStr: string): string {
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff < 0) return 'overdue';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

export function SchedulesPage() {
  const { data: schedules, loading, refetch } = useApi<Schedule[]>('/api/schedules');
  const [toggling, setToggling] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editSchedule, setEditSchedule] = useState<Schedule | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Schedule | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleToggle = async (id: string) => {
    setToggling(id);
    try {
      await api(`/api/schedules/${id}/toggle`, { method: 'POST' });
      refetch();
    } catch {
      toast('error', 'Couldn\'t toggle schedule. Try again?');
    } finally {
      setToggling(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`/api/schedules/${deleteTarget.id}`, { method: 'DELETE' });
      toast('success', 'Schedule deleted');
      refetch();
    } catch {
      toast('error', 'Couldn\'t delete schedule. Try again?');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Schedules"
        subtitle="Automated task schedules"
        action={
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors"
          >
            <Plus size={14} /> New schedule
          </button>
        }
      />

      {loading ? (
        <RowSkeleton count={3} />
      ) : !schedules?.length ? (
        <EmptyState
          icon={<Calendar size={32} />}
          title="Nothing scheduled yet"
          description="Set up recurring tasks to keep your agents busy."
          action={
            <button
              onClick={() => setShowCreate(true)}
              className="mt-3 flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors"
            >
              <Plus size={14} /> Create your first schedule
            </button>
          }
        />
      ) : (
        <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
          {schedules.map(schedule => (
            <div key={schedule.id} className="flex items-center justify-between px-4 py-4">
              <div className="min-w-0 mr-4 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${schedule.enabled ? 'bg-success' : 'bg-white/10'}`} />
                  <p className="text-sm font-medium truncate">{schedule.label}</p>
                </div>
                <div className="flex gap-3 mt-1 ml-4">
                  <span className="text-xs text-neutral-400 font-mono">{schedule.cron_expression || schedule.cron}</span>
                  {schedule.next_run_at && (
                    <span className="text-xs text-neutral-400">Next: {timeUntil(schedule.next_run_at)}</span>
                  )}
                  {schedule.last_run_at && (
                    <span className="text-xs text-neutral-400">Last: {timeAgo(schedule.last_run_at)}</span>
                  )}
                </div>
                {schedule.task_prompt && (
                  <p className="text-xs text-neutral-400 mt-1 ml-4 truncate max-w-md">{schedule.task_prompt}</p>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button
                  onClick={() => setEditSchedule(schedule)}
                  className="text-neutral-400 hover:text-white transition-colors"
                  title="Edit"
                >
                  <PencilSimple size={14} />
                </button>
                <button
                  onClick={() => setDeleteTarget(schedule)}
                  className="text-neutral-400 hover:text-critical transition-colors"
                  title="Delete"
                >
                  <Trash size={14} />
                </button>
                <Toggle
                  checked={!!schedule.enabled}
                  onChange={() => handleToggle(schedule.id)}
                  disabled={toggling === schedule.id}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <ScheduleFormModal
          onClose={() => setShowCreate(false)}
          onSuccess={() => { refetch(); setShowCreate(false); }}
        />
      )}

      {/* Edit modal */}
      {editSchedule && (
        <ScheduleFormModal
          schedule={editSchedule}
          onClose={() => setEditSchedule(null)}
          onSuccess={() => { refetch(); setEditSchedule(null); }}
        />
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete schedule"
        message={`Delete "${deleteTarget?.label}"? This can't be undone.`}
        confirmLabel="Delete"
        loading={deleting}
      />
    </div>
  );
}

function ScheduleFormModal({
  schedule,
  onClose,
  onSuccess,
}: {
  schedule?: Schedule;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const isEdit = !!schedule;
  const { data: agents } = useApi<Agent[]>('/api/agents');

  const [label, setLabel] = useState(schedule?.label || '');
  const [cron, setCron] = useState(schedule?.cron_expression || schedule?.cron || '0 9 * * *');
  const [agentId, setAgentId] = useState(schedule?.agent_id || '');
  const [taskPrompt, setTaskPrompt] = useState(schedule?.task_prompt || '');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !cron.trim()) return;
    setSubmitting(true);
    try {
      if (isEdit) {
        await api(`/api/schedules/${schedule.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            label: label.trim(),
            cron: cron.trim(),
            agent_id: agentId || null,
            task_prompt: taskPrompt,
          }),
        });
        toast('success', 'Schedule updated');
      } else {
        await api('/api/schedules', {
          method: 'POST',
          body: JSON.stringify({
            label: label.trim(),
            cron: cron.trim(),
            agent_id: agentId || null,
            task_prompt: taskPrompt,
          }),
        });
        toast('success', 'Schedule created');
      }
      onSuccess();
    } catch {
      toast('error', `Couldn't ${isEdit ? 'update' : 'create'} schedule. Try again?`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={isEdit ? 'Edit schedule' : 'New schedule'} maxWidth="max-w-lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Title</label>
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="Daily briefing"
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
            autoFocus
          />
        </div>

        <div>
          <label className="text-xs text-neutral-400 block mb-1">Agent</label>
          <select
            value={agentId}
            onChange={e => setAgentId(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20"
          >
            <option value="">Orchestrator (default)</option>
            {agents?.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs text-neutral-400 block mb-1">Schedule</label>
          <CronPicker value={cron} onChange={setCron} />
        </div>

        <div>
          <label className="text-xs text-neutral-400 block mb-1">Task prompt</label>
          <textarea
            value={taskPrompt}
            onChange={e => setTaskPrompt(e.target.value)}
            placeholder="What should the agent do?"
            rows={3}
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20 resize-none"
          />
        </div>

        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !label.trim() || !cron.trim()}
            className="px-3 py-1.5 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Saving...' : isEdit ? 'Save changes' : 'Create schedule'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
