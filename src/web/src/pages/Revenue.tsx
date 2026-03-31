import { useState, useMemo } from 'react';
import { CurrencyDollar, Plus, Pencil, Trash, TrendUp, X } from '@phosphor-icons/react';
import { motion, AnimatePresence } from 'framer-motion';
import { useApi } from '../hooks/useApi';
import { PageHeader } from '../components/PageHeader';
import { RowSkeleton } from '../components/Skeleton';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FeatureIntro } from '../components/FeatureIntro';
import { api } from '../api/client';
import { toast } from '../components/Toast';
import { ChartLineUp, CalendarCheck, Tag, Notebook } from '@phosphor-icons/react';

interface RevenueEntry {
  id: string;
  amount_cents: number;
  month: number;
  year: number;
  source: string | null;
  notes: string | null;
  created_at: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function RevenuePage() {
  const { data: entries, loading, refetch } = useApi<RevenueEntry[]>('/api/revenue');
  const [showForm, setShowForm] = useState(false);
  const [editEntry, setEditEntry] = useState<RevenueEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RevenueEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const mrr = useMemo(() => {
    if (!entries || entries.length === 0) return 0;
    const now = new Date();
    const currentMonth = entries.filter(
      e => e.month === now.getMonth() + 1 && e.year === now.getFullYear()
    );
    return currentMonth.reduce((sum, e) => sum + e.amount_cents, 0);
  }, [entries]);

  const sorted = useMemo(() => {
    if (!entries) return [];
    return [...entries].sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      return b.month - a.month;
    });
  }, [entries]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`/api/revenue/${deleteTarget.id}`, { method: 'DELETE' });
      toast('success', 'Entry deleted');
      refetch();
    } catch {
      toast('error', 'Couldn\'t delete entry');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const isEmpty = !loading && (!entries || entries.length === 0);

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Revenue"
        subtitle="Track monthly revenue and growth"
        action={
          <div className="flex items-center gap-3">
            {mrr > 0 && (
              <div className="flex items-center gap-1.5 text-success">
                <TrendUp size={14} weight="bold" />
                <span className="text-sm font-semibold">${(mrr / 100).toLocaleString()} MRR</span>
              </div>
            )}
            <button
              onClick={() => { setEditEntry(null); setShowForm(true); }}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors"
            >
              <Plus size={14} /> Add entry
            </button>
          </div>
        }
      />

      {/* Inline form */}
      <AnimatePresence>
        {showForm && (
          <RevenueForm
            entry={editEntry}
            onClose={() => { setShowForm(false); setEditEntry(null); }}
            onSuccess={() => { refetch(); setShowForm(false); setEditEntry(null); }}
          />
        )}
      </AnimatePresence>

      {loading ? (
        <RowSkeleton count={4} />
      ) : isEmpty ? (
        <FeatureIntro
          icon={CurrencyDollar}
          title="No revenue entries yet"
          description="Start tracking monthly revenue to measure growth over time."
          capabilities={[
            { icon: ChartLineUp, label: 'Monthly tracking', description: 'Record revenue each month' },
            { icon: TrendUp, label: 'MRR calculation', description: 'See current monthly recurring revenue' },
            { icon: Tag, label: 'Revenue sources', description: 'Tag where revenue comes from' },
            { icon: Notebook, label: 'Notes', description: 'Add context to each entry' },
          ]}
          action={{ label: 'Add your first entry', onClick: () => { setEditEntry(null); setShowForm(true); } }}
        />
      ) : (
        <div className="border border-white/[0.08] rounded-lg overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-4 px-4 py-2 text-[10px] uppercase tracking-wider text-neutral-500 border-b border-white/[0.08] bg-white/[0.02]">
            <span>Period</span>
            <span>Source</span>
            <span className="text-right">Amount</span>
            <span>Notes</span>
            <span className="w-16" />
          </div>
          {/* Rows */}
          <div className="divide-y divide-white/[0.06]">
            {sorted.map(entry => (
              <motion.div
                key={entry.id}
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-4 px-4 py-3 items-center hover:bg-white/[0.02] transition-colors group"
              >
                <span className="text-sm font-medium">
                  {MONTHS[entry.month - 1]} {entry.year}
                </span>
                <span className="text-sm text-neutral-400 truncate">
                  {entry.source || 'No source'}
                </span>
                <span className="text-sm font-semibold text-right text-success">
                  ${(entry.amount_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
                <span className="text-xs text-neutral-500 truncate">
                  {entry.notes || ''}
                </span>
                <div className="flex items-center gap-1.5 w-16 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => { setEditEntry(entry); setShowForm(true); }}
                    className="text-neutral-500 hover:text-white transition-colors"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={() => setDeleteTarget(entry)}
                    className="text-neutral-500 hover:text-critical transition-colors"
                  >
                    <Trash size={13} />
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete entry"
        message="Delete this revenue entry? This can't be undone."
        confirmLabel="Delete"
        loading={deleting}
      />
    </div>
  );
}

function RevenueForm({
  entry,
  onClose,
  onSuccess,
}: {
  entry: RevenueEntry | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const now = new Date();
  const [amount, setAmount] = useState(entry ? (entry.amount_cents / 100).toString() : '');
  const [source, setSource] = useState(entry?.source || '');
  const [month, setMonth] = useState(entry?.month?.toString() || (now.getMonth() + 1).toString());
  const [year, setYear] = useState(entry?.year?.toString() || now.getFullYear().toString());
  const [notes, setNotes] = useState(entry?.notes || '');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amount) return;
    setSubmitting(true);
    try {
      const body = {
        amount_cents: Math.round(Number(amount) * 100),
        month: Number(month),
        year: Number(year),
        source: source.trim() || null,
        notes: notes.trim() || null,
      };
      if (entry) {
        await api(`/api/revenue/${entry.id}`, { method: 'PUT', body: JSON.stringify(body) });
        toast('success', 'Entry updated');
      } else {
        await api('/api/revenue', { method: 'POST', body: JSON.stringify(body) });
        toast('success', 'Entry added');
      }
      onSuccess();
    } catch {
      toast('error', entry ? 'Couldn\'t update entry' : 'Couldn\'t add entry');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="mb-4 overflow-hidden"
    >
      <form onSubmit={handleSubmit} className="border border-white/[0.08] bg-white/[0.02] rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium">{entry ? 'Edit entry' : 'New entry'}</span>
          <button type="button" onClick={onClose} className="text-neutral-500 hover:text-white transition-colors">
            <X size={14} />
          </button>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Amount ($)</label>
            <input
              type="number"
              step="0.01"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="500.00"
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Source</label>
            <input
              value={source}
              onChange={e => setSource(e.target.value)}
              placeholder="Subscription"
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
            />
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Month</label>
            <select
              value={month}
              onChange={e => setMonth(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20"
            >
              {MONTHS.map((m, i) => (
                <option key={i} value={i + 1}>{m}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Year</label>
            <input
              type="number"
              value={year}
              onChange={e => setYear(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20"
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Notes</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Optional notes"
            rows={2}
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20 resize-none"
          />
        </div>
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !amount}
            className="px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Saving...' : (entry ? 'Update' : 'Add entry')}
          </button>
        </div>
      </form>
    </motion.div>
  );
}
