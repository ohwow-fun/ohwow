import { ShieldCheck, CheckCircle, XCircle, Envelope, Lightning } from '@phosphor-icons/react';
import { useApi } from '../hooks/useApi';
import { useWsRefresh } from '../hooks/useWebSocket';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { RowSkeleton } from '../components/Skeleton';
import { api } from '../api/client';
import { useState, useCallback } from 'react';

/**
 * Lightweight markdown renderer — no external dep required.
 * Handles the subset agents commonly produce: headings, bold, code
 * fences, inline code, bullet lists, and plain paragraphs.
 */
function ApprovalBody({ text }: { text: string }) {
  const COLLAPSED_LINES = 12;
  const allLines = text.split('\n');
  const canCollapse = allLines.length > COLLAPSED_LINES;
  const [expanded, setExpanded] = useState(false);
  const lines = !canCollapse || expanded ? allLines : allLines.slice(0, COLLAPSED_LINES);
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code fence
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        <pre key={i} className="bg-white/[0.05] rounded px-3 py-2 text-[11px] text-neutral-300 overflow-x-auto my-1.5 whitespace-pre">
          {lang && <span className="text-neutral-500 text-[10px] block mb-1">{lang}</span>}
          {codeLines.join('\n')}
        </pre>
      );
      i++;
      continue;
    }

    // Headings
    const h3 = line.match(/^### (.+)/);
    const h2 = line.match(/^## (.+)/);
    const h1 = line.match(/^# (.+)/);
    if (h3) { elements.push(<p key={i} className="text-xs font-semibold text-white mt-2 mb-0.5">{h3[1]}</p>); i++; continue; }
    if (h2) { elements.push(<p key={i} className="text-xs font-semibold text-white mt-2 mb-0.5">{h2[1]}</p>); i++; continue; }
    if (h1) { elements.push(<p key={i} className="text-sm font-semibold text-white mt-2 mb-1">{h1[1]}</p>); i++; continue; }

    // Bullet list
    const bullet = line.match(/^[-*+] (.+)/);
    if (bullet) {
      elements.push(
        <div key={i} className="flex gap-1.5 text-xs text-neutral-300">
          <span className="text-neutral-500 mt-px">•</span>
          <span>{inlineFormat(bullet[1])}</span>
        </div>
      );
      i++; continue;
    }

    // Numbered list
    const numbered = line.match(/^(\d+)\. (.+)/);
    if (numbered) {
      elements.push(
        <div key={i} className="flex gap-1.5 text-xs text-neutral-300">
          <span className="text-neutral-500 shrink-0">{numbered[1]}.</span>
          <span>{inlineFormat(numbered[2])}</span>
        </div>
      );
      i++; continue;
    }

    // Empty line
    if (line.trim() === '') { elements.push(<div key={i} className="h-1" />); i++; continue; }

    // Normal paragraph
    elements.push(<p key={i} className="text-xs text-neutral-300 leading-relaxed">{inlineFormat(line)}</p>);
    i++;
  }

  return (
    <div className="mt-2 space-y-0.5">
      {elements}
      {canCollapse && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] text-neutral-400 hover:text-white transition-colors mt-1"
        >
          {expanded ? 'Show less' : `Show ${allLines.length - COLLAPSED_LINES} more lines`}
        </button>
      )}
    </div>
  );
}

function inlineFormat(text: string): React.ReactNode {
  // Split on **bold** and `code` spans
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={idx} className="text-white font-medium">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={idx} className="bg-white/10 px-1 rounded text-[10px] text-neutral-200">{part.slice(1, -1)}</code>;
    return part;
  });
}

interface DeferredAction {
  type: string;
  params: Record<string, unknown>;
  provider: string;
}

interface Approval {
  id: string;
  title: string;
  agent_id: string;
  output: string | null;
  deferred_action: string | DeferredAction | null;
  created_at: string;
}

function parseDeferredAction(raw: string | DeferredAction | null): DeferredAction | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as DeferredAction; } catch { return null; }
  }
  return raw;
}

export function ApprovalsPage() {
  const wsTick = useWsRefresh(['task:completed']);
  const { data: approvals, loading, refetch } = useApi<Approval[]>('/api/approvals', [wsTick]);
  const [acting, setActing] = useState<string | null>(null);
  const [bulkActing, setBulkActing] = useState(false);

  // Rejection reason modal state
  const [rejectTarget, setRejectTarget] = useState<Approval | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const handleApprove = useCallback(async (id: string) => {
    setActing(id);
    try {
      await api(`/api/approvals/${id}/approve`, { method: 'POST' });
      refetch();
    } catch {
      // Will handle with toast
    } finally {
      setActing(null);
    }
  }, [refetch]);

  const handleReject = useCallback(async () => {
    if (!rejectTarget) return;
    setActing(rejectTarget.id);
    try {
      await api(`/api/approvals/${rejectTarget.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: rejectReason.trim() || undefined }),
      });
      setRejectTarget(null);
      setRejectReason('');
      refetch();
    } catch {
      // Will handle with toast
    } finally {
      setActing(null);
    }
  }, [rejectTarget, rejectReason, refetch]);

  const handleBulkApprove = useCallback(async () => {
    if (!approvals?.length) return;
    setBulkActing(true);
    try {
      for (const item of approvals) {
        await api(`/api/approvals/${item.id}/approve`, { method: 'POST' });
      }
      refetch();
    } catch {
      // Will handle with toast
    } finally {
      setBulkActing(false);
    }
  }, [approvals, refetch]);

  const handleBulkReject = useCallback(async () => {
    if (!approvals?.length) return;
    setBulkActing(true);
    try {
      for (const item of approvals) {
        await api(`/api/approvals/${item.id}/reject`, { method: 'POST' });
      }
      refetch();
    } catch {
      // Will handle with toast
    } finally {
      setBulkActing(false);
    }
  }, [approvals, refetch]);

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Approvals"
        subtitle="Tasks waiting for your review"
        action={approvals?.length ? (
          <div className="flex gap-2">
            <button
              onClick={handleBulkReject}
              disabled={bulkActing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-critical border border-critical/30 rounded-lg hover:bg-critical/10 disabled:opacity-50 transition-colors"
            >
              <XCircle size={14} /> Reject all
            </button>
            <button
              onClick={handleBulkApprove}
              disabled={bulkActing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-success bg-success/10 border border-success/30 rounded-lg hover:bg-success/20 disabled:opacity-50 transition-colors"
            >
              <CheckCircle size={14} /> Approve all
            </button>
          </div>
        ) : undefined}
      />

      {loading ? (
        <RowSkeleton count={3} />
      ) : !approvals?.length ? (
        <EmptyState
          icon={<ShieldCheck size={32} />}
          title="All clear"
          description="No tasks waiting for approval right now."
        />
      ) : (
        <div className="space-y-3">
          {approvals.map(item => {
            const deferred = parseDeferredAction(item.deferred_action);
            return (
              <div key={item.id} className="border border-white/[0.08] rounded-lg p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{item.title}</p>
                      {deferred && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-warning/15 text-warning">
                          {deferred.provider === 'gmail' ? <Envelope size={12} /> : <Lightning size={12} />}
                          {deferred.type}
                          {deferred.params.to ? ` → ${deferred.params.to}` : ''}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-neutral-400 mt-0.5">{new Date(item.created_at).toLocaleString()}</p>
                    {item.output && (
                      <ApprovalBody text={typeof item.output === 'string' ? item.output.slice(0, 1200) : JSON.stringify(item.output).slice(0, 1200)} />
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => { setRejectTarget(item); setRejectReason(''); }}
                      disabled={acting === item.id || bulkActing}
                      className="px-3 py-1.5 text-xs text-critical border border-critical/30 rounded hover:bg-critical/10 transition-colors disabled:opacity-50"
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => handleApprove(item.id)}
                      disabled={acting === item.id || bulkActing}
                      className="px-4 py-1.5 text-xs font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors disabled:opacity-50"
                    >
                      Approve
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Rejection reason modal */}
      {rejectTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="border border-white/[0.08] rounded-lg p-5 w-full max-w-md">
            <h3 className="text-sm font-semibold mb-1">Reject task</h3>
            <p className="text-xs text-neutral-400 mb-4">&ldquo;{rejectTarget.title}&rdquo;</p>
            <label className="text-xs text-neutral-400 block mb-1">Reason (optional)</label>
            <textarea
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              placeholder="Why is this being rejected?"
              rows={3}
              autoFocus
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-critical/50 resize-none mb-4"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setRejectTarget(null)}
                className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleReject}
                disabled={acting === rejectTarget.id}
                className="px-3 py-1.5 text-xs text-critical bg-critical/10 border border-critical/30 rounded hover:bg-critical/20 disabled:opacity-50 transition-colors"
              >
                {acting === rejectTarget.id ? 'Rejecting...' : 'Reject'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
