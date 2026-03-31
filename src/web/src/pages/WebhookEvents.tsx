import { useState } from 'react';
import { Webhook, Eye, ArrowClockwise, Funnel } from '@phosphor-icons/react';
import { useApi } from '../hooks/useApi';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { RowSkeleton } from '../components/Skeleton';
import { Modal } from '../components/Modal';

interface WebhookEvent {
  id: string;
  source: string;
  event_type: string;
  payload: string;
  headers: string;
  processed: number;
  created_at: string;
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

function parseJson(str: string): unknown {
  try { return JSON.parse(str); } catch { return str; }
}

export function WebhookEventsPage() {
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'processed'>('all');
  const [viewEvent, setViewEvent] = useState<WebhookEvent | null>(null);
  const { data: events, loading, refetch } = useApi<WebhookEvent[]>('/api/webhook-events');

  const filtered = events
    ? statusFilter === 'all'
      ? events
      : statusFilter === 'processed'
        ? events.filter(e => e.processed === 1)
        : events.filter(e => e.processed === 0)
    : [];

  const statuses: Array<{ key: 'all' | 'pending' | 'processed'; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'pending', label: 'Pending' },
    { key: 'processed', label: 'Processed' },
  ];

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Webhook Events"
        subtitle="Audit log of incoming webhooks"
        action={
          <button
            onClick={refetch}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-neutral-400 border border-white/10 rounded-md hover:bg-white/5 hover:text-white transition-colors"
          >
            <ArrowClockwise size={14} /> Refresh
          </button>
        }
      />

      {/* Status filter */}
      <div className="flex items-center gap-1 mb-4">
        <Funnel size={14} className="text-neutral-500 mr-1" />
        {statuses.map(s => (
          <button
            key={s.key}
            onClick={() => setStatusFilter(s.key)}
            className={`px-3 py-1 rounded-full text-xs transition-colors ${
              statusFilter === s.key
                ? 'bg-white/10 text-white border border-white/20'
                : 'text-neutral-500 hover:text-white border border-transparent'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {loading ? (
        <RowSkeleton count={6} />
      ) : !filtered.length ? (
        <EmptyState
          icon={<Webhook size={32} />}
          title="No webhook events yet"
          description="Events will appear here when webhooks are received by your triggers."
        />
      ) : (
        <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
          {filtered.map(event => (
            <button
              key={event.id}
              onClick={() => setViewEvent(event)}
              className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
            >
              <div className="min-w-0 mr-3 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium truncate">
                    {event.event_type || 'Unknown event'}
                  </p>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    event.processed
                      ? 'bg-success/15 text-success'
                      : 'bg-warning/15 text-warning'
                  }`}>
                    {event.processed ? 'processed' : 'pending'}
                  </span>
                </div>
                <p className="text-xs text-neutral-400 mt-0.5">
                  {event.source}
                  <span className="mx-1.5">·</span>
                  {timeAgo(event.created_at)}
                </p>
              </div>
              <Eye size={14} className="text-neutral-500 shrink-0" />
            </button>
          ))}
        </div>
      )}

      {/* Detail modal */}
      {viewEvent && (
        <Modal open onClose={() => setViewEvent(null)} title="Webhook event" maxWidth="max-w-lg">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold">{viewEvent.event_type}</h4>
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                viewEvent.processed
                  ? 'bg-success/15 text-success'
                  : 'bg-warning/15 text-warning'
              }`}>
                {viewEvent.processed ? 'processed' : 'pending'}
              </span>
            </div>

            <div className="bg-white/5 rounded-lg p-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-400">Source</span>
                <span className="font-medium">{viewEvent.source}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Event type</span>
                <span className="font-medium">{viewEvent.event_type}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Received</span>
                <span className="font-medium">{new Date(viewEvent.created_at).toLocaleString()}</span>
              </div>
            </div>

            <div>
              <label className="text-xs text-neutral-400 block mb-1">Payload</label>
              <pre className="bg-white/[0.04] border border-white/[0.08] rounded-lg p-3 text-xs text-neutral-400 overflow-x-auto max-h-64 whitespace-pre-wrap font-mono">
                {JSON.stringify(parseJson(viewEvent.payload), null, 2)}
              </pre>
            </div>

            <div>
              <label className="text-xs text-neutral-400 block mb-1">Headers</label>
              <pre className="bg-white/[0.04] border border-white/[0.08] rounded-lg p-3 text-xs text-neutral-500 overflow-x-auto max-h-32 whitespace-pre-wrap font-mono">
                {JSON.stringify(parseJson(viewEvent.headers), null, 2)}
              </pre>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
