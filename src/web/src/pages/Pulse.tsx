/**
 * Pulse — revenue-first evolution cockpit.
 *
 * The system's primary goal is to generate revenue. This view puts the
 * sales pipeline at the top and shows the autonomous loop's burn + findings
 * as context for *why* the pipeline moves. Everything renders from a single
 * /api/pulse call refreshed every 5s.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useApi } from '../hooks/useApi';

// ---- types --------------------------------------------------------------

interface VerdictCount { verdict: string; c: number }
interface ExpBurn { experiment_id: string; c: number; cost_cents: number }
interface ModelRow { model: string; calls: number; tokens: number; cost_cents: number }
interface LlmBucket { calls: number; tokens: number; cost_cents: number }
interface PatchRow {
  id: string;
  finding_id: string;
  commit_sha: string | null;
  outcome: string;
  tier: string | null;
  patch_mode: string | null;
  proposed_at: string;
  resolved_at: string | null;
}
interface FindingRow {
  id: string;
  experiment_id: string | null;
  subject: string | null;
  verdict: string;
  summary: string | null;
  created_at: string;
  category: string | null;
}
interface ReflexRow {
  metric: string;
  action_type: string;
  severity: number;
  outcome: string | null;
  created_at: string;
}
interface BusinessVitals {
  ts: string;
  mrr: number | null;
  arr: number | null;
  active_users: number | null;
  daily_cost_cents: number | null;
  runway_days: number | null;
  source: string;
}
interface ActivityRow {
  title: string;
  description: string | null;
  activity_type: string | null;
  created_at: string;
}

interface FunnelStage { total: number; h24: number }
interface RevenueByContact {
  contact_id: string | null;
  name: string | null;
  source: string | null;
  cents: number;
}
interface CrmMilestone {
  kind: string | null;
  title: string;
  description: string | null;
  ts: string;
  contact_name: string | null;
}

interface PulseData {
  generatedAt: string;
  uptimeMs: number;
  heartbeat: 'live' | 'slow' | 'idle';
  heartbeatAgeMs: number | null;
  lastLlmCallAt: string | null;
  lastFindingAt: string | null;
  llm: {
    m5: LlmBucket;
    h1: LlmBucket;
    h24: LlmBucket;
    topModels: ModelRow[];
    topExperiments: ExpBurn[];
  };
  findings: {
    activeTotal: number;
    activeByVerdict: VerdictCount[];
    topExperimentsLastHour: Array<{ experiment_id: string; c: number }>;
    rate5m: number;
    recent: FindingRow[];
  };
  patches: {
    byOutcome: Array<{ outcome: string; c: number }>;
    recent: PatchRow[];
  };
  business: {
    latestVitals: BusinessVitals | null;
    recentReflexes: ReflexRow[];
  };
  pipeline: {
    funnel: {
      leads: FunnelStage;
      qualified: FunnelStage;
      contacted: FunnelStage;
      reached: FunnelStage;
      demos: FunnelStage;
      trials: FunnelStage;
      paid: FunnelStage;
    };
    revenue: { h24: number; d7: number; d30: number; total: number };
    revenueByContact: RevenueByContact[];
    contactsBySource: Array<{ source: string; c: number }>;
    outbound: {
      postsLast24h: Array<{ source: string | null; c: number }>;
      postsAllTime: number;
      dmThreads: number;
      dmThreadsWithContact: number;
      dmMessages24h: Array<{ direction: string; c: number }>;
    };
    approvalsPending: number;
    crmMilestones: CrmMilestone[];
    unlinkedThreads: Array<{
      id: string;
      primary_name: string | null;
      last_preview: string | null;
      last_seen_at: string;
      conversation_pair: string;
      counterparty_user_id: string | null;
    }>;
    eventsByKind: Array<{ kind: string; c: number }>;
    efficiency: {
      totalBurnCents: number;
      costPerLeadCents: number;
      costPerQualifiedCents: number;
      costPerPaidCents: number;
    };
    dmHealth: {
      threadsTotal: number;
      threadsLinked: number;
      threadsUnlinked: number;
    };
    nextSteps: Array<{
      id: string;
      contactId: string;
      contactName: string | null;
      createdAt: string;
      stepType: string;
      urgency: string;
      status: string;
      text: string;
      suggestedAction: string;
      draftReply?: string;
      dispatchedKind?: string;
      findingId?: string;
      taskId?: string;
      approvalId?: string;
      shippedAt?: string;
      sendConfirmed?: boolean;
      realMessageId?: string;
      confirmedAt?: string;
    }>;
    nextStepsRollup: {
      open: number;
      dispatched: number;
      shipped: number;
      confirmed: number;
      unconfirmed: number;
      ignored: number;
    };
    replyQueue: {
      counts: {
        pending: number;
        approved: number;
        autoApplied: number;
        applied: number;
        rejected: number;
      };
      lastShippedAt: string | null;
      recent: Array<{
        approvalId: string;
        ts: string;
        status: string;
        summary: string;
        contactName: string | null;
        conversationPair: string | null;
        textPreview: string;
      }>;
    };
  };
  activity: ActivityRow[];
}

// ---- helpers ------------------------------------------------------------

function fmtK(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCents(c: number): string {
  if (c >= 100_000) return `$${(c / 100_000).toFixed(1)}K`;
  return `$${(c / 100).toFixed(c >= 1000 ? 0 : 2)}`;
}

function fmtAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '.';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function relTime(iso: string): string {
  const normalised = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)
    ? iso
    : iso.replace(' ', 'T') + 'Z';
  const then = new Date(normalised).getTime();
  if (!Number.isFinite(then)) return '.';
  return fmtAge(Date.now() - then);
}

function verdictColor(v: string): string {
  return v === 'pass' ? 'text-success'
    : v === 'warning' ? 'text-warning'
    : v === 'fail' ? 'text-critical'
    : v === 'error' ? 'text-critical'
    : 'text-neutral-400';
}

function verdictDot(v: string): string {
  return v === 'pass' ? 'bg-success'
    : v === 'warning' ? 'bg-warning'
    : v === 'fail' ? 'bg-critical'
    : v === 'error' ? 'bg-critical'
    : 'bg-neutral-500';
}

function prettyExperiment(id: string | null | undefined): string {
  if (!id) return 'unattributed';
  return id.replace(/-/g, ' ');
}

function prettySource(s: string | null | undefined): string {
  if (!s) return 'unsourced';
  return s.replace(/[-_]/g, ' ');
}

const MILESTONE_STYLE: Record<string, { color: string; label: string }> = {
  'x:qualified':   { color: 'bg-info',      label: 'qualified' },
  'x:reached':     { color: 'bg-sky-400',   label: 'reached' },
  'demo:booked':   { color: 'bg-violet-400',label: 'demo' },
  'trial:started': { color: 'bg-amber-400', label: 'trial' },
  'plan:paid':     { color: 'bg-success',   label: 'paid' },
};

// ---- heartbeat bar ------------------------------------------------------

function HeartbeatBar({ heartbeat, ageMs }: { heartbeat: PulseData['heartbeat']; ageMs: number | null }) {
  const color = heartbeat === 'live' ? 'bg-success' : heartbeat === 'slow' ? 'bg-warning' : 'bg-critical';
  const label = heartbeat === 'live' ? 'LOOP LIVE' : heartbeat === 'slow' ? 'LOOP SLOW' : 'LOOP IDLE';
  return (
    <div className="inline-flex items-center gap-2">
      <span className="relative inline-flex w-2.5 h-2.5">
        <motion.span
          className={`absolute inset-0 rounded-full ${color}`}
          animate={{ opacity: heartbeat === 'live' ? [1, 0.4, 1] : 1 }}
          transition={{ duration: 1.6, repeat: heartbeat === 'live' ? Infinity : 0 }}
        />
        {heartbeat === 'live' && (
          <span className={`absolute inset-0 rounded-full ${color} opacity-40 animate-ping`} />
        )}
      </span>
      <span className="text-[10px] uppercase tracking-widest text-neutral-400">{label}</span>
      <span className="text-[10px] text-neutral-600">· last call {fmtAge(ageMs)}</span>
    </div>
  );
}

// ---- tile ---------------------------------------------------------------

function Tile({
  label,
  value,
  sub,
  accent = 'text-white',
  hint,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
  hint?: string;
}) {
  return (
    <div className="border border-white/[0.08] rounded-lg p-4 bg-white/[0.01]">
      <div className="flex items-center gap-1.5">
        <p className="text-[10px] text-neutral-500 uppercase tracking-wider">{label}</p>
        {hint && (
          <span className="text-[10px] text-neutral-600" title={hint}>ⓘ</span>
        )}
      </div>
      <p className={`text-2xl font-semibold mt-1 tabular-nums ${accent}`}>{value}</p>
      {sub && <p className="text-[11px] text-neutral-500 mt-0.5">{sub}</p>}
    </div>
  );
}

// ---- funnel viz: the hero of revenue-first view -------------------------

interface FunnelRow { key: string; label: string; total: number; h24: number; color: string }

function Funnel({ funnel }: { funnel: PulseData['pipeline']['funnel'] }) {
  const rows: FunnelRow[] = [
    { key: 'leads',     label: 'CRM leads',       total: funnel.leads.total,      h24: funnel.leads.h24,      color: 'bg-neutral-400' },
    { key: 'qualified', label: 'Qualified',       total: funnel.qualified.total,  h24: funnel.qualified.h24,  color: 'bg-info' },
    { key: 'contacted', label: 'Contacted',       total: funnel.contacted.total,  h24: funnel.contacted.h24,  color: 'bg-teal-400' },
    { key: 'reached',   label: 'Engaged',         total: funnel.reached.total,    h24: funnel.reached.h24,    color: 'bg-sky-400' },
    { key: 'demos',     label: 'Demo booked',     total: funnel.demos.total,      h24: funnel.demos.h24,      color: 'bg-violet-400' },
    { key: 'trials',    label: 'Trial started',   total: funnel.trials.total,     h24: funnel.trials.h24,     color: 'bg-amber-400' },
    { key: 'paid',      label: 'Paid',            total: funnel.paid.total,       h24: funnel.paid.h24,       color: 'bg-success' },
  ];
  const max = Math.max(1, ...rows.map(r => r.total));

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-[11px] text-neutral-500 uppercase tracking-wider">Sales funnel</p>
          <p className="text-[10px] text-neutral-600 mt-0.5">
            Lead → Qualified → Contacted → Engaged → Demo → Trial → Paid · counts = all time · <span className="text-success">24h delta shown in green</span>
          </p>
        </div>
        <Link to="/contacts" className="text-xs text-neutral-400 hover:text-white transition-colors">Browse contacts →</Link>
      </div>
      <div className="space-y-1.5">
        {rows.map((r, i) => {
          const pct = (r.total / max) * 100;
          const prev = i === 0 ? null : rows[i - 1];
          const convert = prev && prev.total > 0 ? (r.total / prev.total) * 100 : null;
          return (
            <div key={r.key} className="flex items-center gap-3">
              <div className="w-28 text-xs text-neutral-400 truncate">{r.label}</div>
              <div className="flex-1 relative h-6 rounded bg-white/[0.03] overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{ duration: 0.5, ease: 'easeOut' }}
                  className={`h-full ${r.color} opacity-60`}
                />
                <div className="absolute inset-0 flex items-center px-2 text-xs tabular-nums">
                  <span className="text-white font-medium">{r.total}</span>
                  {r.h24 > 0 && (
                    <span className="text-success ml-2">+{r.h24} · 24h</span>
                  )}
                  {convert !== null && r.total > 0 && (
                    <span className="ml-auto text-[10px] text-neutral-400">
                      {convert.toFixed(0)}% from {prev?.label.toLowerCase()}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- horizontal stacked source share -----------------------------------

function SourceShare({ rows }: { rows: Array<{ source: string; c: number }> }) {
  const total = rows.reduce((a, b) => a + b.c, 0) || 1;
  const palette = ['bg-info', 'bg-success', 'bg-warning', 'bg-violet-400', 'bg-sky-400', 'bg-neutral-500'];
  return (
    <div>
      <div className="flex h-2 rounded-full overflow-hidden bg-white/[0.04]">
        {rows.map((r, i) => (
          <div key={r.source} style={{ width: `${(r.c / total) * 100}%` }} className={palette[i % palette.length]} title={`${r.source}: ${r.c}`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px]">
        {rows.map((r, i) => (
          <span key={r.source} className="text-neutral-300">
            <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle ${palette[i % palette.length]}`} />
            {prettySource(r.source)} <span className="text-neutral-500 ml-1">{r.c}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---- live stream --------------------------------------------------------

interface StreamItem {
  ts: string;
  kind: 'milestone' | 'finding' | 'patch' | 'reflex' | 'activity' | 'next_step';
  color: string;
  label: string;
  title: string;
  body: string;
}

function buildStream(data: PulseData): StreamItem[] {
  const items: StreamItem[] = [];

  // Next-step events: the analyst → dispatcher pipeline output.
  // Highest-signal stream entries — show them first with strong colors.
  for (const s of data.pipeline.nextSteps.slice(0, 6)) {
    const color = s.stepType === 'bug_report' ? 'bg-critical'
      : s.stepType === 'feature_request' ? 'bg-violet-400'
      : s.stepType === 'question' || s.stepType === 'follow_up' ? 'bg-info'
      : 'bg-neutral-500';
    const statusLabel = s.status === 'dispatched' && s.dispatchedKind
      ? `${s.status} → ${s.dispatchedKind}`
      : s.status;
    items.push({
      ts: s.createdAt,
      kind: 'next_step',
      color,
      label: `next_step · ${s.stepType.replace(/_/g, ' ')}`,
      title: `${s.contactName ?? 'contact'} · ${statusLabel}`,
      body: s.text,
    });
  }

  // Revenue milestones lead the stream.
  for (const m of data.pipeline.crmMilestones) {
    const style = MILESTONE_STYLE[m.kind ?? ''] ?? { color: 'bg-info', label: m.kind ?? 'event' };
    items.push({
      ts: m.ts,
      kind: 'milestone',
      color: style.color,
      label: style.label,
      title: m.contact_name ?? m.title,
      body: m.title,
    });
  }
  for (const f of data.findings.recent.slice(0, 8)) {
    items.push({
      ts: f.created_at,
      kind: 'finding',
      color: verdictDot(f.verdict),
      label: f.experiment_id ?? 'finding',
      title: f.subject ?? f.experiment_id ?? 'finding',
      body: f.summary ?? '',
    });
  }
  for (const p of data.patches.recent.slice(0, 5)) {
    items.push({
      ts: p.proposed_at,
      kind: 'patch',
      color: p.outcome === 'held' ? 'bg-success'
        : p.outcome === 'reverted' ? 'bg-critical'
        : 'bg-info',
      label: `patch · ${p.patch_mode ?? p.tier ?? ''}`.trim(),
      title: p.commit_sha ? p.commit_sha.substring(0, 8) : p.id.substring(0, 8),
      body: `${p.outcome} · finding ${p.finding_id.substring(0, 8)}`,
    });
  }
  for (const r of data.business.recentReflexes) {
    items.push({
      ts: r.created_at,
      kind: 'reflex',
      color: 'bg-orange-400',
      label: `reflex · ${r.metric}`,
      title: r.action_type,
      body: r.outcome ?? `severity ${r.severity.toFixed(2)}`,
    });
  }
  return items
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .slice(0, 20);
}

// ---- main component -----------------------------------------------------

export function PulsePage() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  const { data, loading, error } = useApi<PulseData>('/api/pulse', [tick]);

  const stream = useMemo(() => (data ? buildStream(data) : []), [data]);

  if (error) {
    return (
      <div className="p-6 max-w-6xl">
        <h1 className="text-2xl font-semibold mb-2">Pulse</h1>
        <div className="border border-critical/30 bg-critical/5 rounded-lg p-4 text-sm text-critical">
          Couldn't load pulse. {error}
        </div>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="p-6 max-w-6xl">
        <h1 className="text-2xl font-semibold mb-2">Pulse</h1>
        <p className="text-sm text-neutral-500">Warming up.</p>
      </div>
    );
  }

  if (!data) return null;

  const { pipeline } = data;
  const verdicts = data.findings.activeByVerdict;
  const patchHeld = data.patches.byOutcome.find(p => p.outcome === 'held')?.c ?? 0;
  const patchReverted = data.patches.byOutcome.find(p => p.outcome === 'reverted')?.c ?? 0;
  const patchPending = data.patches.byOutcome.find(p => p.outcome === 'pending')?.c ?? 0;
  const patchTotal = patchHeld + patchReverted + patchPending;

  const burn24h = data.llm.h24.cost_cents;
  const rev24h = pipeline.revenue.h24;
  const revVsBurn = burn24h > 0 ? rev24h / burn24h : 0;

  const dmInbound = pipeline.outbound.dmMessages24h.find(d => d.direction === 'inbound')?.c ?? 0;
  const dmOutbound = pipeline.outbound.dmMessages24h.find(d => d.direction === 'outbound')?.c ?? 0;

  return (
    <div className="p-6 max-w-6xl">
      {/* ====== Header ====== */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Pulse</h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            The system's goal is revenue. Every cycle below is measured against it.
          </p>
        </div>
        <HeartbeatBar heartbeat={data.heartbeat} ageMs={data.heartbeatAgeMs} />
      </div>

      {/* ====== Revenue hero ====== */}
      <div className="border border-success/20 bg-success/[0.03] rounded-lg p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <p className="text-[11px] text-success uppercase tracking-wider">Revenue · the north star</p>
          <Link to="/revenue" className="text-xs text-neutral-400 hover:text-white transition-colors">Ledger →</Link>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-[10px] text-neutral-500 uppercase tracking-wider">Last 24h</p>
            <p className="text-3xl font-semibold tabular-nums text-success mt-1">{fmtCents(pipeline.revenue.h24)}</p>
            <p className="text-[11px] text-neutral-500 mt-0.5">
              burn {fmtCents(burn24h)} · {revVsBurn > 0 ? `${revVsBurn.toFixed(2)}×` : '0×'} ratio
            </p>
          </div>
          <div>
            <p className="text-[10px] text-neutral-500 uppercase tracking-wider">7 days</p>
            <p className="text-2xl font-semibold tabular-nums mt-1">{fmtCents(pipeline.revenue.d7)}</p>
            <p className="text-[11px] text-neutral-500 mt-0.5">
              avg {fmtCents(Math.round(pipeline.revenue.d7 / 7))} / day
            </p>
          </div>
          <div>
            <p className="text-[10px] text-neutral-500 uppercase tracking-wider">30 days</p>
            <p className="text-2xl font-semibold tabular-nums mt-1">{fmtCents(pipeline.revenue.d30)}</p>
            <p className="text-[11px] text-neutral-500 mt-0.5">
              {pipeline.funnel.paid.total} paid contacts
            </p>
          </div>
          <div>
            <p className="text-[10px] text-neutral-500 uppercase tracking-wider">Lifetime</p>
            <p className="text-2xl font-semibold tabular-nums mt-1">{fmtCents(pipeline.revenue.total)}</p>
            <p className="text-[11px] text-neutral-500 mt-0.5">
              MRR {data.business.latestVitals?.mrr !== null && data.business.latestVitals?.mrr !== undefined
                ? `$${data.business.latestVitals.mrr.toLocaleString()}`
                : 'not set'}
            </p>
          </div>
        </div>
      </div>

      {/* ====== Funnel ====== */}
      <div className="border border-white/[0.08] rounded-lg p-5 mb-6 bg-white/[0.01]">
        <Funnel funnel={pipeline.funnel} />
      </div>

      {/* ====== Pipeline context: sources + outbound + approvals ====== */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="border border-white/[0.08] rounded-lg p-5 bg-white/[0.01]">
          <p className="text-[11px] text-neutral-500 uppercase tracking-wider mb-3">Where leads come from</p>
          {pipeline.contactsBySource.length === 0 ? (
            <p className="text-xs text-neutral-600">No contacts yet.</p>
          ) : (
            <SourceShare rows={pipeline.contactsBySource} />
          )}
        </div>

        <div className="border border-white/[0.08] rounded-lg p-5 bg-white/[0.01]">
          <p className="text-[11px] text-neutral-500 uppercase tracking-wider mb-3">Outbound dispatch · 24h</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-[10px] text-neutral-500 uppercase tracking-wider">X posts</p>
              <p className="text-xl font-semibold tabular-nums mt-1">
                {pipeline.outbound.postsLast24h.reduce((a, b) => a + b.c, 0)}
              </p>
              <p className="text-[11px] text-neutral-500 mt-0.5">{pipeline.outbound.postsAllTime} all time</p>
            </div>
            <div>
              <p className="text-[10px] text-neutral-500 uppercase tracking-wider">DM msgs</p>
              <p className="text-xl font-semibold tabular-nums mt-1">
                {dmInbound + dmOutbound}
              </p>
              <p className="text-[11px] text-neutral-500 mt-0.5">
                {dmInbound} in · {dmOutbound} out
              </p>
            </div>
            <div className="col-span-2">
              <p className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1">DM threads linked to CRM</p>
              <div className="h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
                <div
                  className="h-full bg-success/60"
                  style={{ width: `${pipeline.outbound.dmThreads > 0 ? (pipeline.outbound.dmThreadsWithContact / pipeline.outbound.dmThreads) * 100 : 0}%` }}
                />
              </div>
              <p className="text-[11px] text-neutral-500 mt-1">
                {pipeline.outbound.dmThreadsWithContact} of {pipeline.outbound.dmThreads} threads attributed
              </p>
            </div>
          </div>
        </div>

        <div className="border border-white/[0.08] rounded-lg p-5 bg-white/[0.01]">
          <div className="flex items-start justify-between mb-3">
            <p className="text-[11px] text-neutral-500 uppercase tracking-wider">Human-in-the-loop</p>
            <Link to="/approvals" className="text-[10px] text-neutral-400 hover:text-white transition-colors">Queue →</Link>
          </div>
          <p className={`text-3xl font-semibold tabular-nums ${pipeline.approvalsPending > 0 ? 'text-warning' : 'text-neutral-400'}`}>
            {pipeline.approvalsPending}
          </p>
          <p className="text-[11px] text-neutral-500 mt-1">
            tasks awaiting approval. The loop stalls on the slowest human.
          </p>
        </div>
      </div>

      {/* ====== Pipeline efficiency ====== */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Tile
          label="Cost per lead"
          value={fmtCents(pipeline.efficiency.costPerLeadCents)}
          sub={`${pipeline.funnel.leads.total} leads · ${fmtCents(pipeline.efficiency.totalBurnCents)} total burn`}
          hint="All-time LLM burn ÷ all-time CRM leads. The loop's cost of discovering one human."
        />
        <Tile
          label="Cost per qualified"
          value={pipeline.funnel.qualified.total > 0 ? fmtCents(pipeline.efficiency.costPerQualifiedCents) : '.'}
          sub={`${pipeline.funnel.qualified.total} qualified`}
          accent={pipeline.funnel.qualified.total > 0 ? 'text-info' : 'text-neutral-500'}
          hint="Cost to produce a buyer-intent-qualified lead."
        />
        <Tile
          label="Cost per paid"
          value={pipeline.funnel.paid.total > 0 ? fmtCents(pipeline.efficiency.costPerPaidCents) : '.'}
          sub={pipeline.funnel.paid.total > 0 ? `${pipeline.funnel.paid.total} paid` : 'no paid conversions yet'}
          accent={pipeline.funnel.paid.total > 0 ? 'text-success' : 'text-neutral-500'}
          hint="Total burn ÷ paid conversions. This is the number that has to shrink."
        />
        <Tile
          label="DM threads unlinked"
          value={pipeline.dmHealth.threadsUnlinked}
          sub={`${pipeline.dmHealth.threadsLinked} of ${pipeline.dmHealth.threadsTotal} linked to a contact`}
          accent={pipeline.dmHealth.threadsUnlinked > 0 ? 'text-warning' : 'text-success'}
          hint="Every unlinked DM thread is a lead the loop is talking to but can't route revenue events back to."
        />
      </div>

      {/* ====== Unlinked DM threads — actionable ====== */}
      {pipeline.unlinkedThreads.length > 0 && (
        <div className="border border-warning/20 bg-warning/[0.02] rounded-lg p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-[11px] text-warning uppercase tracking-wider">Unlinked DM threads · leak</p>
              <p className="text-[10px] text-neutral-500 mt-0.5">
                These conversations aren't bound to a CRM contact. Without a contact row, the funnel doesn't count them and revenue can't attribute.
              </p>
            </div>
          </div>
          <ul className="divide-y divide-white/[0.04]">
            {pipeline.unlinkedThreads.map(t => (
              <li key={t.id} className="flex items-start gap-3 py-2 text-xs">
                <span className="inline-block w-1.5 h-1.5 rounded-full mt-1.5 bg-warning flex-none" />
                <div className="flex-1 min-w-0">
                  <p className="text-neutral-200 truncate font-medium">
                    {t.primary_name ?? 'Unknown sender'}
                    {t.counterparty_user_id
                      ? <span className="text-[10px] text-neutral-500 ml-2">uid {t.counterparty_user_id}</span>
                      : <span className="text-[10px] text-critical ml-2">no user id</span>}
                  </p>
                  {t.last_preview && (
                    <p className="text-neutral-500 truncate mt-0.5">"{t.last_preview}"</p>
                  )}
                </div>
                <span className="text-[10px] text-neutral-600 flex-none tabular-nums">{relTime(t.last_seen_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ====== Next steps per contact ====== */}
      <div className="border border-info/20 bg-info/[0.03] rounded-lg p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-[11px] text-info uppercase tracking-wider">Next steps · conversation → loop</p>
            <p className="text-[10px] text-neutral-500 mt-0.5">
              The analyst reads each contact's DM thread (with screenshots via vision) and extracts
              actionable items. The dispatcher routes them — bugs → proposal findings, follow-ups/questions → approval tasks.
            </p>
          </div>
          <div className="flex items-center gap-3 text-[11px]">
            <span className="text-warning">open {pipeline.nextStepsRollup.open}</span>
            <span className="text-info">dispatched {pipeline.nextStepsRollup.dispatched}</span>
            <span className="text-success">shipped {pipeline.nextStepsRollup.shipped}</span>
            {pipeline.nextStepsRollup.confirmed > 0 && (
              <span className="text-success font-medium">· {pipeline.nextStepsRollup.confirmed} confirmed</span>
            )}
            {pipeline.nextStepsRollup.unconfirmed > 0 && (
              <span className="text-critical">unconfirmed {pipeline.nextStepsRollup.unconfirmed}</span>
            )}
            <span className="text-neutral-500">ignored {pipeline.nextStepsRollup.ignored}</span>
          </div>
        </div>
        {pipeline.nextSteps.length === 0 ? (
          <p className="text-xs text-neutral-600">No next-steps extracted yet. Waiting for the analyst's first tick.</p>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {pipeline.nextSteps.slice(0, 12).map(s => {
              const statusColor =
                s.sendConfirmed === true ? 'bg-success'
                : s.sendConfirmed === false ? 'bg-critical'
                : s.status === 'open' ? 'bg-warning'
                : s.status === 'dispatched' ? 'bg-info'
                : s.status === 'shipped' ? 'bg-success'
                : 'bg-neutral-600';
              const urgencyPrefix =
                s.urgency === 'high' ? '!' : s.urgency === 'medium' ? '·' : ' ';
              return (
                <li key={s.id} className="flex items-start gap-3 py-2.5 text-xs">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full mt-1.5 flex-none ${statusColor}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] uppercase tracking-wider text-neutral-500">
                        {urgencyPrefix} {s.stepType.replace(/_/g, ' ')}
                      </span>
                      {s.contactId ? (
                        <Link
                          to={`/contacts/${s.contactId}`}
                          className="text-neutral-300 font-medium truncate hover:text-white hover:underline"
                        >
                          {s.contactName ?? 'Unknown'}
                        </Link>
                      ) : (
                        <span className="text-neutral-300 font-medium truncate">{s.contactName ?? 'Unknown'}</span>
                      )}
                      <span className={`text-[10px] uppercase tracking-wider ${
                        s.status === 'open' ? 'text-warning'
                        : s.status === 'dispatched' ? 'text-info'
                        : s.status === 'shipped' ? 'text-success'
                        : 'text-neutral-500'
                      }`}>{s.status}</span>
                      {s.dispatchedKind && (
                        <span className="text-[10px] text-neutral-500">→ {s.dispatchedKind.replace(/_/g, ' ')}</span>
                      )}
                      {s.sendConfirmed === true && (
                        <span className="text-[10px] text-success uppercase tracking-wider font-medium" title={s.realMessageId}>
                          ✓ confirmed
                        </span>
                      )}
                      {s.sendConfirmed === false && (
                        <span className="text-[10px] text-critical uppercase tracking-wider font-medium">
                          ✗ never landed
                        </span>
                      )}
                    </div>
                    <p className="text-neutral-400 mt-0.5 line-clamp-2">{s.text}</p>
                    {s.draftReply ? (
                      <p className="text-neutral-300 mt-1 italic line-clamp-2 border-l-2 border-info/30 pl-2">
                        "{s.draftReply}"
                      </p>
                    ) : s.suggestedAction ? (
                      <p className="text-neutral-500 mt-0.5 italic line-clamp-1">
                        → {s.suggestedAction}
                      </p>
                    ) : null}
                  </div>
                  <span className="text-[10px] text-neutral-600 flex-none tabular-nums">{relTime(s.createdAt)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ====== DM reply queue ====== */}
      {(pipeline.replyQueue.counts.pending + pipeline.replyQueue.counts.approved
        + pipeline.replyQueue.counts.autoApplied + pipeline.replyQueue.counts.applied) > 0 && (
        <div className="border border-white/[0.08] rounded-lg p-5 mb-6 bg-white/[0.01]">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-[11px] text-neutral-500 uppercase tracking-wider">DM reply queue</p>
              <p className="text-[10px] text-neutral-600 mt-0.5">
                Dispatched next-steps land here as x_dm_outbound approvals.
                The reply dispatcher consumes approved rows and sends the DM via the authenticated browser.
              </p>
            </div>
            {pipeline.replyQueue.lastShippedAt && (
              <span className="text-[10px] text-success">last shipped {relTime(pipeline.replyQueue.lastShippedAt)}</span>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
            <div className="border border-warning/20 bg-warning/[0.04] rounded px-3 py-2">
              <p className="text-[10px] text-warning uppercase tracking-wider">Pending</p>
              <p className="text-lg font-semibold tabular-nums mt-0.5">{pipeline.replyQueue.counts.pending}</p>
            </div>
            <div className="border border-info/20 bg-info/[0.04] rounded px-3 py-2">
              <p className="text-[10px] text-info uppercase tracking-wider">Approved</p>
              <p className="text-lg font-semibold tabular-nums mt-0.5">{pipeline.replyQueue.counts.approved}</p>
            </div>
            <div className="border border-info/20 bg-info/[0.04] rounded px-3 py-2">
              <p className="text-[10px] text-info uppercase tracking-wider">Auto-applied</p>
              <p className="text-lg font-semibold tabular-nums mt-0.5">{pipeline.replyQueue.counts.autoApplied}</p>
            </div>
            <div className="border border-success/20 bg-success/[0.04] rounded px-3 py-2">
              <p className="text-[10px] text-success uppercase tracking-wider">Shipped</p>
              <p className="text-lg font-semibold tabular-nums mt-0.5">{pipeline.replyQueue.counts.applied}</p>
            </div>
            <div className="border border-critical/20 bg-critical/[0.04] rounded px-3 py-2">
              <p className="text-[10px] text-critical uppercase tracking-wider">Rejected</p>
              <p className="text-lg font-semibold tabular-nums mt-0.5">{pipeline.replyQueue.counts.rejected}</p>
            </div>
          </div>
          {pipeline.replyQueue.recent.length > 0 && (
            <ul className="divide-y divide-white/[0.04]">
              {pipeline.replyQueue.recent.map(r => {
                const color =
                  r.status === 'pending' ? 'bg-warning'
                  : r.status === 'approved' || r.status === 'auto_applied' ? 'bg-info'
                  : r.status === 'applied' ? 'bg-success'
                  : r.status === 'rejected' ? 'bg-critical'
                  : 'bg-neutral-500';
                const statusColor =
                  r.status === 'pending' ? 'text-warning'
                  : r.status === 'approved' || r.status === 'auto_applied' ? 'text-info'
                  : r.status === 'applied' ? 'text-success'
                  : r.status === 'rejected' ? 'text-critical'
                  : 'text-neutral-500';
                const rowInner = (
                  <>
                    <span className={`inline-block w-1.5 h-1.5 rounded-full mt-1.5 flex-none ${color}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] uppercase tracking-wider ${statusColor}`}>{r.status.replace('_', ' ')}</span>
                        <span className="text-neutral-300 truncate">{r.contactName ?? 'contact'}</span>
                      </div>
                      <p className="text-neutral-500 truncate mt-0.5">"{r.textPreview}"</p>
                    </div>
                    <span className="text-[10px] text-neutral-600 flex-none tabular-nums">{relTime(r.ts)}</span>
                  </>
                );
                return r.conversationPair ? (
                  <li key={r.approvalId} className="text-xs">
                    <Link
                      to={`/messages?pair=${encodeURIComponent(r.conversationPair)}`}
                      className="flex items-start gap-3 py-2 hover:bg-white/[0.02] -mx-2 px-2 rounded"
                    >
                      {rowInner}
                    </Link>
                  </li>
                ) : (
                  <li key={r.approvalId} className="flex items-start gap-3 py-2 text-xs">
                    {rowInner}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* ====== Contact event breakdown ====== */}
      {pipeline.eventsByKind.length > 0 && (
        <div className="border border-white/[0.08] rounded-lg p-5 mb-6 bg-white/[0.01]">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-[11px] text-neutral-500 uppercase tracking-wider">Contact events · last 30 days</p>
              <p className="text-[10px] text-neutral-600 mt-0.5">Every meaningful pipeline interaction, whether or not it maps to a funnel stage.</p>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {pipeline.eventsByKind.map(e => (
              <div key={e.kind} className="border border-white/[0.06] rounded px-3 py-2 bg-white/[0.01]">
                <p className="text-[10px] text-neutral-500 uppercase tracking-wider truncate">{e.kind}</p>
                <p className="text-lg font-semibold tabular-nums mt-0.5">{e.c}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ====== Top revenue contributors ====== */}
      {pipeline.revenueByContact.length > 0 && (
        <div className="border border-white/[0.08] rounded-lg p-5 mb-6 bg-white/[0.01]">
          <p className="text-[11px] text-neutral-500 uppercase tracking-wider mb-3">Top revenue contributors</p>
          <div className="divide-y divide-white/[0.04]">
            {pipeline.revenueByContact.map(c => (
              <Link
                key={c.contact_id ?? c.name ?? 'unknown'}
                to={c.contact_id ? `/contacts/${c.contact_id}` : '/contacts'}
                className="flex items-center justify-between py-2 text-sm hover:bg-white/[0.02] transition-colors px-2 -mx-2 rounded"
              >
                <span className="truncate">
                  <span className="text-neutral-200">{c.name ?? 'Unknown'}</span>
                  {c.source && <span className="text-[10px] text-neutral-500 ml-2 uppercase tracking-wider">{prettySource(c.source)}</span>}
                </span>
                <span className="tabular-nums text-success ml-4">{fmtCents(c.cents)}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ====== Loop burn context (collapsed from hero - still visible) ====== */}
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[11px] text-neutral-500 uppercase tracking-wider">
          Autonomous loop · the engine behind the funnel
        </p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Tile
          label="Loop Calls · 5m"
          value={fmtK(data.llm.m5.calls)}
          sub={`${fmtCents(data.llm.m5.cost_cents)} · ${fmtK(data.llm.m5.tokens)} tok`}
          hint="LLM calls the runtime made in the last 5 minutes"
        />
        <Tile
          label="Loop Calls · 1h"
          value={fmtK(data.llm.h1.calls)}
          sub={`${fmtCents(data.llm.h1.cost_cents)} · ${fmtK(data.llm.h1.tokens)} tok`}
          accent="text-info"
        />
        <Tile
          label="Findings · Active"
          value={fmtK(data.findings.activeTotal)}
          sub={`${fmtK(data.findings.rate5m)} new/5m`}
          hint="Self-bench experiments writing verdicts into the ledger"
        />
        <Tile
          label="Autonomous Patches"
          value={patchTotal}
          sub={`${patchHeld} held · ${patchReverted} reverted · ${patchPending} pending`}
          accent={patchTotal > 0 ? 'text-success' : 'text-neutral-400'}
          hint="Patches the loop authored against its own source. Layer 5 reverts bad ones."
        />
      </div>

      {/* ====== Verdict distribution ====== */}
      <div className="border border-white/[0.08] rounded-lg p-5 mb-6 bg-white/[0.01]">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-[11px] text-neutral-500 uppercase tracking-wider">Findings verdict distribution</p>
            <p className="text-[10px] text-neutral-600 mt-0.5">active, all-time · warnings dominate when the loop is proposing, pass dominates when it's validating</p>
          </div>
          <Link to="/activity" className="text-xs text-neutral-400 hover:text-white transition-colors">Browse →</Link>
        </div>
        <div className="flex h-2 rounded-full overflow-hidden bg-white/[0.04]">
          {['pass', 'warning', 'fail', 'error'].map(v => {
            const row = verdicts.find(c => c.verdict === v);
            if (!row) return null;
            const total = verdicts.reduce((a, b) => a + b.c, 0) || 1;
            return <div key={v} style={{ width: `${(row.c / total) * 100}%` }} className={verdictDot(v)} title={`${v}: ${row.c}`} />;
          })}
        </div>
        <div className="flex items-center gap-4 mt-2 text-[11px]">
          {verdicts.map(v => (
            <span key={v.verdict} className={verdictColor(v.verdict)}>
              <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle ${verdictDot(v.verdict)}`} />
              {v.verdict} {fmtK(v.c)}
            </span>
          ))}
        </div>
      </div>

      {/* ====== Burn attribution ====== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="border border-white/[0.08] rounded-lg p-5 bg-white/[0.01]">
          <p className="text-[11px] text-neutral-500 uppercase tracking-wider mb-1">Top models · last hour</p>
          <p className="text-[10px] text-neutral-600 mb-3">Where the LLM budget actually went.</p>
          {data.llm.topModels.length === 0 ? (
            <p className="text-xs text-neutral-600">No calls in the last hour.</p>
          ) : (
            <div className="space-y-2">
              {data.llm.topModels.map(m => {
                const max = Math.max(...data.llm.topModels.map(x => x.calls));
                const pct = (m.calls / max) * 100;
                return (
                  <div key={m.model}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="truncate mr-2 text-neutral-300">{m.model}</span>
                      <span className="text-neutral-500 tabular-nums">
                        {fmtK(m.calls)} · {fmtCents(m.cost_cents)}
                      </span>
                    </div>
                    <div className="h-1 rounded-full bg-white/[0.04] overflow-hidden">
                      <div className="h-full bg-info/60" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="border border-white/[0.08] rounded-lg p-5 bg-white/[0.01]">
          <p className="text-[11px] text-neutral-500 uppercase tracking-wider mb-1">Experiment burn · last hour</p>
          <p className="text-[10px] text-neutral-600 mb-3">Cost attributed per self-bench experiment. Unattributed = system calls.</p>
          {data.llm.topExperiments.length === 0 ? (
            <p className="text-xs text-neutral-600">No attributed experiment activity.</p>
          ) : (
            <div className="space-y-2">
              {data.llm.topExperiments.map(e => {
                const max = Math.max(...data.llm.topExperiments.map(x => x.cost_cents || x.c));
                const pct = ((e.cost_cents || e.c) / max) * 100;
                return (
                  <div key={e.experiment_id}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="truncate mr-2 text-neutral-300">{prettyExperiment(e.experiment_id)}</span>
                      <span className="text-neutral-500 tabular-nums">
                        {fmtK(e.c)} · {fmtCents(e.cost_cents)}
                      </span>
                    </div>
                    <div className="h-1 rounded-full bg-white/[0.04] overflow-hidden">
                      <div className="h-full bg-warning/60" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ====== Homeostasis reflexes ====== */}
      <div className="border border-white/[0.08] rounded-lg p-5 mb-6 bg-white/[0.01]">
        <p className="text-[11px] text-neutral-500 uppercase tracking-wider mb-1">Homeostasis reflexes</p>
        <p className="text-[10px] text-neutral-600 mb-3">
          The biological layer fires when revenue-vs-burn, bios, or load cross a threshold. Silence here means vitals are in range.
        </p>
        {data.business.recentReflexes.length === 0 ? (
          <p className="text-xs text-neutral-600">No reflexes fired recently.</p>
        ) : (
          <ul className="space-y-2">
            {data.business.recentReflexes.map((r, i) => (
              <li key={`${r.metric}-${r.created_at}-${i}`} className="flex items-start gap-3 text-xs">
                <span className="inline-block w-1.5 h-1.5 rounded-full mt-1.5 bg-orange-400" />
                <div className="flex-1 min-w-0">
                  <p className="text-neutral-200 truncate">
                    <span className="font-medium">{r.metric}</span>
                    <span className="text-neutral-500"> · {r.action_type}</span>
                  </p>
                  <p className="text-neutral-500 truncate">
                    {r.outcome ?? `severity ${r.severity.toFixed(2)}`} · {relTime(r.created_at)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ====== Live stream ====== */}
      <div className="border border-white/[0.08] rounded-lg bg-white/[0.01]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
          <div>
            <p className="text-[11px] text-neutral-500 uppercase tracking-wider">Live stream</p>
            <p className="text-[10px] text-neutral-600 mt-0.5">
              CRM milestones · findings · patches · reflexes. newest first
            </p>
          </div>
          <span className="text-[10px] text-neutral-600">auto-refresh · 5s</span>
        </div>
        <div className="divide-y divide-white/[0.04]">
          <AnimatePresence initial={false}>
            {stream.map((it, i) => (
              <motion.div
                key={`${it.kind}-${it.ts}-${i}`}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-start gap-3 px-5 py-2.5 text-xs hover:bg-white/[0.02] transition-colors"
              >
                <span className={`inline-block w-1.5 h-1.5 rounded-full mt-1.5 flex-none ${it.color}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-neutral-500 uppercase tracking-wider text-[10px]">{it.label}</span>
                    <span className="text-neutral-300 truncate">{it.title}</span>
                  </div>
                  {it.body && (
                    <p className="text-neutral-500 truncate mt-0.5">{it.body}</p>
                  )}
                </div>
                <span className="text-[10px] text-neutral-600 flex-none tabular-nums">{relTime(it.ts)}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
