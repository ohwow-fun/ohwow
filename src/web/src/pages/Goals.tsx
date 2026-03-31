import { useState, useMemo } from 'react';
import { Target, Plus, Pencil, Trash, CaretDown, CaretRight } from '@phosphor-icons/react';
import { motion, AnimatePresence } from 'framer-motion';
import { useApi } from '../hooks/useApi';
import { PageHeader } from '../components/PageHeader';
import { RowSkeleton } from '../components/Skeleton';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { api } from '../api/client';
import { toast } from '../components/Toast';
import { FeatureIntro } from '../components/FeatureIntro';
import { Flag, TrendUp, CalendarCheck, Gauge } from '@phosphor-icons/react';

interface Goal {
  id: string;
  name: string;
  description: string | null;
  status: string;
  target_metric: string | null;
  target_value: number | null;
  current_value: number | null;
  unit: string | null;
  priority: string;
  due_date: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
}

const PRIORITY_COLORS: Record<string, string> = {
  low: 'bg-neutral-500/15 text-neutral-400',
  medium: 'bg-blue-500/15 text-blue-400',
  high: 'bg-warning/15 text-warning',
  critical: 'bg-critical/15 text-critical',
};

const GOAL_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#ef4444', '#84cc16', '#f97316'];

const SECTIONS: Array<{ status: string; label: string; defaultOpen: boolean }> = [
  { status: 'active', label: 'Active', defaultOpen: true },
  { status: 'paused', label: 'Paused', defaultOpen: false },
  { status: 'completed', label: 'Completed', defaultOpen: false },
  { status: 'archived', label: 'Archived', defaultOpen: false },
];

export function GoalsPage() {
  const { data: goals, loading, refetch } = useApi<Goal[]>('/api/goals');
  const [showModal, setShowModal] = useState(false);
  const [editGoal, setEditGoal] = useState<Goal | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Goal | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    active: true,
    paused: false,
    completed: false,
    archived: false,
  });

  const grouped = useMemo(() => {
    if (!goals) return {};
    const map: Record<string, Goal[]> = {};
    for (const g of goals) {
      (map[g.status] ??= []).push(g);
    }
    return map;
  }, [goals]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`/api/goals/${deleteTarget.id}`, { method: 'DELETE' });
      toast('success', 'Goal deleted');
      refetch();
    } catch {
      toast('error', 'Couldn\'t delete goal');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const toggleSection = (status: string) => {
    setOpenSections(prev => ({ ...prev, [status]: !prev[status] }));
  };

  const isEmpty = !loading && (!goals || goals.length === 0);

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Goals"
        subtitle="Track objectives and measure progress"
        action={
          <button
            onClick={() => { setEditGoal(null); setShowModal(true); }}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors"
          >
            <Plus size={14} /> New goal
          </button>
        }
      />

      {loading ? (
        <RowSkeleton count={4} />
      ) : isEmpty ? (
        <FeatureIntro
          icon={Target}
          title="No goals yet"
          description="Set goals to track your progress toward business objectives."
          capabilities={[
            { icon: Target, label: 'Objectives', description: 'Define what you want to achieve' },
            { icon: TrendUp, label: 'Progress tracking', description: 'Monitor current vs target' },
            { icon: Flag, label: 'Priority levels', description: 'Focus on what matters most' },
            { icon: CalendarCheck, label: 'Deadlines', description: 'Stay on track with due dates' },
          ]}
          action={{ label: 'Create your first goal', onClick: () => { setEditGoal(null); setShowModal(true); } }}
        />
      ) : (
        <div className="space-y-4">
          {SECTIONS.map(section => {
            const items = grouped[section.status] || [];
            if (items.length === 0) return null;
            const isOpen = openSections[section.status];
            return (
              <div key={section.status}>
                <button
                  onClick={() => toggleSection(section.status)}
                  className="flex items-center gap-2 mb-2 text-sm text-neutral-400 hover:text-white transition-colors"
                >
                  {isOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
                  <span className="font-medium capitalize">{section.label}</span>
                  <span className="text-xs text-neutral-600">{items.length}</span>
                </button>
                <AnimatePresence>
                  {isOpen && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="space-y-2 overflow-hidden"
                    >
                      {items.map(goal => (
                        <GoalCard
                          key={goal.id}
                          goal={goal}
                          onEdit={() => { setEditGoal(goal); setShowModal(true); }}
                          onDelete={() => setDeleteTarget(goal)}
                        />
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      )}

      {/* Create/Edit modal */}
      {showModal && (
        <GoalModal
          goal={editGoal}
          onClose={() => { setShowModal(false); setEditGoal(null); }}
          onSuccess={() => { refetch(); setShowModal(false); setEditGoal(null); }}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete goal"
        message={`Delete "${deleteTarget?.name}"? This can't be undone.`}
        confirmLabel="Delete"
        loading={deleting}
      />
    </div>
  );
}

function GoalCard({ goal, onEdit, onDelete }: { goal: Goal; onEdit: () => void; onDelete: () => void }) {
  const progress = goal.target_value && goal.current_value != null
    ? Math.min(100, Math.round((goal.current_value / goal.target_value) * 100))
    : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="border border-white/[0.08] bg-white/[0.02] rounded-lg p-4"
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          {goal.color && (
            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: goal.color }} />
          )}
          <h4 className="text-sm font-medium truncate">{goal.name}</h4>
          <span className={`text-[10px] px-1.5 py-0.5 rounded capitalize ${PRIORITY_COLORS[goal.priority] || PRIORITY_COLORS.medium}`}>
            {goal.priority}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          <button onClick={onEdit} className="text-neutral-500 hover:text-white transition-colors">
            <Pencil size={13} />
          </button>
          <button onClick={onDelete} className="text-neutral-500 hover:text-critical transition-colors">
            <Trash size={13} />
          </button>
        </div>
      </div>

      {goal.description && (
        <p className="text-xs text-neutral-400 mb-3">{goal.description}</p>
      )}

      {progress !== null && (
        <div className="mb-2">
          <div className="flex justify-between text-[10px] text-neutral-500 mb-1">
            <span>{goal.target_metric || 'Progress'}</span>
            <span>
              {goal.current_value} / {goal.target_value} {goal.unit || ''}
              <span className="ml-1.5 text-neutral-400">{progress}%</span>
            </span>
          </div>
          <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.6, ease: 'easeOut' }}
              className="h-full rounded-full"
              style={{ backgroundColor: goal.color || '#3b82f6' }}
            />
          </div>
        </div>
      )}

      {goal.due_date && (
        <p className="text-[10px] text-neutral-500">
          Due {new Date(goal.due_date).toLocaleDateString()}
        </p>
      )}
    </motion.div>
  );
}

function GoalModal({ goal, onClose, onSuccess }: { goal: Goal | null; onClose: () => void; onSuccess: () => void }) {
  const [name, setName] = useState(goal?.name || '');
  const [description, setDescription] = useState(goal?.description || '');
  const [priority, setPriority] = useState(goal?.priority || 'medium');
  const [status, setStatus] = useState(goal?.status || 'active');
  const [targetMetric, setTargetMetric] = useState(goal?.target_metric || '');
  const [targetValue, setTargetValue] = useState(goal?.target_value?.toString() || '');
  const [currentValue, setCurrentValue] = useState(goal?.current_value?.toString() || '0');
  const [unit, setUnit] = useState(goal?.unit || '');
  const [dueDate, setDueDate] = useState(goal?.due_date?.split('T')[0] || '');
  const [color, setColor] = useState(goal?.color || GOAL_COLORS[0]);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        priority,
        status,
        target_metric: targetMetric.trim() || null,
        target_value: targetValue ? Number(targetValue) : null,
        current_value: currentValue ? Number(currentValue) : null,
        unit: unit.trim() || null,
        due_date: dueDate || null,
        color,
      };
      if (goal) {
        await api(`/api/goals/${goal.id}`, { method: 'PUT', body: JSON.stringify(body) });
        toast('success', 'Goal updated');
      } else {
        await api('/api/goals', { method: 'POST', body: JSON.stringify(body) });
        toast('success', 'Goal created');
      }
      onSuccess();
    } catch {
      toast('error', goal ? 'Couldn\'t update goal' : 'Couldn\'t create goal');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={goal ? 'Edit goal' : 'New goal'} maxWidth="max-w-md">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Reach 100 customers"
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
            autoFocus
          />
        </div>
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Description</label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="What does achieving this goal look like?"
            rows={2}
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20 resize-none"
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Metric</label>
            <input
              value={targetMetric}
              onChange={e => setTargetMetric(e.target.value)}
              placeholder="Revenue"
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
            />
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Target</label>
            <input
              type="number"
              value={targetValue}
              onChange={e => setTargetValue(e.target.value)}
              placeholder="100"
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
            />
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Unit</label>
            <input
              value={unit}
              onChange={e => setUnit(e.target.value)}
              placeholder="users"
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
            />
          </div>
        </div>
        {goal && (
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Current value</label>
            <input
              type="number"
              value={currentValue}
              onChange={e => setCurrentValue(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Priority</label>
            <select
              value={priority}
              onChange={e => setPriority(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          {goal && (
            <div>
              <label className="text-xs text-neutral-400 block mb-1">Status</label>
              <select
                value={status}
                onChange={e => setStatus(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20"
              >
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="completed">Completed</option>
                <option value="archived">Archived</option>
              </select>
            </div>
          )}
        </div>
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Due date</label>
          <input
            type="date"
            value={dueDate}
            onChange={e => setDueDate(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20"
          />
        </div>
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Color</label>
          <div className="flex gap-2">
            {GOAL_COLORS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`w-6 h-6 rounded-full transition-all ${color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-black scale-110' : 'hover:scale-110'}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors"
          >
            {submitting ? (goal ? 'Updating...' : 'Creating...') : (goal ? 'Update goal' : 'Create goal')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
