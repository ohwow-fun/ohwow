import { useState, useRef, useEffect, useCallback } from 'react';
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
} from '@phosphor-icons/react';
import { api, streamChat } from '../api/client';
import { PageHeader } from '../components/PageHeader';

/* ─── Types ─────────────────────────────────────────────────────────── */

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

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

/* ─── Main Page ─────────────────────────────────────────────────────── */

export function MessagesPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const conversationRef = useRef<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const activeTargetRef = useRef<{ type: string; id: string | null }>({ type: 'orchestrator', id: null });
  const abortRef = useRef<AbortController | null>(null);

  // Load sessions and agents on mount
  useEffect(() => {
    api<{ sessions: SessionSummary[] }>('/api/orchestrator/sessions')
      .then((data) => setSessions(data.sessions || []))
      .catch(() => {})
      .finally(() => setSessionsLoading(false));

    api<{ data: AgentInfo[] }>('/api/agents')
      .then((data) => setAgents(data.data || []))
      .catch(() => {});
  }, []);

  // Determine active target name
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const targetType = activeSession?.target_type || 'orchestrator';
  const targetName =
    targetType === 'agent'
      ? agents.find((a) => a.id === activeSession?.target_id)?.name || 'Agent'
      : 'Orchestrator';

  // ── Session CRUD ───────────────────────────────────────────────────

  const selectSession = useCallback(async (id: string) => {
    try {
      abortRef.current?.abort();
      const data = await api<{ messages: Record<string, unknown>[]; target_type: string; target_id: string | null }>(`/api/orchestrator/sessions/${id}`);
      const raw = Array.isArray(data.messages) ? data.messages : [];
      // Normalize: orchestrator saves in Anthropic MessageParam format (content can be block arrays)
      const restored = raw.map((m) => ({
        role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: normalizeContent(m.content),
      }));
      conversationRef.current = restored;
      activeTargetRef.current = { type: data.target_type || 'orchestrator', id: data.target_id || null };

      setActiveSessionId(id);
      setStreaming(false);
      setMessages(restored.map((m) => ({ id: nextId(), role: m.role, content: m.content })));
      setMobileSidebarOpen(false);
    } catch {
      // silent
    }
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
      setActiveSessionId(data.id);
      activeTargetRef.current = { type: targetType, id: targetId };
      conversationRef.current = [];
      setMessages([]);
      setStreaming(false);
      setMobileSidebarOpen(false);
    } catch {
      // silent
    }
  }, []);

  const deleteSession = useCallback(async (id: string) => {
    try {
      await api(`/api/orchestrator/sessions/${id}`, { method: 'DELETE' });
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeSessionId === id) {
        setActiveSessionId(null);
        setMessages([]);
        conversationRef.current = [];
      }
    } catch {
      // silent
    }
  }, [activeSessionId]);

  const _saveSession = useCallback(async () => {
    const sid = activeSessionId;
    const msgs = conversationRef.current;
    if (!sid || msgs.length === 0) return;
    try {
      const firstUser = msgs.find((m) => m.role === 'user')?.content || 'Untitled';
      await api(`/api/orchestrator/sessions/${sid}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: msgs, title: firstUser.slice(0, 60) }),
      });
      setSessions((prev) =>
        prev.map((s) => s.id === sid ? { ...s, message_count: msgs.length, title: firstUser.slice(0, 60), updated_at: new Date().toISOString() } : s)
      );
    } catch {
      // silent
    }
  }, [activeSessionId]);

  // ── Send message ──────────────────────────────────────────────────

  const sendMessage = useCallback(async (text: string) => {
    if (streaming || !activeSessionId) return;

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
      for await (const event of streamChat(text, activeSessionId)) {
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
      // Orchestrator auto-saves via saveToSession(); skip to avoid overwriting rich message format
      // Only update the session title in the sidebar
      const sid = activeSessionId;
      const msgs = conversationRef.current;
      if (sid && msgs.length > 0) {
        const firstUser = msgs.find((m) => m.role === 'user')?.content || 'Untitled';
        setSessions((prev) =>
          prev.map((s) => s.id === sid ? { ...s, message_count: msgs.length, title: firstUser.slice(0, 60), updated_at: new Date().toISOString() } : s)
        );
      }
    }
  }, [streaming, activeSessionId]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-6 pb-0">
        <PageHeader title="Messages" subtitle="Conversations with your agents and orchestrator" />
      </div>

      <div className="flex flex-1 min-h-0 mx-6 mb-6 border border-white/[0.08] rounded-xl overflow-hidden">
        {/* Desktop sidebar */}
        <div className="hidden md:flex w-72 flex-shrink-0">
          <LocalSessionList
            sessions={sessions}
            activeSessionId={activeSessionId}
            isLoading={sessionsLoading}
            agents={agents}
            onSelect={selectSession}
            onNewConversation={createSession}
            onDelete={deleteSession}
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
                  <LocalSessionList
                    sessions={sessions}
                    activeSessionId={activeSessionId}
                    isLoading={sessionsLoading}
                    agents={agents}
                    onSelect={selectSession}
                    onNewConversation={createSession}
                    onDelete={deleteSession}
                    onClose={() => setMobileSidebarOpen(false)}
                  />
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>

        {/* Chat panel */}
        <LocalChatPanel
          messages={messages}
          streaming={streaming}
          activeSessionId={activeSessionId}
          targetType={targetType}
          targetName={targetName}
          onSend={sendMessage}
        />
      </div>
    </div>
  );
}

/* ─── Session List (Local) ──────────────────────────────────────────── */

function LocalSessionList({
  sessions,
  activeSessionId,
  isLoading,
  agents,
  onSelect,
  onNewConversation,
  onDelete,
  onClose,
}: {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  isLoading: boolean;
  agents: AgentInfo[];
  onSelect: (id: string) => void;
  onNewConversation: (type: 'orchestrator' | 'agent', targetId: string | null, name?: string) => void;
  onDelete: (id: string) => void;
  onClose?: () => void;
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
    if (confirmId === id) { onDelete(id); setConfirmId(null); }
    else { setConfirmId(id); setTimeout(() => setConfirmId(null), 3000); }
  };

  return (
    <div className="flex flex-col h-full border-r border-white/[0.08] bg-black/40 w-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.08]">
        <span className="text-sm font-medium text-white">Conversations</span>
        <div className="flex items-center gap-1">
          <button onClick={() => setShowPicker(!showPicker)} className="p-1.5 text-neutral-500 hover:text-white transition-colors rounded-md hover:bg-white/5">
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
              <p className="text-[10px] uppercase tracking-widest text-neutral-600 px-2 py-1">New conversation with</p>
              <button onClick={() => { onNewConversation('orchestrator', null); setShowPicker(false); }} className="flex items-center gap-2.5 w-full px-2 py-2 text-sm text-neutral-400 hover:text-white hover:bg-white/[0.06] rounded-lg transition-all">
                <Lightning size={14} weight="bold" className="text-uplink" />
                Orchestrator
              </button>
              {agents.filter((a) => a.status === 'active').map((agent) => (
                <button key={agent.id} onClick={() => { onNewConversation('agent', agent.id, agent.name); setShowPicker(false); }} className="flex items-center gap-2.5 w-full px-2 py-2 text-sm text-neutral-400 hover:text-white hover:bg-white/[0.06] rounded-lg transition-all">
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
        {isLoading && (
          <div className="space-y-2 p-3">
            {[...Array(4)].map((_, i) => <div key={i} className="h-14 bg-white/[0.04] rounded-lg animate-pulse" />)}
          </div>
        )}

        {!isLoading && sessions.length === 0 && (
          <div className="flex flex-col items-center justify-center h-40 text-center px-4">
            <ChatCircle size={24} className="text-neutral-600 mb-2" />
            <p className="text-xs text-neutral-600">No conversations yet</p>
            <button onClick={() => setShowPicker(true)} className="mt-2 text-xs text-neutral-500 hover:text-white transition-colors">Start one</button>
          </div>
        )}

        {!isLoading && orchestratorSessions.length > 0 && (
          <SessionGroup label="Orchestrator" icon={<Lightning size={12} weight="bold" className="text-uplink" />} sessions={orchestratorSessions} activeId={activeSessionId} confirmId={confirmId} onSelect={onSelect} onDelete={handleDelete} />
        )}
        {!isLoading && [...agentGroups.entries()].map(([agentId, group]) => (
          <SessionGroup key={agentId} label={group.name} icon={<Robot size={12} weight="bold" className="text-terminal" />} sessions={group.sessions} activeId={activeSessionId} confirmId={confirmId} onSelect={onSelect} onDelete={handleDelete} />
        ))}
      </div>
    </div>
  );
}

function SessionGroup({
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

/* ─── Chat Panel (Local) ─────────────────────────────────────────────── */

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
            Select a conversation or start a new one.
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
