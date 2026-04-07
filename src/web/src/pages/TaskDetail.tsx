import { useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft,
  CaretDown,
  CaretRight,
  Clock,
  CheckCircle,
  XCircle,
  CircleNotch,
} from '@phosphor-icons/react';
import { motion, AnimatePresence } from 'framer-motion';
import { useApi } from '../hooks/useApi';
import { StatusBadge } from '../components/StatusBadge';
import { PageHeader } from '../components/PageHeader';
import { RowSkeleton } from '../components/Skeleton';

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  agent_id: string;
  priority?: string | null;
  model_used: string | null;
  tokens_used: number | null;
  cost_cents: number | null;
  duration_seconds: number | null;
  output: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface Agent {
  id: string;
  name: string;
}

interface Message {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

interface Deliverable {
  id: string;
  deliverable_type: string;
  title: string;
  content: string;
  status: string;
  rejection_reason: string | null;
  auto_created: number;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/*  Collapsible Section                                                */
/* ------------------------------------------------------------------ */

function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="mb-6">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-sm font-medium text-neutral-400 uppercase tracking-wider mb-2 hover:text-white transition-colors"
      >
        {open ? <CaretDown size={14} weight="bold" /> : <CaretRight size={14} weight="bold" />}
        {title}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Timeline                                                           */
/* ------------------------------------------------------------------ */

interface TimelineEvent {
  label: string;
  timestamp: string;
  color: string;
  icon: React.ReactNode;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <div className="mb-6">
      <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wider mb-3">Timeline</h2>
      <div className="relative pl-6">
        {/* Vertical line */}
        <div className="absolute left-[7px] top-1 bottom-1 w-px bg-white/[0.12]" />

        <div className="space-y-4">
          {events.map((ev, i) => (
            <div key={i} className="relative flex items-start gap-3">
              {/* Dot */}
              <div
                className="absolute -left-6 top-0.5 flex items-center justify-center w-[15px] h-[15px] rounded-full ring-2 ring-black"
                style={{ backgroundColor: ev.color }}
              >
                <span className="flex items-center justify-center text-black">
                  {ev.icon}
                </span>
              </div>
              {/* Content */}
              <div className="min-w-0">
                <p className="text-sm font-medium">{ev.label}</p>
                <p className="text-xs text-neutral-400">{formatTimestamp(ev.timestamp)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tool Call Card                                                     */
/* ------------------------------------------------------------------ */

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function tryParseToolCalls(content: string): ToolCall[] | null {
  try {
    const parsed = JSON.parse(content);

    // Handle array of tool_use blocks (Anthropic format)
    if (Array.isArray(parsed)) {
      const toolUseBlocks = parsed.filter(
        (b: Record<string, unknown>) => b.type === 'tool_use'
      );
      if (toolUseBlocks.length > 0) {
        return toolUseBlocks.map((b: Record<string, unknown>) => ({
          name: b.name as string,
          arguments: (b.input ?? b.arguments ?? {}) as Record<string, unknown>,
        }));
      }
    }

    // Handle object with tool_calls key (OpenAI format)
    if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
      return parsed.tool_calls.map((tc: Record<string, unknown>) => ({
        name: (tc.function as Record<string, unknown>)?.name as string ?? tc.name as string,
        arguments:
          typeof (tc.function as Record<string, unknown>)?.arguments === 'string'
            ? JSON.parse((tc.function as Record<string, unknown>).arguments as string)
            : (tc.function as Record<string, unknown>)?.arguments ?? tc.arguments ?? {},
      }));
    }

    // Handle single tool_use object
    if (parsed.type === 'tool_use' && parsed.name) {
      return [{ name: parsed.name, arguments: parsed.input ?? parsed.arguments ?? {} }];
    }
  } catch {
    // Not JSON, fall through
  }
  return null;
}

function ToolCallCard({ call }: { call: ToolCall }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-white/[0.08] rounded-lg p-3 my-1">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono font-medium bg-blue-500/15 text-blue-400 border border-blue-500/30">
          {call.name}
        </span>
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          className="text-xs text-neutral-400 hover:text-white transition-colors flex items-center gap-0.5"
        >
          {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
          {expanded ? 'Hide args' : 'Show args'}
        </button>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            style={{ overflow: 'hidden' }}
          >
            <pre className="text-xs text-neutral-300 mt-2 whitespace-pre-wrap break-words bg-white/[0.03] rounded p-2">
              {JSON.stringify(call.arguments, null, 2)}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Message Renderer                                                   */
/* ------------------------------------------------------------------ */

function MessageContent({ content }: { content: string }) {
  const toolCalls = useMemo(() => tryParseToolCalls(content), [content]);

  if (toolCalls) {
    return (
      <div className="space-y-1">
        {toolCalls.map((tc, i) => (
          <ToolCallCard key={i} call={tc} />
        ))}
      </div>
    );
  }

  return (
    <pre className="whitespace-pre-wrap break-words">
      {typeof content === 'string' ? content : JSON.stringify(content)}
    </pre>
  );
}

/* ------------------------------------------------------------------ */
/*  Priority Badge                                                     */
/* ------------------------------------------------------------------ */

const priorityStyles: Record<string, string> = {
  critical: 'bg-critical/15 text-critical border-critical/30',
  high: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  medium: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  low: 'bg-neutral-500/15 text-neutral-400 border-neutral-500/30',
};

function PriorityBadge({ priority }: { priority: string }) {
  const style = priorityStyles[priority.toLowerCase()] ?? priorityStyles.low;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${style}`}>
      {priority}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: task, loading } = useApi<Task>(id ? `/api/tasks/${id}` : null);
  const { data: messages } = useApi<Message[]>(id ? `/api/tasks/${id}/messages` : null);
  const { data: deliverables } = useApi<Deliverable[]>(id ? `/api/tasks/${id}/deliverables` : null);
  const { data: agent } = useApi<Agent>(
    task?.agent_id ? `/api/agents/${task.agent_id}` : null,
  );

  /* Build timeline events */
  const timelineEvents = useMemo<TimelineEvent[]>(() => {
    if (!task) return [];
    const events: TimelineEvent[] = [];

    events.push({
      label: 'Created',
      timestamp: task.created_at,
      color: '#737373', // neutral
      icon: <Clock size={9} weight="bold" />,
    });

    if (task.started_at) {
      events.push({
        label: 'Started',
        timestamp: task.started_at,
        color: '#3b82f6', // blue
        icon: <CircleNotch size={9} weight="bold" />,
      });
    }

    if (task.completed_at) {
      const failed = task.status === 'failed' || task.status === 'error';
      events.push({
        label: failed ? 'Failed' : 'Completed',
        timestamp: task.completed_at,
        color: failed ? '#ef4444' : '#22c55e',
        icon: failed
          ? <XCircle size={9} weight="bold" />
          : <CheckCircle size={9} weight="bold" />,
      });
    }

    return events;
  }, [task]);

  if (loading) return <div className="p-6"><RowSkeleton count={6} /></div>;
  if (!task) return <div className="p-6 text-neutral-400">Task not found</div>;

  return (
    <div className="p-6 max-w-4xl">
      <Link to="/tasks" className="inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-white mb-4">
        <ArrowLeft size={14} /> Back to tasks
      </Link>

      <PageHeader
        title={task.title}
        action={
          <div className="flex items-center gap-2">
            {task.priority && <PriorityBadge priority={task.priority} />}
            <StatusBadge status={task.status} />
          </div>
        }
      />

      {task.description && (
        <p className="text-sm text-neutral-400 mb-4">{task.description}</p>
      )}

      {/* Timeline */}
      {timelineEvents.length > 0 && <Timeline events={timelineEvents} />}

      {/* Meta */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {agent && (
          <div className="border border-white/[0.08] rounded-lg p-3">
            <p className="text-xs text-neutral-400">Agent</p>
            <Link
              to={`/agents/${agent.id}`}
              className="text-sm font-medium mt-0.5 text-blue-400 hover:text-blue-300 transition-colors block"
            >
              {agent.name}
            </Link>
          </div>
        )}
        {task.model_used && (
          <div className="border border-white/[0.08] rounded-lg p-3">
            <p className="text-xs text-neutral-400">Model</p>
            <p className="text-sm font-medium mt-0.5">{task.model_used}</p>
          </div>
        )}
        {task.tokens_used != null && (
          <div className="border border-white/[0.08] rounded-lg p-3">
            <p className="text-xs text-neutral-400">Tokens</p>
            <p className="text-sm font-medium mt-0.5">{task.tokens_used.toLocaleString()}</p>
          </div>
        )}
        {task.cost_cents != null && (
          <div className="border border-white/[0.08] rounded-lg p-3">
            <p className="text-xs text-neutral-400">Cost</p>
            <p className="text-sm font-medium mt-0.5">${(task.cost_cents / 100).toFixed(4)}</p>
          </div>
        )}
        {task.duration_seconds != null && (
          <div className="border border-white/[0.08] rounded-lg p-3">
            <p className="text-xs text-neutral-400">Duration</p>
            <p className="text-sm font-medium mt-0.5">{task.duration_seconds}s</p>
          </div>
        )}
      </div>

      {/* Error */}
      {task.error_message && (
        <div className="bg-critical/10 border border-critical/30 rounded-lg p-4 mb-6">
          <p className="text-sm text-critical">{task.error_message}</p>
        </div>
      )}

      {/* Output */}
      {task.output && (
        <CollapsibleSection title="Output">
          <div className="border border-white/[0.08] rounded-lg p-4">
            <pre className="text-sm whitespace-pre-wrap break-words">{typeof task.output === 'string' ? task.output : JSON.stringify(task.output, null, 2)}</pre>
          </div>
        </CollapsibleSection>
      )}

      {/* Deliverables */}
      {deliverables && deliverables.length > 0 && (
        <CollapsibleSection title="Deliverables">
          <div className="space-y-3">
            {deliverables.map(d => {
              const typeBadge: Record<string, string> = {
                email: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
                code: 'bg-green-500/15 text-green-400 border-green-500/30',
                report: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
                creative: 'bg-pink-500/15 text-pink-400 border-pink-500/30',
                plan: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
                data: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
              };
              const typeStyle = typeBadge[d.deliverable_type] || 'bg-white/5 text-neutral-400 border-white/10';

              let preview = '';
              try {
                const parsed = JSON.parse(d.content);
                preview = parsed.text || parsed.body || parsed.content || JSON.stringify(parsed, null, 2);
              } catch {
                preview = d.content;
              }

              return (
                <div key={d.id} className="border border-white/[0.08] rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-medium truncate flex-1">{d.title}</span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${typeStyle}`}>
                      {d.deliverable_type}
                    </span>
                    <StatusBadge status={d.status} />
                    {d.auto_created === 1 && (
                      <span className="text-[10px] text-neutral-500 bg-white/5 px-1.5 py-0.5 rounded">auto</span>
                    )}
                  </div>
                  <pre className="text-sm whitespace-pre-wrap break-words text-neutral-300">
                    {typeof preview === 'string' ? preview.slice(0, 2000) : preview}
                  </pre>
                  {d.rejection_reason && (
                    <p className="mt-2 text-sm text-red-400 bg-red-500/10 rounded p-2">{d.rejection_reason}</p>
                  )}
                </div>
              );
            })}
          </div>
        </CollapsibleSection>
      )}

      {/* Conversation */}
      {messages && messages.length > 0 && (
        <CollapsibleSection title="Conversation">
          <div className="space-y-2">
            {messages.map(msg => (
              <div
                key={msg.id}
                className={`rounded-lg p-3 text-sm ${
                  msg.role === 'user'
                    ? 'bg-white/5 border border-white/[0.12]'
                    : 'border border-white/[0.08]'
                }`}
              >
                <p className="text-xs text-neutral-400 mb-1 capitalize">{msg.role}</p>
                <MessageContent content={msg.content} />
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}
