import { useState, useMemo } from 'react';
import { PlugsConnected, Plus, MagnifyingGlass, Trash, ArrowClockwise, Eye, CircleNotch, ArrowsLeftRight, ArrowRight, ArrowLeft, Pulse } from '@phosphor-icons/react';
import { motion } from 'framer-motion';
import { useApi } from '../hooks/useApi';
import { StatusBadge } from '../components/StatusBadge';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { RowSkeleton } from '../components/Skeleton';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { TabSwitcher } from '../components/TabSwitcher';
import { MetricCard } from '../components/MetricCard';
import { FeatureIntro } from '../components/FeatureIntro';
import { api } from '../api/client';
import { toast } from '../components/Toast';

interface Connection {
  id: string;
  name: string;
  description: string | null;
  agent_card_url: string;
  endpoint_url: string;
  auth_type: string;
  trust_level: string;
  status: string;
  last_health_check_at: string | null;
  last_health_status: string | null;
  skills: string[] | null;
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

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'outbound', label: 'Outbound' },
  { id: 'activity', label: 'Activity' },
];

export function ConnectionsPage() {
  const [activeTab, setActiveTab] = useState('overview');
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [viewConnection, setViewConnection] = useState<Connection | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Connection | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { data: connections, loading, refetch } = useApi<Connection[]>('/api/a2a/connections');

  const filtered = useMemo(() => {
    if (!connections) return [];
    if (!search.trim()) return connections;
    const q = search.toLowerCase();
    return connections.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.endpoint_url.toLowerCase().includes(q)
    );
  }, [connections, search]);

  const stats = useMemo(() => {
    if (!connections) return { total: 0, active: 0, error: 0 };
    return {
      total: connections.length,
      active: connections.filter(c => c.status === 'active').length,
      error: connections.filter(c => c.status === 'error').length,
    };
  }, [connections]);

  const testConnection = async (id: string) => {
    setTesting(id);
    try {
      await api(`/api/a2a/connections/${id}/test`, { method: 'POST' });
      toast('success', 'Connection is healthy');
      refetch();
    } catch {
      toast('error', 'Connection test failed');
      refetch();
    } finally {
      setTesting(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`/api/a2a/connections/${deleteTarget.id}`, { method: 'DELETE' });
      toast('success', 'Connection deleted');
      refetch();
    } catch {
      toast('error', 'Couldn\'t delete connection');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const isEmpty = !loading && (!connections || connections.length === 0);

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Connections"
        subtitle="Agent-to-Agent protocol connections"
        action={
          <button
            onClick={() => { setShowForm(!showForm); setActiveTab('outbound'); }}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors"
          >
            <Plus size={14} /> New connection
          </button>
        }
      />

      <div className="mb-6">
        <TabSwitcher
          tabs={TABS}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          layoutId="connections-tab"
        />
      </div>

      {activeTab === 'overview' && (
        <OverviewTab
          stats={stats}
          connections={connections || []}
          loading={loading}
          isEmpty={isEmpty}
          onAddConnection={() => { setShowForm(true); setActiveTab('outbound'); }}
        />
      )}

      {activeTab === 'outbound' && (
        <OutboundTab
          connections={filtered}
          loading={loading}
          search={search}
          onSearchChange={setSearch}
          testing={testing}
          onTest={testConnection}
          onView={setViewConnection}
          onDelete={setDeleteTarget}
          showForm={showForm}
          onToggleForm={() => setShowForm(!showForm)}
          onFormSuccess={() => { refetch(); setShowForm(false); }}
        />
      )}

      {activeTab === 'activity' && (
        <ActivityTab connections={connections || []} loading={loading} />
      )}

      {/* Detail modal */}
      {viewConnection && (
        <ConnectionDetailModal
          connection={viewConnection}
          onClose={() => setViewConnection(null)}
          onTest={() => testConnection(viewConnection.id)}
          testing={testing === viewConnection.id}
        />
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete connection"
        message={`Delete "${deleteTarget?.name}"? This can't be undone.`}
        confirmLabel="Delete"
        loading={deleting}
      />
    </div>
  );
}

/* ─── Overview Tab ─── */

function OverviewTab({
  stats,
  connections,
  loading,
  isEmpty,
  onAddConnection,
}: {
  stats: { total: number; active: number; error: number };
  connections: Connection[];
  loading: boolean;
  isEmpty: boolean;
  onAddConnection: () => void;
}) {
  if (loading) return <RowSkeleton count={4} />;

  if (isEmpty) {
    return (
      <FeatureIntro
        icon={PlugsConnected}
        title="No connections yet"
        description="Connect to external A2A agents to delegate tasks and share capabilities."
        capabilities={[
          { icon: ArrowRight, label: 'Outbound calls', description: 'Delegate tasks to remote agents' },
          { icon: ArrowLeft, label: 'Inbound requests', description: 'Receive tasks from other workspaces' },
          { icon: ArrowsLeftRight, label: 'Bidirectional', description: 'Full two-way communication' },
          { icon: Pulse, label: 'Health monitoring', description: 'Track connection status' },
        ]}
        action={{ label: 'Add your first connection', onClick: onAddConnection }}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <MetricCard label="Connections" value={stats.total} />
        <MetricCard label="Active" value={stats.active} color="text-success" />
        <MetricCard label="Errors" value={stats.error} color={stats.error > 0 ? 'text-critical' : undefined} />
      </div>

      {/* Connection diagram */}
      <div className="border border-white/[0.08] bg-white/[0.02] rounded-lg p-6">
        <div className="flex items-center justify-center gap-8">
          {/* Outbound side */}
          <div className="text-center">
            <p className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2">Outbound</p>
            <div className="space-y-1.5">
              {connections.slice(0, 3).map(conn => (
                <div key={conn.id} className="flex items-center gap-2 text-xs">
                  <span className={`w-1.5 h-1.5 rounded-full ${conn.status === 'active' ? 'bg-success' : 'bg-warning'}`} />
                  <span className="text-neutral-300 truncate max-w-[120px]">{conn.name}</span>
                </div>
              ))}
              {connections.length > 3 && (
                <p className="text-[10px] text-neutral-500">+{connections.length - 3} more</p>
              )}
            </div>
          </div>

          {/* Center */}
          <div className="flex flex-col items-center">
            <ArrowsLeftRight size={20} className="text-neutral-500 mb-1" />
            <div className="w-12 h-12 rounded-full border border-white/10 bg-white/[0.04] flex items-center justify-center">
              <PlugsConnected size={20} className="text-white" />
            </div>
            <p className="text-[10px] text-neutral-500 mt-1">Your workspace</p>
          </div>

          {/* Placeholder right side */}
          <div className="text-center">
            <p className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2">Inbound</p>
            <p className="text-xs text-neutral-500">API keys not yet configured</p>
          </div>
        </div>
      </div>

      {/* Recent connections */}
      <div>
        <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-2">Recent connections</h3>
        <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
          {connections.slice(0, 5).map(conn => (
            <div key={conn.id} className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className={`w-2 h-2 rounded-full shrink-0 ${conn.status === 'active' ? 'bg-success' : conn.status === 'error' ? 'bg-critical' : 'bg-warning'}`} />
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{conn.name}</p>
                  <p className="text-xs text-neutral-500 truncate">{conn.endpoint_url}</p>
                </div>
              </div>
              <StatusBadge status={conn.status} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Outbound Tab ─── */

function OutboundTab({
  connections,
  loading,
  search,
  onSearchChange,
  testing,
  onTest,
  onView,
  onDelete,
  showForm,
  onToggleForm,
  onFormSuccess,
}: {
  connections: Connection[];
  loading: boolean;
  search: string;
  onSearchChange: (v: string) => void;
  testing: string | null;
  onTest: (id: string) => void;
  onView: (c: Connection) => void;
  onDelete: (c: Connection) => void;
  showForm: boolean;
  onToggleForm: () => void;
  onFormSuccess: () => void;
}) {
  return (
    <div>
      {/* Create form */}
      {showForm && (
        <div className="mb-4">
          <NewConnectionForm onClose={onToggleForm} onSuccess={onFormSuccess} />
        </div>
      )}

      {/* Search */}
      <div className="relative mb-4">
        <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
        <input
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          placeholder="Search connections..."
          className="w-full bg-white/5 border border-white/10 rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
        />
      </div>

      {loading ? (
        <RowSkeleton count={4} />
      ) : !connections.length ? (
        <EmptyState
          icon={<PlugsConnected size={32} />}
          title={search ? 'No matches' : 'No outbound connections'}
          description={search ? `Nothing matching "${search}".` : 'Add a connection to start delegating tasks.'}
        />
      ) : (
        <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
          {connections.map(conn => (
            <div key={conn.id} className="flex items-center justify-between px-4 py-3">
              <button
                className="min-w-0 mr-3 text-left flex-1"
                onClick={() => onView(conn)}
              >
                <p className="text-sm font-medium truncate hover:text-white transition-colors">{conn.name}</p>
                <p className="text-xs text-neutral-400 truncate">
                  <span className="text-white">{conn.endpoint_url}</span>
                  <span className="ml-2">· {conn.trust_level.replace(/_/g, ' ')}</span>
                  {conn.last_health_check_at && (
                    <span className="ml-2">· checked {timeAgo(conn.last_health_check_at)}</span>
                  )}
                </p>
                {conn.skills && conn.skills.length > 0 && (
                  <div className="flex gap-1 mt-1">
                    {conn.skills.slice(0, 3).map(skill => (
                      <span key={skill} className="text-[10px] bg-white/[0.06] px-1.5 py-0.5 rounded text-neutral-400">{skill}</span>
                    ))}
                    {conn.skills.length > 3 && (
                      <span className="text-[10px] text-neutral-400">+{conn.skills.length - 3}</span>
                    )}
                  </div>
                )}
              </button>
              <div className="flex items-center gap-2 shrink-0">
                <StatusBadge status={conn.status} />
                <button onClick={() => onView(conn)} className="text-neutral-400 hover:text-white transition-colors" title="Details">
                  <Eye size={14} />
                </button>
                <button
                  onClick={() => onTest(conn.id)}
                  disabled={testing === conn.id}
                  className="text-neutral-400 hover:text-white transition-colors disabled:opacity-50"
                  title="Test connection"
                >
                  <ArrowClockwise size={14} className={testing === conn.id ? 'animate-spin' : ''} />
                </button>
                <button onClick={() => onDelete(conn)} className="text-neutral-400 hover:text-critical transition-colors" title="Delete">
                  <Trash size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Activity Tab ─── */

function ActivityTab({ connections, loading }: { connections: Connection[]; loading: boolean }) {
  if (loading) return <RowSkeleton count={4} />;

  const recentChecks = connections
    .filter(c => c.last_health_check_at)
    .sort((a, b) => new Date(b.last_health_check_at!).getTime() - new Date(a.last_health_check_at!).getTime());

  if (!recentChecks.length) {
    return (
      <EmptyState
        icon={<Pulse size={32} />}
        title="No activity yet"
        description="Health checks and task delegations will appear here."
      />
    );
  }

  return (
    <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
      {recentChecks.map(conn => (
        <div key={conn.id} className="flex items-center justify-between px-4 py-3">
          <div className="min-w-0 mr-3">
            <p className="text-sm font-medium truncate">{conn.name}</p>
            <p className="text-xs text-neutral-400">
              Health check · {conn.last_health_status || 'unknown'}
              <span className="ml-2">· {timeAgo(conn.last_health_check_at!)}</span>
            </p>
          </div>
          <StatusBadge status={conn.last_health_status === 'healthy' ? 'active' : 'error'} />
        </div>
      ))}
    </div>
  );
}

/* ─── New Connection Form ─── */

function NewConnectionForm({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [name, setName] = useState('');
  const [agentCardUrl, setAgentCardUrl] = useState('');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [trustLevel, setTrustLevel] = useState('read_only');
  const [authType, setAuthType] = useState('none');
  const [credential, setCredential] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [discovering, setDiscovering] = useState(false);

  const handleDiscover = async () => {
    if (!agentCardUrl.trim()) return;
    setDiscovering(true);
    try {
      const res = await fetch(agentCardUrl.trim());
      if (res.ok) {
        const card = await res.json();
        if (card.name && !name) setName(card.name);
        if (card.url && !endpointUrl) setEndpointUrl(card.url);
        toast('success', 'Agent card loaded');
      }
    } catch {
      toast('error', 'Couldn\'t fetch agent card');
    } finally {
      setDiscovering(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !agentCardUrl.trim() || !endpointUrl.trim()) return;
    setSubmitting(true);
    try {
      await api('/api/a2a/connections', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          agent_card_url: agentCardUrl.trim(),
          endpoint_url: endpointUrl.trim(),
          trust_level: trustLevel,
          auth_type: authType,
          ...(authType !== 'none' && credential.trim() ? { credential: credential.trim() } : {}),
        }),
      });
      toast('success', 'Connection created');
      onSuccess();
    } catch {
      toast('error', 'Couldn\'t create connection');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      className="overflow-hidden"
    >
      <form onSubmit={handleSubmit} className="border border-white/[0.08] bg-white/[0.02] rounded-lg p-4 space-y-3">
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Agent card URL</label>
          <div className="flex gap-2">
            <input
              value={agentCardUrl}
              onChange={e => setAgentCardUrl(e.target.value)}
              placeholder="https://agent.example.com/.well-known/agent-card.json"
              className="flex-1 bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
            />
            <button
              type="button"
              onClick={handleDiscover}
              disabled={discovering || !agentCardUrl.trim()}
              className="px-3 py-2 text-xs bg-white/5 border border-white/10 text-white rounded-md hover:bg-white/10 transition-colors disabled:opacity-50 shrink-0"
            >
              {discovering ? <CircleNotch size={14} className="animate-spin" /> : 'Discover'}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Connection name"
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
            />
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Trust level</label>
            <select
              value={trustLevel}
              onChange={e => setTrustLevel(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20"
            >
              <option value="read_only">Read only</option>
              <option value="execute">Execute</option>
              <option value="autonomous">Autonomous</option>
            </select>
          </div>
        </div>
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Endpoint URL</label>
          <input
            value={endpointUrl}
            onChange={e => setEndpointUrl(e.target.value)}
            placeholder="https://agent.example.com/a2a"
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Auth type</label>
            <select
              value={authType}
              onChange={e => setAuthType(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20"
            >
              <option value="none">None</option>
              <option value="bearer_token">Bearer token</option>
              <option value="api_key">API key</option>
            </select>
          </div>
          {authType !== 'none' && (
            <div>
              <label className="text-xs text-neutral-400 block mb-1">
                {authType === 'bearer_token' ? 'Token' : 'API Key'}
              </label>
              <input
                type="password"
                value={credential}
                onChange={e => setCredential(e.target.value)}
                placeholder={authType === 'bearer_token' ? 'Bearer token' : 'API key value'}
                className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
              />
            </div>
          )}
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors">Cancel</button>
          <button
            type="submit"
            disabled={submitting || !name.trim() || !agentCardUrl.trim() || !endpointUrl.trim()}
            className="px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Creating...' : 'Create connection'}
          </button>
        </div>
      </form>
    </motion.div>
  );
}

/* ─── Connection Detail Modal ─── */

function ConnectionDetailModal({
  connection,
  onClose,
  onTest,
  testing,
}: {
  connection: Connection;
  onClose: () => void;
  onTest: () => void;
  testing: boolean;
}) {
  return (
    <Modal open onClose={onClose} title="Connection details" maxWidth="max-w-lg">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold">{connection.name}</h4>
            {connection.description && <p className="text-xs text-neutral-400 mt-0.5">{connection.description}</p>}
          </div>
          <StatusBadge status={connection.status} />
        </div>

        <div className="bg-white/5 rounded-lg p-3 space-y-2 text-sm">
          <DetailRow label="Endpoint" value={connection.endpoint_url} />
          <DetailRow label="Agent card" value={connection.agent_card_url} />
          <DetailRow label="Trust level" value={connection.trust_level.replace(/_/g, ' ')} />
          <DetailRow label="Auth type" value={connection.auth_type === 'none' ? 'None' : connection.auth_type.replace(/_/g, ' ')} />
          {connection.last_health_check_at && (
            <DetailRow label="Last health check" value={`${timeAgo(connection.last_health_check_at)} (${connection.last_health_status || 'unknown'})`} />
          )}
          <DetailRow label="Created" value={new Date(connection.created_at).toLocaleDateString()} />
        </div>

        {connection.skills && connection.skills.length > 0 && (
          <div>
            <label className="text-xs text-neutral-400 block mb-1.5">Skills</label>
            <div className="flex gap-1.5 flex-wrap">
              {connection.skills.map(skill => (
                <span key={skill} className="text-xs bg-white/5 border border-white/10 px-2 py-1 rounded">{skill}</span>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <button
            onClick={onTest}
            disabled={testing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white/5 border border-white/10 text-white rounded-md hover:bg-white/10 disabled:opacity-50 transition-colors"
          >
            {testing ? (
              <><CircleNotch size={14} className="animate-spin" /> Testing...</>
            ) : (
              <><ArrowClockwise size={14} /> Test connection</>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-neutral-400 shrink-0">{label}</span>
      <span className="font-medium text-right break-all">{value}</span>
    </div>
  );
}
