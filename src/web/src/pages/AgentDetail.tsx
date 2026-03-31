import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Pause, Play, ListChecks, Gear, CheckCircle, XCircle, Pulse, CircleNotch } from '@phosphor-icons/react';
import { Toggle } from '../components/Toggle';
import { TabSwitcher } from '../components/TabSwitcher';
import { McpServersSection } from './agent/McpServersSection';
import type { McpServerConfig } from './agent/McpServersSection';
import { useApi } from '../hooks/useApi';
import { useWsRefresh } from '../hooks/useWebSocket';
import { api } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { MetricCard } from '../components/MetricCard';
import { RowSkeleton } from '../components/Skeleton';

interface Agent {
  id: string;
  name: string;
  role: string;
  description: string | null;
  status: string;
  stats: Record<string, unknown> | string;
  config: Record<string, unknown> | string | null;
  system_prompt: string | null;
  voice_profile_id: string | null;
  created_at: string;
}

interface Memory {
  id: string;
  content: string;
  memory_type: string;
  created_at: string;
}

interface AgentTask {
  id: string;
  title: string;
  status: string;
  tokens_used: number | null;
  cost_cents: number | null;
  duration_seconds: number | null;
  priority: string | null;
  created_at: string;
}

interface ActivityEntry {
  id: string;
  activity_type: string;
  title: string;
  description: string | null;
  agent_id: string | null;
  created_at: string;
}

interface VoiceProfile {
  id: string;
  name: string;
  language?: string;
}

interface ConfigField {
  key: string;
  label: string;
  value: string;
}

function getTimeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'activity', label: 'Activity' },
  { id: 'performance', label: 'Performance' },
  { id: 'config', label: 'Config' },
];

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const wsTick = useWsRefresh(['task:started', 'task:completed', 'task:failed']);
  const { data: agent, loading, refetch } = useApi<Agent>(id ? `/api/agents/${id}` : null, [wsTick]);
  const { data: memories } = useApi<Memory[]>(id ? `/api/agents/${id}/memory` : null);
  const { data: tasks } = useApi<AgentTask[]>(id ? `/api/tasks?agentId=${id}&limit=50` : null, [wsTick]);
  const { data: allActivity } = useApi<ActivityEntry[]>('/api/activity', [wsTick]);

  const agentActivity = useMemo(() => {
    if (!allActivity || !id) return [];
    return allActivity.filter(a => a.agent_id === id);
  }, [allActivity, id]);

  const performanceMetrics = useMemo(() => {
    if (!tasks?.length) return null;
    const completed = tasks.filter(t => t.status === 'completed').length;
    const failed = tasks.filter(t => t.status === 'failed').length;
    const successRate = completed + failed > 0 ? completed / (completed + failed) : 0;
    const durations = tasks.filter(t => t.duration_seconds != null).map(t => t.duration_seconds as number);
    const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const totalTokens = tasks.reduce((sum, t) => sum + (t.tokens_used || 0), 0);
    const totalCostCents = tasks.reduce((sum, t) => sum + (t.cost_cents || 0), 0);
    const avgTokens = tasks.length > 0 ? Math.round(totalTokens / tasks.length) : 0;
    return { completed, failed, successRate, avgDuration, totalTokens, totalCostCents, avgTokens };
  }, [tasks]);

  const [tab, setTab] = useState('overview');

  // Voice profile state
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [saving, setSaving] = useState(false);

  // Config editing state
  const [editing, setEditing] = useState(false);
  const [editFields, setEditFields] = useState<ConfigField[]>([]);
  const [savingConfig, setSavingConfig] = useState(false);

  // MCP state
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [savingMcp, setSavingMcp] = useState(false);

  useEffect(() => {
    api<{ status: string }>('/api/voice/health')
      .then(() => {
        setVoiceAvailable(true);
        return api<{ data: VoiceProfile[] }>('/api/voice/profiles');
      })
      .then(res => setProfiles(res.data || []))
      .catch(() => setVoiceAvailable(false));
  }, []);

  const config = useMemo(() => {
    if (!agent) return {};
    return typeof agent.config === 'string' ? JSON.parse(agent.config) : (agent.config || {});
  }, [agent]);

  const stats = useMemo(() => {
    if (!agent) return {};
    return typeof agent.stats === 'string' ? JSON.parse(agent.stats) : (agent.stats || {});
  }, [agent]);

  useEffect(() => {
    setMcpEnabled(config.mcp_enabled === true);
    setMcpServers(Array.isArray(config.mcp_servers) ? (config.mcp_servers as McpServerConfig[]) : []);
  }, [config]);

  const deviceAccessEnabled = config.local_files_enabled === true && config.bash_enabled === true;

  // File access paths state
  const [filePaths, setFilePaths] = useState<Array<{id: string; path: string}>>([]);
  const [newPath, setNewPath] = useState('');
  const [pathError, setPathError] = useState('');

  useEffect(() => {
    if (!id) return;
    api<{ data: Array<{id: string; path: string}> }>(`/api/agents/${id}/file-access`)
      .then(res => setFilePaths(res.data || []))
      .catch(() => {});
  }, [id, config]);

  const addFilePath = async () => {
    if (!id || !newPath.trim()) return;
    setPathError('');
    try {
      await api(`/api/agents/${id}/file-access`, {
        method: 'POST',
        body: JSON.stringify({ path: newPath.trim() }),
      });
      const res = await api<{ data: Array<{id: string; path: string}> }>(`/api/agents/${id}/file-access`);
      setFilePaths(res.data || []);
      setNewPath('');
    } catch (err) {
      setPathError(err instanceof Error ? err.message : 'Could not add path');
    }
  };

  const removeFilePath = async (pathId: string) => {
    if (!id) return;
    try {
      await api(`/api/agents/${id}/file-access/${pathId}`, { method: 'DELETE' });
      setFilePaths(prev => prev.filter(p => p.id !== pathId));
    } catch { /* */ }
  };

  const configFields = useMemo((): ConfigField[] => [
    { key: 'model', label: 'Model', value: String(config.model || 'claude-sonnet-4-5') },
    { key: 'temperature', label: 'Temperature', value: String(config.temperature ?? '0.7') },
    { key: 'max_tokens', label: 'Max tokens', value: String(config.max_tokens || '4096') },
    { key: 'requires_approval', label: 'Requires approval', value: String(config.requires_approval ?? 'no') },
    { key: 'web_search', label: 'Web search', value: String(config.web_search ?? 'no') },
    { key: 'device_access', label: 'Device access', value: deviceAccessEnabled ? 'yes' : 'no' },
  ], [config, deviceAccessEnabled]);

  const handleVoiceChange = useCallback(async (profileId: string) => {
    if (!id) return;
    setSaving(true);
    try {
      await api(`/api/agents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ voice_profile_id: profileId || null }),
      });
      refetch();
    } catch { /* */ } finally { setSaving(false); }
  }, [id, refetch]);

  const togglePause = useCallback(async () => {
    if (!id || !agent) return;
    const newStatus = agent.status === 'paused' ? 'idle' : 'paused';
    try {
      await api(`/api/agents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      });
      refetch();
    } catch { /* */ }
  }, [id, agent, refetch]);

  const startEditing = useCallback(() => {
    setEditFields(configFields.map(f => ({ ...f })));
    setEditing(true);
  }, [configFields]);

  const saveConfig = useCallback(async () => {
    if (!id) return;
    setSavingConfig(true);
    try {
      const newConfig: Record<string, unknown> = {};
      for (const field of editFields) {
        // device_access is a virtual field that maps to two real flags
        if (field.key === 'device_access') {
          const enabled = field.value === 'true' || field.value === 'yes';
          newConfig.local_files_enabled = enabled;
          newConfig.bash_enabled = enabled;
          continue;
        }
        if (field.value === 'true' || field.value === 'yes') {
          newConfig[field.key] = true;
        } else if (field.value === 'false' || field.value === 'no') {
          newConfig[field.key] = false;
        } else if (!isNaN(Number(field.value)) && field.value !== '') {
          newConfig[field.key] = Number(field.value);
        } else {
          newConfig[field.key] = field.value;
        }
      }
      await api(`/api/agents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ config: newConfig }),
      });
      setEditing(false);
      refetch();
    } catch { /* */ } finally { setSavingConfig(false); }
  }, [id, editFields, refetch]);

  const saveMcp = useCallback(async (enabled: boolean, servers: McpServerConfig[]) => {
    if (!id) return;
    setSavingMcp(true);
    try {
      await api(`/api/agents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ config: { ...config, mcp_enabled: enabled, mcp_servers: servers } }),
      });
      refetch();
    } catch { /* */ } finally { setSavingMcp(false); }
  }, [id, config, refetch]);

  if (loading) return <div className="p-6"><RowSkeleton count={4} /></div>;
  if (!agent) return <div className="p-6 text-neutral-400">Agent not found</div>;

  const tabsWithCounts = TABS.map(t => ({
    ...t,
    count: t.id === 'tasks' ? tasks?.length : undefined,
  }));

  return (
    <div className="p-6 max-w-4xl">
      <Link to="/agents" className="inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-white mb-4 transition-colors">
        <ArrowLeft size={14} /> Back to agents
      </Link>

      <PageHeader
        title={agent.name}
        subtitle={agent.role}
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={togglePause}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                agent.status === 'paused'
                  ? 'bg-success/10 border-success/30 text-success hover:bg-success/20'
                  : 'bg-warning/10 border-warning/30 text-warning hover:bg-warning/20'
              }`}
            >
              {agent.status === 'paused' ? <Play size={14} /> : <Pause size={14} />}
              {agent.status === 'paused' ? 'Resume' : 'Pause'}
            </button>
            <StatusBadge status={agent.status} />
          </div>
        }
      />

      {agent.description && (
        <p className="text-sm text-neutral-400 mb-4">{agent.description}</p>
      )}

      <TabSwitcher
        tabs={tabsWithCounts}
        activeTab={tab}
        onTabChange={(id) => { setTab(id); setEditing(false); }}
        layoutId="agent-detail-tab"
      />

      <div className="mt-6">
        {/* Overview Tab */}
        {tab === 'overview' && (
          <>
            <div className="grid grid-cols-3 gap-3 mb-8">
              <MetricCard label="Tasks" value={stats.total_tasks || 0} />
              <MetricCard label="Tokens" value={stats.tokens_used?.toLocaleString() || '0'} />
              <MetricCard label="Cost" value={`$${((stats.cost_cents || 0) / 100).toFixed(2)}`} />
            </div>

            {voiceAvailable && (
              <>
                <h2 className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider mb-3">Voice</h2>
                <div className="border border-white/[0.08] rounded-lg px-4 py-3 mb-8">
                  <label className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium">Voice profile</p>
                      <p className="text-xs text-neutral-500">Choose which voice this agent uses during calls</p>
                    </div>
                    <select
                      value={agent.voice_profile_id || ''}
                      onChange={e => handleVoiceChange(e.target.value)}
                      disabled={saving}
                      className="bg-black border border-white/10 rounded-md px-3 py-1.5 text-sm min-w-[180px]"
                    >
                      <option value="">Default voice</option>
                      {profiles.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </>
            )}

            <h2 className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider mb-3">Memory</h2>
            {memories?.length ? (
              <div className="space-y-2">
                {memories.map(m => (
                  <div key={m.id} className="border border-white/[0.08] rounded-lg px-4 py-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs text-white font-medium">{m.memory_type}</span>
                      <span className="text-xs text-neutral-500">{new Date(m.created_at).toLocaleDateString()}</span>
                    </div>
                    <p className="text-sm text-neutral-300">{m.content}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-neutral-500">No memories yet. This agent will learn from completed tasks.</p>
            )}

            {agent.system_prompt && (
              <>
                <h2 className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider mb-3 mt-8">System Prompt</h2>
                <div className="border border-white/[0.08] rounded-lg p-4">
                  <pre className="text-sm whitespace-pre-wrap break-words text-neutral-300 max-h-[40vh] overflow-y-auto leading-relaxed">
                    {agent.system_prompt}
                  </pre>
                </div>
              </>
            )}
          </>
        )}

        {/* Tasks Tab */}
        {tab === 'tasks' && (
          <>
            {!tasks?.length ? (
              <EmptyState
                icon={<ListChecks size={32} />}
                title="No tasks yet"
                description="Tasks will appear here as this agent works."
              />
            ) : (
              <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
                {tasks.map(task => (
                  <Link key={task.id} to={`/tasks/${task.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors">
                    <div className="min-w-0 mr-3">
                      <p className="text-sm font-medium truncate">{task.title}</p>
                      <p className="text-xs text-neutral-500">{getTimeAgo(task.created_at)}</p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {task.tokens_used ? <span className="text-xs text-neutral-500">{task.tokens_used.toLocaleString()} tok</span> : null}
                      {task.priority && <span className="text-xs text-warning">{task.priority}</span>}
                      <StatusBadge status={task.status} />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}

        {/* Activity Tab */}
        {tab === 'activity' && (
          <>
            {!agentActivity.length ? (
              <EmptyState
                icon={<Pulse size={32} />}
                title="No activity yet"
                description="Activity will appear here as this agent works on tasks."
              />
            ) : (
              <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
                {agentActivity.map(entry => (
                  <div key={entry.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="mt-0.5">
                      {entry.activity_type === 'task_completed' && <CheckCircle size={16} weight="fill" className="text-success" />}
                      {entry.activity_type === 'task_failed' && <XCircle size={16} weight="fill" className="text-critical" />}
                      {entry.activity_type === 'task_started' && <CircleNotch size={16} className="text-white animate-spin" />}
                      {!['task_completed', 'task_failed', 'task_started'].includes(entry.activity_type) && <Pulse size={16} className="text-neutral-400" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{entry.title}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-neutral-500 shrink-0">
                          {entry.activity_type.replace(/_/g, ' ')}
                        </span>
                      </div>
                      {entry.description && (
                        <p className="text-xs text-neutral-500 mt-0.5 truncate">{entry.description}</p>
                      )}
                      <p className="text-xs text-neutral-600 mt-1">{getTimeAgo(entry.created_at)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Performance Tab */}
        {tab === 'performance' && (
          <>
            {!performanceMetrics ? (
              <EmptyState
                icon={<Pulse size={32} />}
                title="No performance data"
                description="Complete some tasks first to see performance metrics."
              />
            ) : (
              <>
                <div className="grid grid-cols-3 gap-3 mb-6">
                  <MetricCard label="Success rate" value={`${(performanceMetrics.successRate * 100).toFixed(0)}%`} />
                  <MetricCard label="Avg duration" value={performanceMetrics.avgDuration > 0 ? `${performanceMetrics.avgDuration.toFixed(1)}s` : 'N/A'} />
                  <MetricCard label="Total tokens" value={performanceMetrics.totalTokens.toLocaleString()} />
                </div>
                <div className="grid grid-cols-3 gap-3 mb-8">
                  <MetricCard label="Total cost" value={`$${(performanceMetrics.totalCostCents / 100).toFixed(2)}`} />
                  <MetricCard label="Avg tokens/task" value={performanceMetrics.avgTokens.toLocaleString()} />
                  <MetricCard label="Tasks evaluated" value={performanceMetrics.completed + performanceMetrics.failed} />
                </div>

                <h2 className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider mb-3">Task outcomes</h2>
                <div className="border border-white/[0.08] rounded-lg p-4">
                  <svg viewBox="0 0 300 80" className="w-full max-w-sm" role="img" aria-label="Task outcome chart">
                    {(() => {
                      const total = performanceMetrics.completed + performanceMetrics.failed;
                      if (total === 0) return null;
                      const cW = (performanceMetrics.completed / total) * 260;
                      const fW = (performanceMetrics.failed / total) * 260;
                      return (
                        <>
                          <rect x={20} y={10} width={cW} height={24} rx={4} fill="#22c55e" />
                          <text x={20} y={52} className="text-[10px]" fill="#a3a3a3" fontSize="10">
                            Completed: {performanceMetrics.completed}
                          </text>
                          <rect x={20} y={56} width={fW} height={24} rx={4} fill="#ef4444" />
                          <text x={20 + fW + 8} y={72} className="text-[10px]" fill="#a3a3a3" fontSize="10">
                            Failed: {performanceMetrics.failed}
                          </text>
                        </>
                      );
                    })()}
                  </svg>
                </div>
              </>
            )}
          </>
        )}

        {/* Config Tab */}
        {tab === 'config' && !editing && (
          <>
            <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
              {configFields.map(f => (
                <div key={f.key} className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-neutral-400">{f.label}</span>
                  <span className="text-sm font-medium">{f.value}</span>
                </div>
              ))}
              <div className="flex items-center justify-between px-4 py-3">
                <div>
                  <span className="text-sm text-neutral-400">MCP tools</span>
                  <p className="text-xs text-neutral-600">Allow this agent to use MCP servers</p>
                </div>
                <Toggle
                  checked={mcpEnabled}
                  onChange={async (val) => {
                    setMcpEnabled(val);
                    await saveMcp(val, mcpServers);
                  }}
                  disabled={savingMcp}
                  size="sm"
                />
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <div>
                  <span className="text-sm text-neutral-400">Device access</span>
                  <p className="text-xs text-neutral-600">Allow filesystem and shell access to local directories</p>
                </div>
                <Toggle
                  checked={deviceAccessEnabled}
                  onChange={async (val) => {
                    if (!id) return;
                    try {
                      await api(`/api/agents/${id}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ config: { ...config, local_files_enabled: val, bash_enabled: val } }),
                      });
                      refetch();
                    } catch { /* */ }
                  }}
                  size="sm"
                />
              </div>
            </div>

            {mcpEnabled && (
              <McpServersSection
                servers={mcpServers}
                onChange={async (updated) => {
                  setMcpServers(updated);
                  await saveMcp(mcpEnabled, updated);
                }}
                disabled={savingMcp}
              />
            )}

            {deviceAccessEnabled && (
              <div className="mt-4">
                <h3 className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider mb-3">Allowed directories</h3>
                {filePaths.length > 0 ? (
                  <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
                    {filePaths.map(fp => (
                      <div key={fp.id} className="flex items-center justify-between px-4 py-2.5">
                        <code className="text-sm text-neutral-300">{fp.path}</code>
                        <button
                          onClick={() => removeFilePath(fp.id)}
                          className="text-xs text-neutral-500 hover:text-red-400 transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-neutral-500 mb-3">No directories configured yet.</p>
                )}
                <div className="flex gap-2 mt-3">
                  <input
                    value={newPath}
                    onChange={e => { setNewPath(e.target.value); setPathError(''); }}
                    onKeyDown={e => { if (e.key === 'Enter') addFilePath(); }}
                    placeholder="~/projects/myapp"
                    className="flex-1 bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-white/20"
                  />
                  <button
                    onClick={addFilePath}
                    className="px-3 py-1.5 text-xs font-medium bg-white/5 border border-white/10 text-white rounded-md hover:bg-white/10 transition-colors"
                  >
                    Add path
                  </button>
                </div>
                {pathError && <p className="text-xs text-red-400 mt-1">{pathError}</p>}
              </div>
            )}

            <div className="mt-4">
              <button
                onClick={startEditing}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white/5 border border-white/10 text-white rounded-md hover:bg-white/10 transition-colors"
              >
                <Gear size={14} /> Edit config
              </button>
            </div>
          </>
        )}

        {tab === 'config' && editing && (
          <>
            <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
              {editFields.map((f, i) => (
                <div key={f.key} className="flex items-center justify-between px-4 py-3">
                  <label className="text-sm text-neutral-400" htmlFor={`config-${f.key}`}>{f.label}</label>
                  <input
                    id={`config-${f.key}`}
                    value={f.value}
                    onChange={e => {
                      const updated = [...editFields];
                      updated[i] = { ...f, value: e.target.value };
                      setEditFields(updated);
                    }}
                    className="bg-white/5 border border-white/10 rounded px-3 py-1.5 text-sm text-white text-right w-48 focus:outline-none focus:border-white/20"
                  />
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => setEditing(false)}
                className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveConfig}
                disabled={savingConfig}
                className="px-4 py-1.5 text-xs font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors"
              >
                {savingConfig ? 'Saving...' : 'Save config'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
