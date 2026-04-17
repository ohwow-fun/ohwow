/**
 * Messages — unified inbox for CRM DM threads and AI chat sessions.
 *
 * Left rail groups:
 *   - Contacts: X DM threads (from /api/conversations)
 *   - Orchestrator: LLM planner sessions (existing)
 *   - Agents: per-agent chat history (existing)
 *
 * Right pane branches on the active conversation's kind:
 *   - 'crm'  → DmChatPanel: renders observed messages, pending drafts,
 *             and a composer that posts to /api/conversations/:pair/messages.
 *   - 'ai'   → LocalChatPanel: streams from /api/orchestrator/stream and
 *             persists via /api/orchestrator/sessions.
 *
 * CRM data is polled every 5s so inbound messages + approval state
 * reflect near-real-time without a dedicated websocket.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  PaperPlaneRight,
  Plus,
  Trash,
  ChatCircle,
  Robot,
  Lightning,
  X,
  List,
  User,
} from '@phosphor-icons/react';
import { api, streamChat } from '../api/client';
import { PageHeader } from '../components/PageHeader';

/* ─── Types ─────────────────────────────────────────────────────────── */

// AI chat messages + sessions (existing)
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
}

interface SessionSummary {
  id: string;
  title: string;
  message_count: number;
  target_type: 'orchestrator' | 'agent';
  target_id: string | null;
  updated_at: string;
}

interface AgentInfo {
  id: string;
  name: string;
  role: string;
  status: string;
}

// CRM DM threads + messages
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
  messages: DmMessage[];
  nextSteps: NextStep[];
  approvals: {
    pending: ApprovalSummary[];
    applied: ApprovalSummary[];
  };
}

// Unified active conversation selector
type ActiveConversation =
  | { kind: 'ai'; sessionId: string }
  | { kind: 'crm'; pair: string };

let msgIdCounter = 0;
function nextId() {
  return `lmsg-${++msgIdCounter}-${Date.now()}`;
}

/** Normalize Anthropic MessageParam content (string or content-block array) to a plain string */
function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: Record<string, unknown>) => {
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        if (block.type === 'tool_use') return `[Tool: ${block.name || 'unknown'}]`;
        if (block.type === 'tool_result') return typeof block.content === 'string' ? block.content : '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content || '');
}

function parseUtc(dateStr: string): Date {
  if (!dateStr) return new Date(NaN);
  if (/Z$|[+-]\d\d:?\d\d$/.test(dateStr)) return new Date(dateStr);
  return new Date(dateStr.replace(' ', 'T') + 'Z');
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - parseUtc(dateStr).getTime();
  if (diff < 0) return 'Just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return parseUtc(dateStr).toLocaleDateString();
}

function formatClock(iso: string): string {
  const d = parseUtc(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase() ?? '').join('') || '?';
}

/* ─── Main Page ─────────────────────────────────────────────────────── */

export function MessagesPage() {
  // AI chat state (existing)
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);

  // CRM state (new)
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null);

  // Unified selection
  const [active, setActive] = useState<ActiveConversation | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // Deep-link: /ui/messages?pair=<x_conversation_pair> opens a specific
  // CRM thread. Consumed once on mount, then cleared from the URL so a
  // later manual selection isn't reverted on re-render.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const pair = searchParams.get('pair');
    if (pair) {
      setActive({ kind: 'crm', pair });
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const conversationRef = useRef<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const activeTargetRef = useRef<{ type: string; id: string | null }>({ type: 'orchestrator', id: null });
  const abortRef = useRef<AbortController | null>(null);

  // ── Initial load: AI sessions + agents + CRM threads ────────────────
  useEffect(() => {
    api<{ sessions: SessionSummary[]; total: number }>('/api/orchestrator/sessions?limit=50&offset=0')
      .then((data) => {
        setSessions(data.sessions || []);
        setSessionsTotal(data.total || 0);
      })
      .catch(() => {})
      .finally(() => setSessionsLoading(false));

    api<{ data: AgentInfo[] }>('/api/agents')
      .then((data) => setAgents(data.data || []))
      .catch(() => {});
  }, []);

  // ── CRM: poll every 5s ─────────────────────────────────────────────
  const [crmTick, setCrmTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setCrmTick(n => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api<{ data: ThreadSummary[] }>('/api/conversations')
      .then(res => {
        if (cancelled) return;
        setThreads(res.data ?? []);
        setThreadsLoading(false);
      })
      .catch(() => {
        if (!cancelled) setThreadsLoading(false);
      });
    return () => { cancelled = true; };
  }, [crmTick]);

  // Detail fetch — only when a CRM thread is active.
  useEffect(() => {
    if (!active || active.kind !== 'crm') return;
    let cancelled = false;
    api<{ data: ThreadDetail }>(`/api/conversations/${encodeURIComponent(active.pair)}`)
      .then(res => {
        if (cancelled) return;
        setThreadDetail(res.data);
      })
      .catch(() => { /* keep prior detail on transient error */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, crmTick]);

  const loadMoreSessions = useCallback(async () => {
    if (sessionsLoadingMore || sessions.length >= sessionsTotal) return;
    setSessionsLoadingMore(true);
    try {
      const data = await api<{ sessions: SessionSummary[]; total: number }>(
        `/api/orchestrator/sessions?limit=50&offset=${sessions.length}`,
      );
      setSessions((prev) => [...prev, ...(data.sessions || [])]);
      setSessionsTotal(data.total || 0);
    } finally {
      setSessionsLoadingMore(false);
    }
  }, [sessions.length, sessionsTotal, sessionsLoadingMore]);

  // Resolved name/type for the AI-chat header.
  const activeSession = useMemo(() => {
    if (!active || active.kind !== 'ai') return null;
    return sessions.find((s) => s.id === active.sessionId) ?? null;
  }, [active, sessions]);
  const targetType = activeSession?.target_type || 'orchestrator';
  const targetName =
    targetType === 'agent'
      ? agents.find((a) => a.id === activeSession?.target_id)?.name || 'Agent'
      : 'Orchestrator';

  // ── AI session CRUD ────────────────────────────────────────────────
  const selectAiSession = useCallback(async (id: string) => {
    try {
      abortRef.current?.abort();
      const data = await api<{ messages: Record<string, unknown>[]; target_type: string; target_id: string | null }>(`/api/orchestrator/sessions/${id}`);
      const raw = Array.isArray(data.messages) ? data.messages : [];
      const restored = raw.map((m) => ({
        role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: normalizeContent(m.content),
      }));
      conversationRef.current = restored;
      activeTargetRef.current = { type: data.target_type || 'orchestrator', id: data.target_id || null };

      setActive({ kind: 'ai', sessionId: id });
      setStreaming(false);
      setMessages(restored.map((m) => ({ id: nextId(), role: m.role, content: m.content })));
      setMobileSidebarOpen(false);
    } catch {
      /* silent */
    }
  }, []);

  const selectCrmThread = useCallback((pair: string) => {
    setActive({ kind: 'crm', pair });
    setMobileSidebarOpen(false);
  }, []);

  const createSession = useCallback(async (targetType: 'orchestrator' | 'agent', targetId: string | null, agentName?: string) => {
    try {
      const title = targetType === 'agent' && agentName ? `Chat with ${agentName}` : 'New conversation';
      const data = await api<{ id: string; title: string }>('/api/orchestrator/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, messages: [], target_type: targetType, target_id: targetId }),
      });

      const newSession: SessionSummary = {
        id: data.id,
        title: data.title || title,
        message_count: 0,
        target_type: targetType,
        target_id: targetId,
        updated_at: new Date().toISOString(),
      };
      setSessions((prev) => [newSession, ...prev]);
      setActive({ kind: 'ai', sessionId: data.id });
      activeTargetRef.current = { type: targetType, id: targetId };
      conversationRef.current = [];
      setMessages([]);
      setStreaming(false);
      setMobileSidebarOpen(false);
    } catch {
      /* silent */
    }
  }, []);

  const deleteSession = useCallback(async (id: string) => {
    try {
      await api(`/api/orchestrator/sessions/${id}`, { method: 'DELETE' });
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setActive(prev => prev && prev.kind === 'ai' && prev.sessionId === id ? null : prev);
      setMessages([]);
      conversationRef.current = [];
    } catch {
      /* silent */
    }
  }, []);

  // ── AI send ────────────────────────────────────────────────────────
  const sendAiMessage = useCallback(async (text: string) => {
    if (streaming || !active || active.kind !== 'ai') return;

    conversationRef.current.push({ role: 'user', content: text });
    const userMsgId = nextId();
    const assistantMsgId = nextId();

    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', content: text },
      { id: assistantMsgId, role: 'assistant', content: '', isStreaming: true },
    ]);
    setStreaming(true);

    let assistantContent = '';
    try {
      for await (const event of streamChat(text, active.sessionId)) {
        if (event.type === 'text') {
          assistantContent += event.content as string;
          setMessages((prev) =>
            prev.map((m) => m.id === assistantMsgId ? { ...m, content: assistantContent } : m)
          );
        }
      }
    } catch {
      assistantContent += '\n\n[Connection lost. Try again.]';
    } finally {
      setMessages((prev) =>
        prev.map((m) => m.id === assistantMsgId ? { ...m, content: assistantContent || 'No response.', isStreaming: false } : m)
      );
      conversationRef.current.push({ role: 'assistant', content: assistantContent });
      setStreaming(false);
      const sid = active.sessionId;
      const msgs = conversationRef.current;
      if (msgs.length > 0) {
        const firstUser = msgs.find((m) => m.role === 'user')?.content || 'Untitled';
        setSessions((prev) =>
          prev.map((s) => s.id === sid ? { ...s, message_count: msgs.length, title: firstUser.slice(0, 60), updated_at: new Date().toISOString() } : s)
        );
      }
    }
  }, [streaming, active]);

  // ── CRM send ───────────────────────────────────────────────────────
  const sendCrmMessage = useCallback(async (text: string, autoApprove: boolean) => {
    if (!active || active.kind !== 'crm') return;
    try {
      await api(`/api/conversations/${encodeURIComponent(active.pair)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text, autoApprove }),
      });
      // Force immediate refresh so the new pending/approved row shows up.
      setCrmTick(n => n + 1);
    } catch (err) {
      throw err instanceof Error ? err : new Error('send failed');
    }
  }, [active]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-6 pb-0">
        <PageHeader title="Messages" subtitle="CRM conversations and AI chats in one inbox" />
      </div>

      <div className="flex flex-1 min-h-0 mx-6 mb-6 border border-white/[0.08] rounded-xl overflow-hidden">
        {/* Desktop sidebar */}
        <div className="hidden md:flex w-72 flex-shrink-0">
          <UnifiedSidebar
            threads={threads}
            threadsLoading={threadsLoading}
            sessions={sessions}
            sessionsLoading={sessionsLoading}
            agents={agents}
            active={active}
            onSelectCrm={selectCrmThread}
            onSelectAi={selectAiSession}
            onNewAiConversation={createSession}
            onDeleteAi={deleteSession}
            total={sessionsTotal}
            onLoadMore={loadMoreSessions}
            loadingMore={sessionsLoadingMore}
          />
        </div>

        {/* Mobile sidebar */}
        <div className="md:hidden">
          <button
            onClick={() => setMobileSidebarOpen(true)}
            className="absolute top-[120px] left-8 z-30 p-2 bg-black border border-white/10 rounded-lg text-neutral-400 hover:text-white transition-colors"
          >
            <List size={18} />
          </button>
          <AnimatePresence>
            {mobileSidebarOpen && (
              <>
                <motion.div
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  onClick={() => setMobileSidebarOpen(false)}
                  className="fixed inset-0 bg-black/60 z-40"
                />
                <motion.div
                  initial={{ x: -300 }} animate={{ x: 0 }} exit={{ x: -300 }}
                  transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                  className="fixed inset-y-0 left-0 w-[300px] z-50 bg-black"
                >
                  <UnifiedSidebar
                    threads={threads}
                    threadsLoading={threadsLoading}
                    sessions={sessions}
                    sessionsLoading={sessionsLoading}
                    agents={agents}
                    active={active}
                    onSelectCrm={selectCrmThread}
                    onSelectAi={selectAiSession}
                    onNewAiConversation={createSession}
                    onDeleteAi={deleteSession}
                    total={sessionsTotal}
                    onLoadMore={loadMoreSessions}
                    loadingMore={sessionsLoadingMore}
                    onClose={() => setMobileSidebarOpen(false)}
                  />
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>

        {/* Right pane — branches by kind */}
        {active?.kind === 'crm' ? (
          <DmChatPanel detail={threadDetail} onSend={sendCrmMessage} />
        ) : (
          <LocalChatPanel
            messages={messages}
            streaming={streaming}
            activeSessionId={active?.kind === 'ai' ? active.sessionId : null}
            targetType={targetType}
            targetName={targetName}
            onSend={sendAiMessage}
          />
        )}
      </div>
    </div>
  );
}

/* ─── Unified sidebar ─────────────────────────────────────────────── */

function UnifiedSidebar({
  threads,
  threadsLoading,
  sessions,
  sessionsLoading,
  agents,
  active,
  onSelectCrm,
  onSelectAi,
  onNewAiConversation,
  onDeleteAi,
  onClose,
  total,
  onLoadMore,
  loadingMore,
}: {
  threads: ThreadSummary[];
  threadsLoading: boolean;
  sessions: SessionSummary[];
  sessionsLoading: boolean;
  agents: AgentInfo[];
  active: ActiveConversation | null;
  onSelectCrm: (pair: string) => void;
  onSelectAi: (id: string) => void;
  onNewAiConversation: (type: 'orchestrator' | 'agent', targetId: string | null, name?: string) => void;
  onDeleteAi: (id: string) => void;
  onClose?: () => void;
  total: number;
  onLoadMore: () => void;
  loadingMore: boolean;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const orchestratorSessions = sessions.filter((s) => s.target_type === 'orchestrator');
  const agentSessions = sessions.filter((s) => s.target_type === 'agent');
  const agentGroups = new Map<string, { name: string; sessions: SessionSummary[] }>();
  for (const s of agentSessions) {
    const tid = s.target_id || 'unknown';
    if (!agentGroups.has(tid)) {
      agentGroups.set(tid, { name: agents.find((a) => a.id === tid)?.name || 'Agent', sessions: [] });
    }
    agentGroups.get(tid)!.sessions.push(s);
  }

  const handleDelete = (id: string) => {
    if (confirmId === id) { onDeleteAi(id); setConfirmId(null); }
    else { setConfirmId(id); setTimeout(() => setConfirmId(null), 3000); }
  };

  const activeCrmPair = active?.kind === 'crm' ? active.pair : null;
  const activeAiId = active?.kind === 'ai' ? active.sessionId : null;
  const nothingYet = !threadsLoading && !sessionsLoading && threads.length === 0 && sessions.length === 0;

  return (
    <div className="flex flex-col h-full border-r border-white/[0.08] bg-black/40 w-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.08]">
        <span className="text-sm font-medium text-white">Inbox</span>
        <div className="flex items-center gap-1">
          <button onClick={() => setShowPicker(!showPicker)} className="p-1.5 text-neutral-500 hover:text-white transition-colors rounded-md hover:bg-white/5" title="New AI conversation">
            <Plus size={16} weight="bold" />
          </button>
          {onClose && (
            <button onClick={onClose} className="p-1.5 text-neutral-500 hover:text-white transition-colors md:hidden">
              <X size={16} weight="bold" />
            </button>
          )}
        </div>
      </div>

      <AnimatePresence>
        {showPicker && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="border-b border-white/[0.06] overflow-hidden">
            <div className="p-2 space-y-0.5">
              <p className="text-[10px] uppercase tracking-widest text-neutral-600 px-2 py-1">New AI conversation with</p>
              <button onClick={() => { onNewAiConversation('orchestrator', null); setShowPicker(false); }} className="flex items-center gap-2.5 w-full px-2 py-2 text-sm text-neutral-400 hover:text-white hover:bg-white/[0.06] rounded-lg transition-all">
                <Lightning size={14} weight="bold" className="text-uplink" />
                Orchestrator
              </button>
              {agents.filter((a) => a.status === 'active').map((agent) => (
                <button key={agent.id} onClick={() => { onNewAiConversation('agent', agent.id, agent.name); setShowPicker(false); }} className="flex items-center gap-2.5 w-full px-2 py-2 text-sm text-neutral-400 hover:text-white hover:bg-white/[0.06] rounded-lg transition-all">
                  <Robot size={14} weight="bold" className="text-terminal" />
                  <div className="text-left min-w-0">
                    <span className="block truncate">{agent.name}</span>
                    <span className="block text-[10px] text-neutral-600 truncate">{agent.role}</span>
                  </div>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 overflow-y-auto">
        {nothingYet && (
          <div className="flex flex-col items-center justify-center h-40 text-center px-4">
            <ChatCircle size={24} className="text-neutral-600 mb-2" />
            <p className="text-xs text-neutral-600">No conversations yet</p>
            <button onClick={() => setShowPicker(true)} className="mt-2 text-xs text-neutral-500 hover:text-white transition-colors">Start one</button>
          </div>
        )}

        {(threadsLoading || threads.length > 0) && (
          <div className="py-1">
            <div className="flex items-center gap-1.5 px-4 py-1.5">
              <User size={12} weight="bold" className="text-info" />
              <span className="text-[10px] uppercase tracking-widest text-neutral-600">Contacts</span>
              {threads.length > 0 && (
                <span className="text-[10px] text-neutral-600 ml-auto">{threads.length}</span>
              )}
            </div>
            {threadsLoading && threads.length === 0 && (
              <div className="space-y-2 px-3 py-1">
                {[...Array(2)].map((_, i) => <div key={i} className="h-12 bg-white/[0.04] rounded-lg animate-pulse" />)}
              </div>
            )}
            {threads.map(t => {
              const isActive = t.conversationPair === activeCrmPair;
              const lastText = t.lastMessageText || t.lastPreview || '(no messages yet)';
              const preview = lastText.replace(/\s+/g, ' ').slice(0, 60);
              return (
                <button
                  key={t.id}
                  onClick={() => onSelectCrm(t.conversationPair)}
                  className={`w-full text-left px-3 mx-1 rounded-md transition-colors ${
                    isActive ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'
                  }`}
                >
                  <div className="flex items-start gap-2.5 py-2.5">
                    <div className="flex-none w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-[11px] font-semibold mt-0.5">
                      {initials(t.displayName)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm text-white truncate font-medium">{t.displayName}</span>
                        <span className="text-[10px] text-neutral-600 flex-none tabular-nums">{relativeTime(t.lastSeenAt)}</span>
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <p className="text-[11px] text-neutral-500 truncate flex-1">
                          {t.lastMessageDirection === 'outbound' ? 'You: ' : ''}{preview}
                        </p>
                        {t.unreadCount > 0 && (
                          <span className="text-[10px] bg-info text-black font-medium rounded-full px-1.5">
                            {t.unreadCount}
                          </span>
                        )}
                        {t.pendingApprovals > 0 && (
                          <span className="text-[10px] bg-warning/20 text-warning rounded-full px-1.5" title="pending drafts">
                            {t.pendingApprovals}·d
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {sessionsLoading && sessions.length === 0 && (
          <div className="space-y-2 p-3">
            {[...Array(3)].map((_, i) => <div key={i} className="h-14 bg-white/[0.04] rounded-lg animate-pulse" />)}
          </div>
        )}

        {!sessionsLoading && orchestratorSessions.length > 0 && (
          <AiSessionGroup
            label="Orchestrator"
            icon={<Lightning size={12} weight="bold" className="text-uplink" />}
            sessions={orchestratorSessions}
            activeId={activeAiId}
            confirmId={confirmId}
            onSelect={onSelectAi}
            onDelete={handleDelete}
          />
        )}
        {!sessionsLoading && [...agentGroups.entries()].map(([agentId, group]) => (
          <AiSessionGroup
            key={agentId}
            label={group.name}
            icon={<Robot size={12} weight="bold" className="text-terminal" />}
            sessions={group.sessions}
            activeId={activeAiId}
            confirmId={confirmId}
            onSelect={onSelectAi}
            onDelete={handleDelete}
          />
        ))}
        {!sessionsLoading && sessions.length > 0 && sessions.length < total && (
          <div className="flex flex-col items-center gap-1 py-3">
            <button
              onClick={onLoadMore}
              disabled={loadingMore}
              className="text-xs text-neutral-400 hover:text-white transition-colors disabled:opacity-50"
            >
              {loadingMore ? 'Loading...' : `Load ${Math.min(50, total - sessions.length)} more`}
            </button>
            <span className="text-[10px] text-neutral-600">{sessions.length} of {total}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function AiSessionGroup({
  label, icon, sessions, activeId, confirmId, onSelect, onDelete,
}: {
  label: string; icon: React.ReactNode; sessions: SessionSummary[]; activeId: string | null; confirmId: string | null;
  onSelect: (id: string) => void; onDelete: (id: string) => void;
}) {
  return (
    <div className="py-1">
      <div className="flex items-center gap-1.5 px-4 py-1.5">
        {icon}
        <span className="text-[10px] uppercase tracking-widest text-neutral-600">{label}</span>
      </div>
      {sessions.map((s) => (
        <div key={s.id} className={`group flex items-center px-3 mx-1 rounded-md transition-colors cursor-pointer ${s.id === activeId ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'}`}>
          <button onClick={() => onSelect(s.id)} className="flex-1 text-left py-2.5 min-w-0">
            <p className="text-sm text-white truncate leading-snug">{s.title}</p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[11px] text-neutral-600">{relativeTime(s.updated_at)}</span>
              <span className="text-[11px] text-neutral-600">{s.message_count} msg{s.message_count !== 1 ? 's' : ''}</span>
            </div>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
            className={`p-1 rounded transition-colors shrink-0 ${confirmId === s.id ? 'text-critical bg-critical/10' : 'text-neutral-700 hover:text-critical opacity-0 group-hover:opacity-100'}`}
            title={confirmId === s.id ? 'Click again to confirm' : 'Delete'}
          >
            <Trash size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ─── AI Chat Panel ─────────────────────────────────────────────── */

function LocalChatPanel({
  messages,
  streaming,
  activeSessionId,
  targetType,
  targetName,
  onSend,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  activeSessionId: string | null;
  targetType: string;
  targetName: string;
  onSend: (text: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || streaming) return;
    onSend(text);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!activeSessionId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-14 h-14 rounded-full bg-white/[0.06] flex items-center justify-center mx-auto">
            <ChatCircle size={28} weight="duotone" className="text-neutral-500" />
          </div>
          <h3 className="text-lg font-semibold text-white">Messages</h3>
          <p className="text-sm text-neutral-500 max-w-xs">
            Select a contact, orchestrator, or agent conversation from the sidebar.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-5 py-3 border-b border-white/[0.08]">
        {targetType === 'agent' ? (
          <Robot size={16} weight="bold" className="text-terminal" />
        ) : (
          <Lightning size={16} weight="bold" className="text-uplink" />
        )}
        <span className="text-sm font-medium text-white">{targetName}</span>
        {streaming && <span className="text-[11px] text-uplink ml-auto animate-pulse">Responding...</span>}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-neutral-500 text-sm">
            Send a message to start the conversation.
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <div className={`w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold ${msg.role === 'user' ? 'bg-white/10 text-white' : 'bg-uplink/10 text-uplink'}`}>
              {msg.role === 'user' ? 'You' : (targetName[0] || 'O')}
            </div>
            <div className={`max-w-[80%] rounded-xl px-4 py-3 text-sm ${msg.role === 'user' ? 'bg-white/[0.08] text-white' : 'bg-white/[0.03] border border-white/[0.08] text-neutral-200'}`}>
              <pre className="whitespace-pre-wrap break-words font-sans">{msg.content || (msg.isStreaming ? '...' : '')}</pre>
              {msg.isStreaming && <span className="inline-block w-1.5 h-4 bg-uplink/70 animate-pulse ml-0.5 align-text-bottom rounded-sm" />}
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="border-t border-white/[0.08] px-5 py-3">
        <div className="flex gap-2 max-w-2xl">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            disabled={streaming}
            className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20 resize-none disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={streaming || !input.trim()}
            className="bg-white text-black rounded-xl px-4 hover:bg-neutral-200 transition-colors disabled:opacity-50"
          >
            <PaperPlaneRight size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── DM Chat Panel ─────────────────────────────────────────────── */

function DmMessageBubble({ m }: { m: DmMessage }) {
  if (m.direction === 'unknown' && !m.text) return null;
  const isOut = m.direction === 'outbound';
  const isSynthetic = m.messageId.startsWith('outbound-');
  // Decode embedded media markers the poller writes into text.
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
              <div key={url} className="text-[10px] italic opacity-70">[attachment: {url.split('/').pop()}]</div>
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

function DmComposer({
  onSend,
  suggestedDraft,
}: {
  onSend: (text: string, autoApprove: boolean) => Promise<void>;
  suggestedDraft: string | null;
}) {
  const [text, setText] = useState('');
  const [autoApprove, setAutoApprove] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedDraftRef = useRef<string | null>(null);

  useEffect(() => {
    if (suggestedDraft && loadedDraftRef.current !== suggestedDraft && !text) {
      setText(suggestedDraft);
      loadedDraftRef.current = suggestedDraft;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestedDraft]);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(trimmed, autoApprove);
      setText('');
      loadedDraftRef.current = null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not queue reply.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-t border-white/[0.08] bg-white/[0.01] p-3">
      {suggestedDraft && text === suggestedDraft && (
        <p className="text-[10px] text-neutral-500 mb-1.5">
          Loaded from analyst draft. Edit freely before sending.
        </p>
      )}
      {error && <p className="text-[11px] text-critical mb-1.5">{error}</p>}
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Type a reply. ⌘+Enter to send."
          rows={2}
          className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-md px-3 py-2 text-sm text-white placeholder-neutral-600 outline-none focus:border-info/50 resize-none"
        />
        <button
          onClick={() => void submit()}
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

function DmChatPanel({
  detail,
  onSend,
}: {
  detail: ThreadDetail | null;
  onSend: (text: string, autoApprove: boolean) => Promise<void>;
}) {
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

  if (!detail) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-neutral-500">
        Loading conversation.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.08]">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex-none w-9 h-9 rounded-full bg-white/10 flex items-center justify-center text-xs font-semibold">
            {initials(detail.thread.displayName)}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">{detail.thread.displayName}</p>
            <p className="text-[11px] text-neutral-500 truncate">
              {detail.contact?.handle ? `@${detail.contact.handle} · ` : ''}
              {detail.contact?.source ? `${detail.contact.source} · ` : ''}
              last seen {relativeTime(detail.thread.lastSeenAt)}
              {detail.thread.counterpartyUserId && ` · uid ${detail.thread.counterpartyUserId}`}
            </p>
          </div>
        </div>
        <div className="text-[11px] text-neutral-500 tabular-nums flex-none">
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
                <DmMessageBubble m={m} />
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

      <DmComposer onSend={onSend} suggestedDraft={latestOpenDraft} />
    </div>
  );
}
