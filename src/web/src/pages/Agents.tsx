import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Robot, Plus } from '@phosphor-icons/react';
import { motion } from 'framer-motion';
import { useApi } from '../hooks/useApi';
import { useWsRefresh } from '../hooks/useWebSocket';
import { api } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { RowSkeleton } from '../components/Skeleton';

interface Agent {
  id: string;
  name: string;
  role: string;
  description: string | null;
  status: string;
  stats: { total_tasks?: number; tokens_used?: number; cost_cents?: number } | string;
}

function parseStats(stats: Agent['stats']) {
  if (typeof stats === 'string') {
    try { return JSON.parse(stats); } catch { return {}; }
  }
  return stats || {};
}

const stagger = {
  animate: { transition: { staggerChildren: 0.04 } },
};

const fadeIn = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
};

export function AgentsPage() {
  const wsTick = useWsRefresh(['task:started', 'task:completed']);
  const { data: agents, loading, refetch } = useApi<Agent[]>('/api/agents', [wsTick]);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="p-6 max-w-5xl">
      <PageHeader
        title="Agents"
        subtitle="Your AI team"
        action={
          !loading ? (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors"
            >
              <Plus size={14} weight="bold" />
              Create agent
            </button>
          ) : null
        }
      />

      {loading ? (
        <RowSkeleton count={4} />
      ) : !agents?.length ? (
        <EmptyState
          icon={<Robot size={32} />}
          title="No agents yet"
          description="Create your first agent to get started."
          action={
            <button
              onClick={() => setShowCreate(true)}
              className="px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors"
            >
              Create agent
            </button>
          }
        />
      ) : (
        <motion.div
          className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3"
          variants={stagger}
          initial="initial"
          animate="animate"
        >
          {agents.map(agent => {
            const stats = parseStats(agent.stats);
            return (
              <motion.div key={agent.id} variants={fadeIn}>
                <Link
                  to={`/agents/${agent.id}`}
                  className="block border border-white/[0.08] rounded-lg p-4 hover:bg-white/[0.02] transition-colors h-full"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center text-sm font-bold">
                      {agent.name[0]?.toUpperCase()}
                    </div>
                    <StatusBadge status={agent.status} />
                  </div>
                  <p className="text-sm font-medium truncate">{agent.name}</p>
                  <p className="text-xs text-neutral-500 truncate mt-0.5">{agent.role}</p>
                  <p className="text-xs text-neutral-600 mt-2">
                    {stats.total_tasks || 0} {stats.total_tasks === 1 ? 'task' : 'tasks'}
                  </p>
                </Link>
              </motion.div>
            );
          })}
        </motion.div>
      )}

      <CreateAgentModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={() => { setShowCreate(false); refetch(); }}
      />
    </div>
  );
}

function CreateAgentModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !role.trim() || !systemPrompt.trim()) {
      setError('Name, role, and system prompt are required.');
      return;
    }

    setSaving(true);
    setError('');

    try {
      await api('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          role: role.trim(),
          system_prompt: systemPrompt.trim(),
          description: description.trim() || null,
        }),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again?');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Create agent">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs text-neutral-500 mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Scout"
            className="w-full px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-md focus:outline-none focus:border-white/20"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-xs text-neutral-500 mb-1">Role</label>
          <input
            type="text"
            value={role}
            onChange={e => setRole(e.target.value)}
            placeholder="e.g. Sales Development"
            className="w-full px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-md focus:outline-none focus:border-white/20"
          />
        </div>

        <div>
          <label className="block text-xs text-neutral-500 mb-1">System Prompt</label>
          <textarea
            value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
            placeholder="Describe what this agent does and how it should behave..."
            rows={4}
            className="w-full px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-md focus:outline-none focus:border-white/20 resize-none"
          />
        </div>

        <div>
          <label className="block text-xs text-neutral-500 mb-1">Description (optional)</label>
          <input
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Short description for the agent list"
            className="w-full px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-md focus:outline-none focus:border-white/20"
          />
        </div>

        {error && <p className="text-xs text-critical">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-neutral-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Creating...' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
