import { useState, useMemo } from 'react';
import { Users, Plus, Trash, ArrowClockwise, Eye, CircleNotch, MagnifyingGlass, ShareNetwork, WifiHigh, ArrowsLeftRight } from '@phosphor-icons/react';
import { useApi } from '../hooks/useApi';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { RowSkeleton } from '../components/Skeleton';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FeatureIntro } from '../components/FeatureIntro';
import { MetricCard } from '../components/MetricCard';
import { api } from '../api/client';
import { toast } from '../components/Toast';

interface Peer {
  id: string;
  name: string;
  base_url: string;
  status: string;
  capabilities: string | null;
  last_seen: string | null;
  created_at: string;
}

interface PeerAgent {
  id: string;
  name: string;
  role: string;
  status: string;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function PeersPage() {
  const { data: peers, loading, refetch } = useApi<Peer[]>('/api/peers');
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [viewPeer, setViewPeer] = useState<Peer | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Peer | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [peerAgents, setPeerAgents] = useState<PeerAgent[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);

  const filtered = useMemo(() => {
    if (!peers) return [];
    if (!search.trim()) return peers;
    const q = search.toLowerCase();
    return peers.filter(p => p.name.toLowerCase().includes(q) || p.base_url.toLowerCase().includes(q));
  }, [peers, search]);

  const stats = useMemo(() => {
    if (!peers) return { total: 0, online: 0 };
    return {
      total: peers.length,
      online: peers.filter(p => p.status === 'active' || p.status === 'online').length,
    };
  }, [peers]);

  const testPeer = async (id: string) => {
    setTesting(id);
    try {
      await api(`/api/peers/${id}/test`, { method: 'POST' });
      toast('success', 'Peer is reachable');
      refetch();
    } catch {
      toast('error', 'Peer unreachable');
      refetch();
    } finally {
      setTesting(null);
    }
  };

  const viewPeerAgents = async (peer: Peer) => {
    setViewPeer(peer);
    setLoadingAgents(true);
    try {
      const res = await api<{ data: PeerAgent[] }>(`/api/peers/${peer.id}/agents`);
      setPeerAgents(res.data || []);
    } catch {
      setPeerAgents([]);
    } finally {
      setLoadingAgents(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`/api/peers/${deleteTarget.id}`, { method: 'DELETE' });
      toast('success', 'Peer removed');
      refetch();
    } catch {
      toast('error', 'Couldn\'t remove peer');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const isEmpty = !loading && (!peers || peers.length === 0);

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Peers"
        subtitle="Workspace-to-workspace connections"
        action={
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors"
          >
            <Plus size={14} /> Add peer
          </button>
        }
      />

      {loading ? (
        <RowSkeleton count={3} />
      ) : isEmpty ? (
        <FeatureIntro
          icon={ShareNetwork}
          title="No peer connections"
          description="Connect to other ohwow workspaces to delegate tasks across devices."
          capabilities={[
            { icon: ShareNetwork, label: 'Task delegation', description: 'Send tasks to remote agents' },
            { icon: Users, label: 'Agent discovery', description: 'Browse remote agent capabilities' },
            { icon: WifiHigh, label: 'Health checks', description: 'Monitor peer connectivity' },
            { icon: ArrowsLeftRight, label: 'Bidirectional', description: 'Two-way communication' },
          ]}
          action={{ label: 'Add your first peer', onClick: () => setShowForm(true) }}
        />
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <MetricCard label="Total peers" value={stats.total} />
            <MetricCard label="Online" value={stats.online} color="text-success" />
          </div>

          {/* Search */}
          <div className="relative mb-4">
            <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search peers..."
              className="w-full bg-white/5 border border-white/10 rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
            />
          </div>

          {/* Peer list */}
          <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
            {filtered.map(peer => (
              <div key={peer.id} className="flex items-center justify-between px-4 py-3">
                <button
                  className="min-w-0 mr-3 text-left flex-1"
                  onClick={() => viewPeerAgents(peer)}
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${peer.status === 'active' || peer.status === 'online' ? 'bg-success' : 'bg-neutral-500'}`} />
                    <p className="text-sm font-medium truncate">{peer.name}</p>
                  </div>
                  <p className="text-xs text-neutral-400 ml-4">
                    {peer.base_url}
                    {peer.last_seen && <span className="ml-2">· seen {timeAgo(peer.last_seen)}</span>}
                  </p>
                </button>
                <div className="flex items-center gap-2 shrink-0">
                  <StatusBadge status={peer.status} />
                  <button onClick={() => viewPeerAgents(peer)} className="text-neutral-400 hover:text-white transition-colors">
                    <Eye size={14} />
                  </button>
                  <button
                    onClick={() => testPeer(peer.id)}
                    disabled={testing === peer.id}
                    className="text-neutral-400 hover:text-white transition-colors disabled:opacity-50"
                  >
                    <ArrowClockwise size={14} className={testing === peer.id ? 'animate-spin' : ''} />
                  </button>
                  <button onClick={() => setDeleteTarget(peer)} className="text-neutral-400 hover:text-critical transition-colors">
                    <Trash size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Create form */}
      {showForm && (
        <PeerForm onClose={() => setShowForm(false)} onSuccess={() => { refetch(); setShowForm(false); }} />
      )}

      {/* Detail modal with agents */}
      {viewPeer && (
        <Modal open onClose={() => { setViewPeer(null); setPeerAgents([]); }} title={`Peer: ${viewPeer.name}`} maxWidth="max-w-lg">
          <div className="space-y-4">
            <div className="bg-white/5 rounded-lg p-3 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-neutral-400">URL</span><span className="font-medium break-all">{viewPeer.base_url}</span></div>
              <div className="flex justify-between"><span className="text-neutral-400">Status</span><StatusBadge status={viewPeer.status} /></div>
              {viewPeer.last_seen && <div className="flex justify-between"><span className="text-neutral-400">Last seen</span><span className="font-medium">{timeAgo(viewPeer.last_seen)}</span></div>}
            </div>
            <div>
              <h4 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-2">Remote agents</h4>
              {loadingAgents ? (
                <RowSkeleton count={2} />
              ) : peerAgents.length === 0 ? (
                <p className="text-xs text-neutral-500">No agents found or peer is unreachable.</p>
              ) : (
                <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
                  {peerAgents.map(agent => (
                    <div key={agent.id} className="flex items-center justify-between px-3 py-2">
                      <div>
                        <p className="text-sm font-medium">{agent.name}</p>
                        <p className="text-xs text-neutral-500">{agent.role}</p>
                      </div>
                      <StatusBadge status={agent.status} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Remove peer"
        message={`Remove "${deleteTarget?.name}"? You can re-add it later.`}
        confirmLabel="Remove"
        loading={deleting}
      />
    </div>
  );
}

function PeerForm({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !baseUrl.trim()) return;
    setSubmitting(true);
    try {
      await api('/api/peers', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          base_url: baseUrl.trim(),
          token: token.trim() || undefined,
        }),
      });
      toast('success', 'Peer added');
      onSuccess();
    } catch {
      toast('error', 'Couldn\'t add peer');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Add peer" maxWidth="max-w-md">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="My other device"
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20" autoFocus />
        </div>
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Base URL</label>
          <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="http://192.168.1.100:7700"
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20" />
        </div>
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Token (optional)</label>
          <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Peer auth token"
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20" />
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors">Cancel</button>
          <button type="submit" disabled={submitting || !name.trim() || !baseUrl.trim()}
            className="px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors">
            {submitting ? 'Adding...' : 'Add peer'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
