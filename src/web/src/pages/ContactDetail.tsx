/**
 * Contact detail — the one page an operator opens to answer
 * "what's happening with this contact?"
 *
 * Pulls three shapes in parallel:
 *   1. /api/contacts/:id           → base row + custom_fields
 *   2. /api/contacts/:id/timeline  → raw contact_events (first_seen, x:qualified, etc.)
 *   3. /api/conversations/:pair    → DM thread + nextSteps + approvals,
 *                                    only if the contact has x_conversation_pair
 *
 * Layout prioritises the conversation + outstanding actions over CRM
 * metadata. The Edit/Delete form lives behind a button — it's not the
 * first thing an operator sees.
 */

import { useState, useCallback, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Trash,
  ChatCircle,
  ArrowRight,
  CaretDown,
  CaretRight,
} from '@phosphor-icons/react';
import { useApi } from '../hooks/useApi';
import { useWsRefresh } from '../hooks/useWebSocket';
import { api } from '../api/client';

/* ─── Types ─────────────────────────────────────────────────────────── */

interface Contact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  contact_type: string;
  status: string;
  tags: string[] | string | null;
  custom_fields: Record<string, unknown> | string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface TimelineEvent {
  id: string;
  event_type?: string | null;
  kind?: string | null;
  source?: string | null;
  description?: string | null;
  metadata?: string | null;
  payload?: string | Record<string, unknown> | null;
  created_at?: string | null;
  occurred_at?: string | null;
}

interface DmMessage {
  id: string;
  messageId: string;
  direction: 'inbound' | 'outbound' | 'unknown' | string;
  text: string | null;
  isMedia: boolean;
  observedAt: string;
}

interface NextStep {
  id: string;
  createdAt: string;
  stepType: string;
  urgency: string;
  status: string;
  text: string;
  suggestedAction: string;
  draftReply: string | null;
  approvalId: string | null;
  sendConfirmed: boolean | null;
}

interface ApprovalSummary {
  id: string;
  ts: string;
  status: string;
  summary: string;
  text: string;
  source: string | null;
}

interface ThreadDetail {
  thread: {
    id: string;
    conversationPair: string;
    displayName: string;
    counterpartyUserId: string | null;
    lastSeenAt: string;
    hasUnread: boolean;
    observationCount: number;
  };
  messages: DmMessage[];
  nextSteps: NextStep[];
  approvals: {
    pending: ApprovalSummary[];
    applied: ApprovalSummary[];
  };
}

/* ─── Utilities ─────────────────────────────────────────────────────── */

function parseUtc(s: string | null | undefined): Date {
  if (!s) return new Date(NaN);
  if (/Z$|[+-]\d\d:?\d\d$/.test(s)) return new Date(s);
  return new Date(s.replace(' ', 'T') + 'Z');
}

function relativeTime(s: string | null | undefined): string {
  if (!s) return '';
  const diff = Date.now() - parseUtc(s).getTime();
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return parseUtc(s).toLocaleDateString();
}

function asObject(x: unknown): Record<string, unknown> {
  if (x && typeof x === 'object' && !Array.isArray(x)) return x as Record<string, unknown>;
  if (typeof x === 'string') {
    try { const v = JSON.parse(x); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  }
  return {};
}

function asArray(x: unknown): unknown[] {
  if (Array.isArray(x)) return x;
  if (typeof x === 'string') {
    try { const v = JSON.parse(x); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  return [];
}

/** Human-readable event kind: 'x:qualified' → 'qualified', 'first_seen' → 'first seen' */
function formatKind(raw: string | null | undefined): string {
  if (!raw) return 'event';
  const stripped = raw.replace(/^x:/, '').replace(/:/g, ' ').replace(/_/g, ' ');
  return stripped;
}

/** Funnel stage derived from the highest-tier event present in the timeline. */
function deriveStage(events: TimelineEvent[]): { stage: string; color: string } {
  const kinds = new Set(events.map(e => e.kind ?? e.event_type ?? ''));
  if (kinds.has('plan:paid'))      return { stage: 'paid',      color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' };
  if (kinds.has('trial:started'))  return { stage: 'trial',     color: 'bg-violet-500/20 text-violet-300 border-violet-500/40' };
  if (kinds.has('demo:booked'))    return { stage: 'demo',      color: 'bg-blue-500/20 text-blue-300 border-blue-500/40' };
  if (kinds.has('x:reached'))      return { stage: 'engaged',   color: 'bg-sky-500/20 text-sky-300 border-sky-500/40' };
  if (kinds.has('x:qualified'))    return { stage: 'qualified', color: 'bg-amber-500/20 text-amber-300 border-amber-500/40' };
  return { stage: 'lead', color: 'bg-neutral-500/20 text-neutral-300 border-neutral-500/40' };
}

function urgencyColor(urgency: string): string {
  if (urgency === 'high')   return 'text-red-400';
  if (urgency === 'medium') return 'text-amber-400';
  return 'text-neutral-400';
}

function stepStatusChip(s: NextStep): { label: string; cls: string } {
  if (s.sendConfirmed === true)  return { label: 'shipped',    cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' };
  if (s.sendConfirmed === false) return { label: 'not confirmed', cls: 'bg-red-500/15 text-red-300 border-red-500/30' };
  if (s.status === 'dispatched') return { label: 'dispatched', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30' };
  if (s.status === 'ignored')    return { label: 'ignored',    cls: 'bg-neutral-500/15 text-neutral-400 border-neutral-500/30' };
  return { label: s.status || 'open', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' };
}

/* ─── Page ──────────────────────────────────────────────────────────── */

export function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const wsTick = useWsRefresh(['contact:upserted', 'dm:message', 'approval:created']);

  const { data: contact, loading, refetch } = useApi<Contact>(
    id ? `/api/contacts/${id}` : null, [wsTick],
  );
  const { data: timeline } = useApi<TimelineEvent[]>(
    id ? `/api/contacts/${id}/timeline` : null, [wsTick],
  );

  const cf = useMemo(() => asObject(contact?.custom_fields), [contact]);
  const conversationPair = typeof cf.x_conversation_pair === 'string' ? cf.x_conversation_pair : null;
  const handle = typeof cf.x_handle === 'string' ? cf.x_handle : null;

  const { data: thread } = useApi<ThreadDetail>(
    conversationPair ? `/api/conversations/${encodeURIComponent(conversationPair)}` : null,
    [wsTick],
  );

  const [eventsOpen, setEventsOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '', company: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const startEdit = useCallback(() => {
    if (!contact) return;
    setForm({
      name: contact.name ?? '',
      email: contact.email ?? '',
      phone: contact.phone ?? '',
      company: contact.company ?? '',
      notes: contact.notes ?? '',
    });
    setEditing(true);
  }, [contact]);

  const saveEdit = useCallback(async () => {
    if (!id || !form.name.trim()) return;
    setSaving(true);
    try {
      await api(`/api/contacts/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
          company: form.company.trim() || null,
          notes: form.notes.trim() || null,
        }),
      });
      setEditing(false);
      refetch();
    } finally {
      setSaving(false);
    }
  }, [id, form, refetch]);

  const handleDelete = useCallback(async () => {
    if (!id || !confirm('Delete this contact? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await api(`/api/contacts/${id}`, { method: 'DELETE' });
      navigate('/contacts');
    } catch {
      setDeleting(false);
    }
  }, [id, navigate]);

  if (loading && !contact) return <div className="p-6 text-neutral-400 text-sm">Loading.</div>;
  if (!contact) return <div className="p-6 text-neutral-400">Contact not found</div>;

  const events = timeline ?? [];
  const stage = deriveStage(events);
  const tags = asArray(contact.tags).filter((t): t is string => typeof t === 'string');
  const lastSeen = thread?.thread.lastSeenAt ?? contact.updated_at;

  const inbound  = thread?.messages.filter(m => m.direction === 'inbound').length  ?? 0;
  const outbound = thread?.messages.filter(m => m.direction === 'outbound').length ?? 0;
  const openSteps = thread?.nextSteps.filter(s => s.status === 'open' || s.status === 'dispatched').length ?? 0;
  const pendingApprovals = thread?.approvals.pending.length ?? 0;

  const recentMessages = thread?.messages.slice(-8) ?? [];

  return (
    <div className="p-6 max-w-5xl">
      <Link
        to="/contacts"
        className="inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-white mb-4"
      >
        <ArrowLeft size={14} /> Back to contacts
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-semibold truncate">{contact.name}</h1>
            <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border ${stage.color}`}>
              {stage.stage}
            </span>
          </div>
          <p className="text-xs text-neutral-400">
            {contact.contact_type}
            {handle && <> · <span className="text-sky-400">@{handle}</span></>}
            {typeof cf.x_source === 'string' && <> · via {cf.x_source}</>}
            {lastSeen && <> · last activity {relativeTime(lastSeen)}</>}
          </p>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {tags.map(t => (
                <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-neutral-300 border border-white/10">
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {conversationPair && (
            <Link
              to={`/messages?pair=${encodeURIComponent(conversationPair)}`}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-white/5 border border-white/10 text-white rounded-lg hover:bg-white/10"
            >
              <ChatCircle size={14} /> Open thread
            </Link>
          )}
          {!editing && (
            <button
              onClick={startEdit}
              className="px-3 py-1.5 text-xs font-medium bg-white/5 border border-white/10 text-white rounded-lg hover:bg-white/10"
            >
              Edit
            </button>
          )}
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-critical/10 border border-critical/30 text-critical rounded-lg hover:bg-critical/20 disabled:opacity-50"
          >
            <Trash size={14} /> {deleting ? 'Deleting' : 'Delete'}
          </button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        <KpiTile label="DMs in"           value={inbound}  hint={thread ? 'observed' : 'no thread'} />
        <KpiTile label="DMs out"          value={outbound} hint={outbound ? 'sent' : 'not reached'} />
        <KpiTile label="Next steps"       value={openSteps} hint={openSteps ? 'open + dispatched' : 'nothing pending'} accent={openSteps > 0 ? 'warn' : undefined} />
        <KpiTile label="Pending approval" value={pendingApprovals} hint={pendingApprovals ? 'awaiting you' : 'clear'} accent={pendingApprovals > 0 ? 'warn' : undefined} />
      </div>

      {/* Edit form */}
      {editing && (
        <div className="border border-white/[0.08] rounded-lg p-4 mb-6 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name"    value={form.name}    onChange={v => setForm(f => ({ ...f, name: v }))} />
            <Field label="Email"   value={form.email}   onChange={v => setForm(f => ({ ...f, email: v }))} />
            <Field label="Phone"   value={form.phone}   onChange={v => setForm(f => ({ ...f, phone: v }))} />
            <Field label="Company" value={form.company} onChange={v => setForm(f => ({ ...f, company: v }))} />
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Notes</label>
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={3}
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white resize-none focus:outline-none focus:border-white/20"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white">Cancel</button>
            <button
              onClick={saveEdit}
              disabled={saving || !form.name.trim()}
              className="px-3 py-1.5 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50"
            >
              {saving ? 'Saving' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {/* Thread */}
      {conversationPair && (
        <section className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[11px] uppercase tracking-wider text-neutral-400">
              Thread · last {recentMessages.length} of {thread?.messages.length ?? 0}
            </h2>
            <Link
              to={`/messages?pair=${encodeURIComponent(conversationPair)}`}
              className="text-[11px] text-neutral-400 hover:text-white inline-flex items-center gap-1"
            >
              Full thread <ArrowRight size={12} />
            </Link>
          </div>
          <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.06]">
            {recentMessages.length === 0 ? (
              <div className="px-4 py-6 text-sm text-neutral-500">No observed messages yet.</div>
            ) : recentMessages.map(m => (
              <div key={m.id} className="px-4 py-3">
                <div className="flex items-center gap-2 mb-1 text-[11px]">
                  <span className={m.direction === 'outbound' ? 'text-emerald-400' : 'text-sky-400'}>
                    {m.direction}
                  </span>
                  <span className="text-neutral-500">{relativeTime(m.observedAt)}</span>
                  {m.isMedia && <span className="text-neutral-500">· media</span>}
                </div>
                <div className="text-sm whitespace-pre-wrap break-words">
                  {m.text ?? <span className="italic text-neutral-500">(empty)</span>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Next steps */}
      {thread && thread.nextSteps.length > 0 && (
        <section className="mb-6">
          <h2 className="text-[11px] uppercase tracking-wider text-neutral-400 mb-2">
            Next steps from this conversation
          </h2>
          <div className="space-y-2">
            {thread.nextSteps.map(s => {
              const chip = stepStatusChip(s);
              return (
                <div key={s.id} className="border border-white/[0.08] rounded-lg p-3">
                  <div className="flex items-center justify-between gap-2 mb-1 text-[11px]">
                    <div className="flex items-center gap-2">
                      <span className="uppercase tracking-wider text-neutral-400">{formatKind(s.stepType)}</span>
                      <span className={urgencyColor(s.urgency)}>{s.urgency}</span>
                      <span className={`px-1.5 py-0.5 rounded border ${chip.cls}`}>{chip.label}</span>
                    </div>
                    <span className="text-neutral-500">{relativeTime(s.createdAt)}</span>
                  </div>
                  <div className="text-sm mb-1">{s.text}</div>
                  {s.suggestedAction && (
                    <div className="text-sm text-neutral-300">
                      <span className="text-neutral-500">→ </span>{s.suggestedAction}
                    </div>
                  )}
                  {s.draftReply && (
                    <div className="mt-2 text-sm text-neutral-200 bg-white/[0.03] border border-white/5 rounded p-2 italic">
                      &ldquo;{s.draftReply}&rdquo;
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Raw events — collapsible, defaults closed */}
      <section className="mb-6">
        <button
          onClick={() => setEventsOpen(v => !v)}
          className="w-full flex items-center justify-between text-[11px] uppercase tracking-wider text-neutral-400 hover:text-white mb-2"
        >
          <span className="inline-flex items-center gap-1">
            {eventsOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
            Raw events · {events.length}
          </span>
          <span className="normal-case text-neutral-500">
            {eventsOpen ? 'hide' : 'show'}
          </span>
        </button>
        {eventsOpen && (
          events.length === 0 ? (
            <div className="border border-white/[0.08] rounded-lg px-4 py-6 text-sm text-neutral-500 text-center">
              No events logged for this contact yet.
            </div>
          ) : (
            <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.06]">
              {events.map(ev => {
                const ts = ev.occurred_at ?? ev.created_at ?? '';
                const kind = ev.kind ?? ev.event_type ?? 'event';
                return (
                  <div key={ev.id} className="px-4 py-2">
                    <div className="flex items-center justify-between text-[11px] mb-0.5">
                      <div className="flex items-center gap-2">
                        <span className="uppercase tracking-wider text-neutral-300">{formatKind(kind)}</span>
                        {ev.source && <span className="text-neutral-500">via {ev.source}</span>}
                      </div>
                      <span className="text-neutral-500">{relativeTime(ts)}</span>
                    </div>
                    {ev.description && <div className="text-sm text-neutral-300">{ev.description}</div>}
                  </div>
                );
              })}
            </div>
          )
        )}
      </section>

      {/* Static CRM metadata tucked at the bottom */}
      {(contact.email || contact.phone || contact.company || contact.notes) && (
        <section>
          <h2 className="text-[11px] uppercase tracking-wider text-neutral-400 mb-2">CRM details</h2>
          <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.06]">
            {[
              { label: 'Email',   value: contact.email },
              { label: 'Phone',   value: contact.phone },
              { label: 'Company', value: contact.company },
              { label: 'Notes',   value: contact.notes },
            ].map(row => row.value ? (
              <div key={row.label} className="flex items-start justify-between gap-4 px-4 py-2.5">
                <span className="text-xs text-neutral-400 shrink-0">{row.label}</span>
                <span className="text-sm text-right">{row.value}</span>
              </div>
            ) : null)}
          </div>
        </section>
      )}
    </div>
  );
}

/* ─── Small helpers ─────────────────────────────────────────────────── */

function KpiTile({
  label, value, hint, accent,
}: {
  label: string; value: number; hint: string; accent?: 'warn';
}) {
  const valColor = accent === 'warn' && value > 0 ? 'text-amber-300' : 'text-white';
  return (
    <div className="border border-white/[0.08] rounded-lg px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-neutral-400 mb-1">{label}</div>
      <div className={`text-xl font-semibold ${valColor}`}>{value}</div>
      <div className="text-[11px] text-neutral-500">{hint}</div>
    </div>
  );
}

function Field({
  label, value, onChange,
}: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="text-xs text-neutral-400 block mb-1">{label}</label>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20"
      />
    </div>
  );
}
