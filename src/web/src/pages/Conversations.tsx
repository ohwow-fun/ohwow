/**
 * Conversations — two-pane DM inbox.
 * Left: thread list. Right: messages + composer. Refresh every 5s.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../api/client';

// ---- types ------------------------------------------------------------

interface ThreadSummary {
  id: string;
  conversationPair: string;
  primaryName: string | null;
  displayName: string;
  contactId: string | null;
  contactName: string | null;
  contactSource: string | null;
  counterpartyUserId: string | null;
  lastPreview: string | null;
  lastMessageText: string | null;
  lastMessageDirection: string | null;
  lastSeenAt: string;
  hasUnread: boolean;
  unreadCount: number;
  observationCount: number;
  pendingApprovals: number;
}

interface Message {
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
    primaryName: string | null;
    displayName: string;
    counterpartyUserId: string | null;
    lastSeenAt: string;
    hasUnread: boolean;
    observationCount: number;
  };
  contact: {
    id: string;
    name: string | null;
    type: string | null;
    source: string | null;
    handle: string | null;
    createdAt: string | null;
    customFields: Record<string, unknown>;
  } | null;
  messages: Message[];
  nextSteps: NextStep[];
  approvals: {
    pending: ApprovalSummary[];
    applied: ApprovalSummary[];
  };
}

// ---- helpers ----------------------------------------------------------

function relTime(iso: string): string {
  const normalised = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z';
  const then = new Date(normalised).getTime();
  if (!Number.isFinite(then)) return '.';
  const ms = Date.now() - then;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function formatClock(iso: string): string {
  const normalised = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z';
  const d = new Date(normalised);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase() ?? '').join('') || '?';
}

// ---- thread list ------------------------------------------------------

function ThreadList({
  threads,
  activePair,
  onSelect,
}: {
  threads: ThreadSummary[];
  activePair: string | null;
  onSelect: (pair: string) => void;
}) {
  if (threads.length === 0) {
    return (
      <div className="p-6 text-xs text-neutral-500">
        No conversations yet. They appear here as soon as the DM poller observes an inbound thread.
      </div>
    );
  }
  return (
    <div className="divide-y divide-white/[0.04]">
      {threads.map(t => {
        const isActive = t.conversationPair === activePair;
        const lastText = t.lastMessageText || t.lastPreview || '(no messages yet)';
        const preview = lastText.replace(/\s+/g, ' ').slice(0, 80);
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.conversationPair)}
            className={`w-full text-left px-4 py-3 transition-colors ${
              isActive ? 'bg-white/[0.06]' : 'hover:bg-white/[0.02]'
            }`}
          >
            <div className="flex items-start gap-3">
              <div className="flex-none w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-[11px] font-semibold">
                {initials(t.displayName)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm truncate font-medium">{t.displayName}</span>
                  <span className="text-[10px] text-neutral-500 flex-none tabular-nums">{relTime(t.lastSeenAt)}</span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <p className="text-xs text-neutral-500 truncate flex-1">
                    {t.lastMessageDirection === 'outbound' ? 'You: ' : ''}{preview}
                  </p>
                  {t.unreadCount > 0 && (
                    <span className="text-[10px] bg-info text-black font-medium rounded-full px-1.5 py-0.5">
                      {t.unreadCount}
                    </span>
                  )}
                  {t.pendingApprovals > 0 && (
                    <span className="text-[10px] bg-warning/20 text-warning rounded-full px-1.5 py-0.5">
                      {t.pendingApprovals} draft
                    </span>
                  )}
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ---- message bubble ---------------------------------------------------

function MessageBubble({ m }: { m: Message }) {
  if (m.direction === 'unknown' && !m.text) return null;
  const isOut = m.direction === 'outbound';
  const isSynthetic = m.messageId.startsWith('outbound-');
  // Parse embedded media markers the poller writes into text.
  const mediaMatch = m.text?.match(/\[image:\s*([^\]]+)\]/i);
  const bodyText = mediaMatch ? m.text!.replace(mediaMatch[0], '').trim() : m.text;
  const imageUrls = mediaMatch ? mediaMatch[1].split(',').map(s => s.trim()).filter(Boolean) : [];

  return (
    <div className={`flex ${isOut ? 'justify-end' : 'justify-start'} mb-2`}>
      <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm ${
        isOut ? 'bg-info/80 text-black rounded-br-sm' : 'bg-white/[0.08] text-neutral-100 rounded-bl-sm'
      }`}>
        {bodyText && <p className="whitespace-pre-wrap">{bodyText}</p>}
        {imageUrls.length > 0 && (
          <div className="mt-2 space-y-1">
            {imageUrls.map(url => (
              <div key={url} className="text-[10px] text-black/70 italic">[attachment: {url.split('/').pop()}]</div>
            ))}
          </div>
        )}
        {!bodyText && m.isMedia && imageUrls.length === 0 && (
          <p className="italic text-xs opacity-70">[media attachment]</p>
        )}
        <p className={`text-[10px] mt-1 ${isOut ? 'text-black/60' : 'text-neutral-500'}`}>
          {formatClock(m.observedAt)}
          {isSynthetic && isOut && <span className="ml-1">· delivering</span>}
        </p>
      </div>
    </div>
  );
}

// ---- composer ---------------------------------------------------------

function Composer({
  onSend,
  suggestedDraft,
  sending,
}: {
  onSend: (text: string, autoApprove: boolean) => void;
  suggestedDraft: string | null;
  sending: boolean;
}) {
  const [text, setText] = useState('');
  const [autoApprove, setAutoApprove] = useState(true);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (suggestedDraft && !text) setText(suggestedDraft);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestedDraft]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    onSend(trimmed, autoApprove);
    setText('');
  };

  return (
    <div className="border-t border-white/[0.08] bg-white/[0.01] p-3">
      {suggestedDraft && text === suggestedDraft && (
        <p className="text-[10px] text-neutral-500 mb-1.5">
          Loaded from analyst draft. Edit freely before sending.
        </p>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Type a reply. ⌘+Enter to send."
          rows={2}
          className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-md px-3 py-2 text-sm text-white placeholder-neutral-600 outline-none focus:border-info/50 resize-none"
        />
        <button
          onClick={submit}
          disabled={!text.trim() || sending}
          className="bg-info text-black font-medium text-sm px-4 py-2 rounded-md disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110"
        >
          {sending ? 'Queuing.' : autoApprove ? 'Send' : 'Queue'}
        </button>
      </div>
      <div className="flex items-center justify-between mt-2 text-[11px]">
        <label className="flex items-center gap-1.5 text-neutral-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoApprove}
            onChange={e => setAutoApprove(e.target.checked)}
            className="accent-info"
          />
          Auto-approve (send on next reply-dispatcher tick)
        </label>
        <span className="text-neutral-600 tabular-nums">{text.length} / 1000</span>
      </div>
    </div>
  );
}

// ---- thread detail ----------------------------------------------------

function ThreadDetailPane({
  pair,
  detail,
  onSent,
}: {
  pair: string;
  detail: ThreadDetail | null;
  onSent: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const msgCount = detail?.messages.length ?? 0;

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [msgCount]);

  const latestOpenDraft = useMemo(() => {
    if (!detail) return null;
    const open = detail.nextSteps.find(n => n.status === 'open' && n.draftReply);
    return open?.draftReply ?? null;
  }, [detail]);

  const handleSend = useCallback(async (text: string, autoApprove: boolean) => {
    setSending(true);
    setError(null);
    try {
      await api(`/api/conversations/${encodeURIComponent(pair)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text, autoApprove }),
      });
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not queue reply. Try again.');
    } finally {
      setSending(false);
    }
  }, [pair, onSent]);

  if (!detail) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-neutral-500">
        Loading conversation.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.08]">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex-none w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-sm font-semibold">
            {initials(detail.thread.displayName)}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">{detail.thread.displayName}</p>
            <p className="text-[11px] text-neutral-500 truncate">
              {detail.contact?.handle ? `@${detail.contact.handle} · ` : ''}
              {detail.contact?.source ? `${detail.contact.source} · ` : ''}
              last seen {relTime(detail.thread.lastSeenAt)} ago
              {detail.thread.counterpartyUserId && ` · uid ${detail.thread.counterpartyUserId}`}
            </p>
          </div>
        </div>
        <div className="text-[11px] text-neutral-500 tabular-nums">
          {detail.messages.length} msg · {detail.approvals.pending.length} pending · {detail.approvals.applied.length} sent
        </div>
      </div>

      {/* Open next-step drafts */}
      {detail.nextSteps.some(n => n.status === 'open' || n.status === 'dispatched') && (
        <div className="border-b border-white/[0.06] bg-info/[0.03] px-5 py-2.5">
          <p className="text-[10px] uppercase tracking-wider text-info mb-1.5">Analyst next-steps for this contact</p>
          <ul className="space-y-1">
            {detail.nextSteps.slice(0, 3).map(n => (
              <li key={n.id} className="text-xs">
                <span className={`uppercase tracking-wider text-[10px] mr-2 ${
                  n.status === 'open' ? 'text-warning'
                  : n.status === 'dispatched' ? 'text-info'
                  : n.status === 'shipped' ? 'text-success'
                  : 'text-neutral-500'
                }`}>{n.stepType.replace(/_/g, ' ')} · {n.status}</span>
                <span className="text-neutral-400">{n.text.slice(0, 140)}</span>
                {n.sendConfirmed === true && (
                  <span className="ml-2 text-[10px] text-success">✓ confirmed</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Message history */}
      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-5 py-4">
        {detail.messages.length === 0 ? (
          <p className="text-sm text-neutral-500 text-center mt-10">No messages observed yet for this thread.</p>
        ) : (
          <AnimatePresence initial={false}>
            {detail.messages.map(m => (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.15 }}
              >
                <MessageBubble m={m} />
              </motion.div>
            ))}
          </AnimatePresence>
        )}

        {/* Pending outbound approvals (staged but not yet sent) */}
        {detail.approvals.pending.length > 0 && (
          <div className="mt-4 border border-warning/30 bg-warning/[0.04] rounded-lg p-3">
            <p className="text-[10px] uppercase tracking-wider text-warning mb-2">Pending outbound · awaiting operator</p>
            {detail.approvals.pending.map(a => (
              <div key={a.id} className="text-xs text-neutral-300 mb-1.5 last:mb-0">
                <span className="font-mono text-[10px] text-neutral-500">{a.id.slice(0, 8)}</span>
                {' '}<span className="uppercase tracking-wider text-[10px] text-neutral-500">{a.status}</span>
                <p className="mt-0.5">"{a.text}"</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="px-5 py-2 border-t border-critical/30 bg-critical/5 text-xs text-critical">{error}</div>
      )}

      <Composer onSend={handleSend} suggestedDraft={latestOpenDraft} sending={sending} />
    </div>
  );
}

// ---- main component ---------------------------------------------------

export function ConversationsPage() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activePair, setActivePair] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [tick, setTick] = useState(0);

  // Poll every 5s for live updates.
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  // Fetch thread list.
  useEffect(() => {
    let cancelled = false;
    api<{ data: ThreadSummary[] }>('/api/conversations')
      .then(res => {
        if (cancelled) return;
        setThreads(res.data);
        setError(null);
        setLoading(false);
        // Auto-select the first thread on initial load.
        setActivePair(prev => prev ?? res.data[0]?.conversationPair ?? null);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load conversations.');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [tick]);

  // Fetch detail when thread changes or on tick.
  useEffect(() => {
    if (!activePair) return;
    let cancelled = false;
    api<{ data: ThreadDetail }>(`/api/conversations/${encodeURIComponent(activePair)}`)
      .then(res => {
        if (cancelled) return;
        setDetail(res.data);
      })
      .catch(() => { /* keep prior detail on transient error */ });
    return () => { cancelled = true; };
  }, [activePair, tick]);

  const handleSent = useCallback(() => {
    // Force an immediate refresh after compose so the new pending
    // approval shows up without waiting for the 5s tick.
    setTick(n => n + 1);
  }, []);

  if (loading) {
    return (
      <div className="p-6 max-w-6xl">
        <h1 className="text-2xl font-semibold mb-2">Conversations</h1>
        <p className="text-sm text-neutral-500">Warming up.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 max-w-6xl">
        <h1 className="text-2xl font-semibold mb-2">Conversations</h1>
        <div className="border border-critical/30 bg-critical/5 rounded-lg p-4 text-sm text-critical">
          Couldn't load. {error}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Thread list */}
      <aside className="w-[340px] flex-none border-r border-white/[0.08] flex flex-col min-h-0">
        <div className="px-4 py-3 border-b border-white/[0.08]">
          <h1 className="text-sm font-semibold">Conversations</h1>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            {threads.length} thread{threads.length === 1 ? '' : 's'} · live via DM poller
          </p>
        </div>
        <div className="flex-1 overflow-y-auto">
          <ThreadList
            threads={threads}
            activePair={activePair}
            onSelect={setActivePair}
          />
        </div>
      </aside>

      {/* Detail pane */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {activePair ? (
          <ThreadDetailPane pair={activePair} detail={detail} onSent={handleSent} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-neutral-500">
            Select a conversation.
          </div>
        )}
      </div>
    </div>
  );
}
