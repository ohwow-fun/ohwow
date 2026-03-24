import { useState, useMemo } from 'react';
import { FlowArrow, Plus, MagnifyingGlass, Trash, Eye, Play } from '@phosphor-icons/react';
import { useApi } from '../hooks/useApi';
import { StatusBadge } from '../components/StatusBadge';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { RowSkeleton } from '../components/Skeleton';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { api } from '../api/client';
import { toast } from '../components/Toast';

interface Workflow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  definition: string;
  created_at: string;
  updated_at: string;
}

const STATUSES = ['all', 'draft', 'active', 'paused', 'archived'] as const;
const STATUS_TRANSITIONS: Record<string, Array<{ value: string; label: string }>> = {
  draft: [{ value: 'active', label: 'Activate' }],
  active: [{ value: 'paused', label: 'Pause' }, { value: 'archived', label: 'Archive' }],
  paused: [{ value: 'active', label: 'Resume' }, { value: 'archived', label: 'Archive' }],
  archived: [{ value: 'draft', label: 'Restore to draft' }],
};

export function WorkflowsPage() {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [viewWorkflow, setViewWorkflow] = useState<Workflow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Workflow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { data: workflows, loading, refetch } = useApi<Workflow[]>('/api/workflows');

  const filtered = useMemo(() => {
    if (!workflows) return [];
    let result = workflows;
    if (filter !== 'all') {
      result = result.filter(w => w.status === filter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(w =>
        w.name.toLowerCase().includes(q) ||
        (w.description || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [workflows, filter, search]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`/api/workflows/${deleteTarget.id}`, { method: 'DELETE' });
      toast('success', 'Workflow deleted');
      refetch();
    } catch {
      toast('error', 'Couldn\'t delete workflow');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const handleStatusChange = async (id: string, newStatus: string) => {
    try {
      await api(`/api/workflows/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      });
      toast('success', `Workflow ${newStatus}`);
      refetch();
      if (viewWorkflow?.id === id) {
        setViewWorkflow(null);
      }
    } catch {
      toast('error', 'Couldn\'t update workflow status');
    }
  };

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Workflows"
        subtitle="Multi-step agent workflows"
        action={
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 bg-blue-500/10 border border-blue-500/30 text-white rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-blue-500/20 transition-colors"
          >
            <Plus size={14} /> New workflow
          </button>
        }
      />

      {/* Status filter */}
      <div className="flex gap-1 mb-4 overflow-x-auto">
        {STATUSES.map(s => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1 rounded text-xs capitalize transition-colors ${
              filter === s ? 'bg-white/5 text-white' : 'text-neutral-400 hover:text-white'
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
          placeholder="Search workflows..."
          className="w-full bg-white/[0.06] border border-white/[0.08] rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder:text-neutral-400/50 focus:outline-none focus:border-blue-500"
        />
      </div>

      {loading ? (
        <RowSkeleton count={4} />
      ) : !filtered.length ? (
        <EmptyState
          icon={<FlowArrow size={32} />}
          title="No workflows yet"
          description={search ? `No workflows matching "${search}".` : 'Create a workflow to orchestrate multi-step agent tasks.'}
          action={
            <button
              onClick={() => setShowCreate(true)}
              className="mt-3 flex items-center gap-1.5 bg-blue-500/10 border border-blue-500/30 text-white rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-blue-500/20 transition-colors"
            >
              <Plus size={14} /> Create your first workflow
            </button>
          }
        />
      ) : (
        <div className="bg-white/5 border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
          {filtered.map(workflow => (
            <div key={workflow.id} className="flex items-center justify-between px-4 py-3">
              <button
                className="min-w-0 mr-3 text-left flex-1"
                onClick={() => setViewWorkflow(workflow)}
              >
                <p className="text-sm font-medium truncate hover:text-white transition-colors">{workflow.name}</p>
                <p className="text-xs text-neutral-400">
                  {workflow.description || 'No description'}
                  <span className="ml-2">· {new Date(workflow.updated_at).toLocaleDateString()}</span>
                </p>
              </button>
              <div className="flex items-center gap-3 shrink-0">
                <StatusBadge status={workflow.status} />
                <button
                  onClick={() => setViewWorkflow(workflow)}
                  className="text-neutral-400 hover:text-white transition-colors"
                  title="Details"
                >
                  <Eye size={14} />
                </button>
                {workflow.status === 'active' && (
                  <button
                    onClick={() => handleStatusChange(workflow.id, 'paused')}
                    className="text-neutral-400 hover:text-warning transition-colors"
                    title="Pause"
                  >
                    <Play size={14} />
                  </button>
                )}
                <button
                  onClick={() => setDeleteTarget(workflow)}
                  className="text-neutral-400 hover:text-critical transition-colors"
                  title="Delete"
                >
                  <Trash size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <CreateWorkflowModal
          onClose={() => setShowCreate(false)}
          onSuccess={() => { refetch(); setShowCreate(false); }}
        />
      )}

      {/* Detail modal */}
      {viewWorkflow && (
        <WorkflowDetailModal
          workflow={viewWorkflow}
          onClose={() => setViewWorkflow(null)}
          onStatusChange={handleStatusChange}
        />
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete workflow"
        message={`Delete "${deleteTarget?.name}"? This can't be undone.`}
        confirmLabel="Delete"
        loading={deleting}
      />
    </div>
  );
}

function CreateWorkflowModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [definition, setDefinition] = useState('{\n  "steps": []\n}');
  const [submitting, setSubmitting] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    let parsedDef: unknown;
    try {
      parsedDef = JSON.parse(definition);
      setJsonError(null);
    } catch {
      setJsonError('Invalid JSON');
      return;
    }

    setSubmitting(true);
    try {
      await api('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          definition: parsedDef,
        }),
      });
      toast('success', 'Workflow created');
      onSuccess();
    } catch {
      toast('error', 'Couldn\'t create workflow');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="New workflow" maxWidth="max-w-lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Onboarding flow"
            className="w-full bg-white/[0.06] border border-white/[0.08] rounded px-3 py-2 text-sm text-white placeholder:text-neutral-400/50 focus:outline-none focus:border-blue-500"
            autoFocus
          />
        </div>
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Description</label>
          <input
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="What does this workflow do?"
            className="w-full bg-white/[0.06] border border-white/[0.08] rounded px-3 py-2 text-sm text-white placeholder:text-neutral-400/50 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Definition (JSON)</label>
          <textarea
            value={definition}
            onChange={e => { setDefinition(e.target.value); setJsonError(null); }}
            rows={8}
            className="w-full bg-white/[0.06] border border-white/[0.08] rounded px-3 py-2 text-sm text-white font-mono placeholder:text-neutral-400/50 focus:outline-none focus:border-blue-500 resize-none"
          />
          {jsonError && <p className="text-xs text-critical mt-1">{jsonError}</p>}
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="px-3 py-1.5 bg-blue-500/10 border border-blue-500/30 text-white rounded text-xs font-medium hover:bg-blue-500/20 disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Creating...' : 'Create workflow'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function WorkflowDetailModal({
  workflow,
  onClose,
  onStatusChange,
}: {
  workflow: Workflow;
  onClose: () => void;
  onStatusChange: (id: string, status: string) => void;
}) {
  let parsedDefinition: string;
  try {
    const def = typeof workflow.definition === 'string' ? JSON.parse(workflow.definition) : workflow.definition;
    parsedDefinition = JSON.stringify(def, null, 2);
  } catch {
    parsedDefinition = String(workflow.definition);
  }

  const transitions = STATUS_TRANSITIONS[workflow.status] || [];

  return (
    <Modal open onClose={onClose} title="Workflow details" maxWidth="max-w-lg">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold">{workflow.name}</h4>
            {workflow.description && <p className="text-xs text-neutral-400 mt-0.5">{workflow.description}</p>}
          </div>
          <StatusBadge status={workflow.status} />
        </div>

        <div className="bg-white/5 rounded-lg p-3 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-neutral-400">Status</span>
            <span className="font-medium capitalize">{workflow.status}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-neutral-400">Created</span>
            <span className="font-medium">{new Date(workflow.created_at).toLocaleDateString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-neutral-400">Updated</span>
            <span className="font-medium">{new Date(workflow.updated_at).toLocaleString()}</span>
          </div>
        </div>

        {/* Definition */}
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Definition</label>
          <pre className="bg-white/[0.06] border border-white/[0.08] rounded p-3 text-xs text-neutral-400 overflow-x-auto max-h-48 whitespace-pre-wrap">
            {parsedDefinition}
          </pre>
        </div>

        {/* Status transitions */}
        {transitions.length > 0 && (
          <div className="flex gap-2 justify-end pt-2">
            {transitions.map(t => (
              <button
                key={t.value}
                onClick={() => onStatusChange(workflow.id, t.value)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors border ${
                  t.value === 'active'
                    ? 'bg-success/10 border-success/30 text-success hover:bg-success/20'
                    : t.value === 'archived'
                    ? 'bg-muted/10 border-white/[0.08] text-neutral-400 hover:text-white'
                    : 'bg-warning/10 border-warning/30 text-warning hover:bg-warning/20'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
