import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lightning, Plus, Trash, MagnifyingGlass, Globe, CalendarBlank, BellRinging, Hand } from '@phosphor-icons/react';
import { api } from '../api/client';
import { toast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { Toggle } from '../components/Toggle';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Skeleton } from '../components/Skeleton';
import type { Automation } from './automations/types';

const TRIGGER_ICONS: Record<string, typeof Globe> = {
  webhook: Globe,
  schedule: CalendarBlank,
  event: BellRinging,
  manual: Hand,
};

function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const d = /Z$|[+-]\d\d:?\d\d$/.test(dateStr) ? new Date(dateStr) : new Date(dateStr.replace(' ', 'T') + 'Z');
  const diff = Date.now() - d.getTime();
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function AutomationsListPage() {
  const navigate = useNavigate();
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const fetchAutomations = async () => {
    try {
      const res = await api<{ data: Automation[] }>('/api/automations');
      setAutomations(res.data || []);
    } catch {
      toast('error', 'Couldn\'t load automations');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAutomations(); }, []);

  const filtered = automations.filter((a) =>
    a.name.toLowerCase().includes(search.toLowerCase())
  );

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await api(`/api/automations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      });
      setAutomations((prev) =>
        prev.map((a) => a.id === id ? { ...a, enabled } : a)
      );
    } catch {
      toast('error', 'Couldn\'t update automation');
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await api(`/api/automations/${deleteId}`, { method: 'DELETE' });
      setAutomations((prev) => prev.filter((a) => a.id !== deleteId));
      toast('success', 'Automation deleted');
    } catch {
      toast('error', 'Couldn\'t delete automation');
    }
    setDeleteId(null);
  };

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Automations"
        subtitle="Build visual automation flows with triggers, conditions, and actions"
        action={
          <button
            onClick={() => navigate('/automations/new')}
            className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-gray-200"
          >
            <Plus size={14} weight="bold" />
            New automation
          </button>
        }
      />

      {/* Search */}
      {automations.length > 0 && (
        <div className="relative mb-4">
          <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search automations..."
            className="w-full pl-9 pr-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
          />
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      ) : automations.length === 0 ? (
        <EmptyState
          icon={<Lightning size={32} />}
          title="No automations yet"
          description="Create your first automation to connect triggers with actions"
          action={
            <button
              onClick={() => navigate('/automations/new')}
              className="flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/20"
            >
              <Plus size={14} weight="bold" />
              New automation
            </button>
          }
        />
      ) : filtered.length === 0 ? (
        <p className="text-sm text-neutral-500 text-center py-8">No automations match your search</p>
      ) : (
        <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
          {filtered.map((automation) => {
            const TriggerIcon = TRIGGER_ICONS[automation.trigger_type] || Lightning;
            return (
              <div key={automation.id} className="flex items-center justify-between px-4 py-3">
                <button
                  onClick={() => navigate(`/automations/${automation.id}/edit`)}
                  className="min-w-0 mr-3 text-left flex-1"
                >
                  <div className="flex items-center gap-2">
                    <TriggerIcon size={14} className="text-neutral-500 shrink-0" />
                    <p className="text-sm font-medium truncate">{automation.name}</p>
                  </div>
                  <p className="text-xs text-neutral-400 mt-0.5">
                    {automation.steps.length} {automation.steps.length === 1 ? 'step' : 'steps'}
                    {automation.last_fired_at && ` · Last run ${formatTimeAgo(automation.last_fired_at)}`}
                  </p>
                </button>
                <div className="flex items-center gap-3 shrink-0">
                  <Toggle
                    checked={automation.enabled}
                    onChange={(v) => handleToggle(automation.id, v)}
                  />
                  <button
                    onClick={() => setDeleteId(automation.id)}
                    className="text-neutral-500 hover:text-red-400 transition-colors"
                    title="Delete"
                  >
                    <Trash size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteId}
        title="Delete automation"
        message="This will permanently delete this automation and its history. This action can't be undone."
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onClose={() => setDeleteId(null)}
      />
    </div>
  );
}
