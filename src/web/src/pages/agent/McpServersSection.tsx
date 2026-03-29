/**
 * McpServersSection
 * Agent-level MCP server list with add/delete UI.
 * Used inside the Agent Config tab.
 */

import { useState } from 'react';
import { Trash, Lightning, CaretRight, CaretDown } from '@phosphor-icons/react';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  envVarsRequired: Array<{ key: string; label: string }>;
  category: 'files' | 'databases' | 'apis' | 'development' | 'communication';
}

const CATALOG_CATEGORIES = [
  { id: 'development', label: 'Development' },
  { id: 'files', label: 'Files' },
  { id: 'databases', label: 'Databases' },
  { id: 'apis', label: 'APIs' },
  { id: 'communication', label: 'Communication' },
] as const;

const MCP_SERVER_CATALOG: McpCatalogEntry[] = [
  { id: 'filesystem', name: 'Filesystem', description: 'Read, write, and search files on your machine', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], envVarsRequired: [], category: 'files' },
  { id: 'github', name: 'GitHub', description: 'Manage repos, issues, and pull requests', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], envVarsRequired: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub token' }], category: 'development' },
  { id: 'slack', name: 'Slack', description: 'Read and send Slack messages', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], envVarsRequired: [{ key: 'SLACK_BOT_TOKEN', label: 'Slack bot token' }, { key: 'SLACK_TEAM_ID', label: 'Slack team ID' }], category: 'communication' },
  { id: 'postgres', name: 'PostgreSQL', description: 'Query and explore PostgreSQL databases', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'], envVarsRequired: [{ key: 'POSTGRES_CONNECTION_STRING', label: 'Connection string' }], category: 'databases' },
  { id: 'sqlite', name: 'SQLite', description: 'Query and explore SQLite databases', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sqlite'], envVarsRequired: [{ key: 'SQLITE_DB_PATH', label: 'Database file path' }], category: 'databases' },
  { id: 'brave-search', name: 'Brave Search', description: 'Search the web with Brave', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], envVarsRequired: [{ key: 'BRAVE_API_KEY', label: 'Brave API key' }], category: 'apis' },
  { id: 'fetch', name: 'Fetch', description: 'Fetch and read web pages and APIs', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'], envVarsRequired: [], category: 'apis' },
  { id: 'memory', name: 'Memory', description: 'Persistent knowledge graph for storing and retrieving information', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], envVarsRequired: [], category: 'development' },
  { id: 'google-maps', name: 'Google Maps', description: 'Search places, get directions, and geocode addresses', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-google-maps'], envVarsRequired: [{ key: 'GOOGLE_MAPS_API_KEY', label: 'Google Maps API key' }], category: 'apis' },
  { id: 'sequential-thinking', name: 'Sequential Thinking', description: 'Think through problems step by step', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], envVarsRequired: [], category: 'development' },
  { id: 'everything', name: 'Everything (Demo)', description: 'Demo server with sample tools for testing', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], envVarsRequired: [], category: 'development' },
  { id: 'puppeteer', name: 'Puppeteer', description: 'Browser automation and web scraping', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'], envVarsRequired: [], category: 'development' },
];

interface McpServersSectionProps {
  servers: McpServerConfig[];
  onChange: (servers: McpServerConfig[]) => void;
  disabled?: boolean;
}

const EMPTY_FORM = {
  name: '',
  transport: 'stdio' as 'stdio' | 'http',
  command: '',
  args: '',
  env: '',
  url: '',
};

interface McpToolInfo {
  name: string;
  description: string;
}

export function McpServersSection({ servers, onChange, disabled }: McpServersSectionProps) {
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [serverTools, setServerTools] = useState<Record<string, McpToolInfo[]>>({});
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [modalTab, setModalTab] = useState<'popular' | 'custom'>('popular');

  const openAdd = () => {
    setForm(EMPTY_FORM);
    setFormError('');
    setModalTab('popular');
    setShowModal(true);
  };

  const handleAdd = () => {
    if (!form.name.trim()) { setFormError('Name is required'); return; }
    if (form.transport === 'stdio' && !form.command.trim()) { setFormError('Command is required'); return; }
    if (form.transport === 'http' && !form.url.trim()) { setFormError('URL is required'); return; }

    if (servers.some(s => s.name === form.name.trim())) {
      setFormError('A server with that name already exists');
      return;
    }

    const server: McpServerConfig = form.transport === 'stdio'
      ? {
          name: form.name.trim(),
          transport: 'stdio',
          command: form.command.trim(),
          args: form.args.trim() ? form.args.trim().split(/\s+/) : undefined,
          env: form.env.trim() ? parseEnvString(form.env.trim()) : undefined,
        }
      : {
          name: form.name.trim(),
          transport: 'http',
          url: form.url.trim(),
        };

    onChange([...servers, server]);
    setShowModal(false);
  };

  const handleDelete = (name: string) => {
    onChange(servers.filter(s => s.name !== name));
  };

  const handleTest = async (server: McpServerConfig) => {
    if (testingServer) return;
    setTestingServer(server.name);
    try {
      const res = await fetch('/api/mcp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(server),
      });
      const result = await res.json() as { success: boolean; tools: McpToolInfo[]; error?: string; latencyMs: number };
      if (result.success) {
        toast.success(`Connected. ${result.tools.length === 1 ? '1 tool' : `${result.tools.length} tools`} found in ${result.latencyMs}ms`);
        setServerTools(prev => ({ ...prev, [server.name]: result.tools }));
        setExpandedServer(server.name);
      } else {
        toast.error(result.error || 'Couldn\'t connect to this server. Try again?');
      }
    } catch {
      toast.error('Couldn\'t reach the daemon to test the connection');
    } finally {
      setTestingServer(null);
    }
  };

  const toggleExpand = (name: string) => {
    setExpandedServer(prev => prev === name ? null : name);
  };

  return (
    <>
      <div className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider">MCP Servers</h3>
          <button
            onClick={openAdd}
            disabled={disabled}
            className="text-xs text-white hover:text-white/80 disabled:opacity-50 transition-colors"
          >
            + Add
          </button>
        </div>

        {servers.length === 0 ? (
          <p className="text-xs text-neutral-400 py-2">No MCP servers yet. Add one to extend what this agent can do.</p>
        ) : (
          <div className="bg-white/5 border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
            {servers.map(s => {
              const tools = serverTools[s.name];
              const isExpanded = expandedServer === s.name;
              const isTesting = testingServer === s.name;

              return (
                <div key={s.name}>
                  <div className="flex items-center justify-between px-4 py-3">
                    <div className="min-w-0 mr-3 flex items-center gap-2">
                      {tools && tools.length > 0 && (
                        <button
                          onClick={() => toggleExpand(s.name)}
                          className="text-neutral-400 hover:text-white transition-colors shrink-0"
                        >
                          {isExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
                        </button>
                      )}
                      <span className="text-sm font-medium">{s.name}</span>
                      <span className="text-xs text-neutral-400">
                        {s.transport === 'stdio'
                          ? `stdio · ${s.command}${s.args?.length ? ' ' + s.args.join(' ') : ''}`
                          : `http · ${s.url}`}
                      </span>
                      {tools && (
                        <span className="text-xs text-neutral-500">
                          {tools.length === 1 ? '1 tool' : `${tools.length} tools`}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => handleTest(s)}
                        disabled={disabled || isTesting}
                        className={`text-neutral-400 hover:text-uplink transition-colors disabled:opacity-50 ${isTesting ? 'animate-pulse' : ''}`}
                        title="Test connection"
                      >
                        <Lightning size={14} weight={isTesting ? 'fill' : 'bold'} />
                      </button>
                      <button
                        onClick={() => handleDelete(s.name)}
                        disabled={disabled}
                        className="text-neutral-400 hover:text-error transition-colors disabled:opacity-50"
                      >
                        <Trash size={14} />
                      </button>
                    </div>
                  </div>
                  {isExpanded && tools && tools.length > 0 && (
                    <div className="px-4 pb-3 pl-10">
                      <div className="bg-white/[0.03] rounded-md border border-white/[0.06] divide-y divide-white/[0.06]">
                        {tools.map(t => (
                          <div key={t.name} className="px-3 py-2">
                            <span className="text-xs font-mono text-white/80">{t.name}</span>
                            {t.description && (
                              <p className="text-xs text-neutral-500 mt-0.5">{t.description}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title="Add MCP Server" maxWidth="max-w-lg">
        <div className="space-y-4">
          {/* Tab switcher */}
          <div className="flex gap-1 bg-white/[0.04] rounded-md p-0.5">
            <button
              onClick={() => setModalTab('popular')}
              className={`flex-1 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                modalTab === 'popular' ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'
              }`}
            >
              Popular
            </button>
            <button
              onClick={() => setModalTab('custom')}
              className={`flex-1 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                modalTab === 'custom' ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'
              }`}
            >
              Custom
            </button>
          </div>

          {/* Popular tab: catalog cards */}
          {modalTab === 'popular' && (
            <div className="space-y-4">
              {CATALOG_CATEGORIES.map(cat => {
                const entries = MCP_SERVER_CATALOG.filter(e => e.category === cat.id);
                if (entries.length === 0) return null;
                return (
                  <div key={cat.id}>
                    <h4 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-2">{cat.label}</h4>
                    <div className="grid grid-cols-2 gap-2">
                      {entries.map(entry => {
                        const alreadyAdded = servers.some(s => s.name === entry.name);
                        return (
                          <button
                            key={entry.id}
                            onClick={() => {
                              if (alreadyAdded) return;
                              setForm({
                                name: entry.name,
                                transport: entry.transport,
                                command: entry.command,
                                args: entry.args.join(' '),
                                env: entry.envVarsRequired.map(v => `${v.key}=`).join('\n'),
                                url: '',
                              });
                              setFormError('');
                              setModalTab('custom');
                            }}
                            disabled={alreadyAdded}
                            className={`text-left p-3 rounded-lg border transition-colors ${
                              alreadyAdded
                                ? 'border-white/[0.06] bg-white/[0.02] opacity-50 cursor-not-allowed'
                                : 'border-white/[0.08] bg-white/[0.04] hover:border-white/20 hover:bg-white/[0.06]'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-1">
                              <span className="text-sm font-medium">{entry.name}</span>
                              <span className="text-[10px] text-neutral-500 bg-white/[0.06] px-1.5 py-0.5 rounded shrink-0">
                                {cat.label}
                              </span>
                            </div>
                            <p className="text-xs text-neutral-400 mt-1">{entry.description}</p>
                            {alreadyAdded && (
                              <p className="text-[10px] text-neutral-500 mt-1">Already added</p>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Custom tab: manual form */}
          {modalTab === 'custom' && (
            <>
              <div>
                <label className="block text-xs text-neutral-400 mb-1">Name</label>
                <input
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. filesystem"
                  className="w-full bg-white/[0.06] border border-white/[0.08] rounded px-3 py-2 text-sm focus:outline-none focus:border-white/20"
                />
              </div>

              <div>
                <label className="block text-xs text-neutral-400 mb-1">Transport</label>
                <select
                  value={form.transport}
                  onChange={e => setForm(f => ({ ...f, transport: e.target.value as 'stdio' | 'http' }))}
                  className="w-full bg-white/[0.06] border border-white/[0.08] rounded px-3 py-2 text-sm focus:outline-none focus:border-white/20"
                >
                  <option value="stdio">stdio (subprocess on this machine)</option>
                  <option value="http">http (remote server via URL)</option>
                </select>
              </div>

              {form.transport === 'stdio' ? (
                <>
                  <div>
                    <label className="block text-xs text-neutral-400 mb-1">Command</label>
                    <input
                      value={form.command}
                      onChange={e => setForm(f => ({ ...f, command: e.target.value }))}
                      placeholder="e.g. npx"
                      className="w-full bg-white/[0.06] border border-white/[0.08] rounded px-3 py-2 text-sm focus:outline-none focus:border-white/20"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-400 mb-1">Args (space-separated)</label>
                    <input
                      value={form.args}
                      onChange={e => setForm(f => ({ ...f, args: e.target.value }))}
                      placeholder="e.g. -y @modelcontextprotocol/server-filesystem /tmp"
                      className="w-full bg-white/[0.06] border border-white/[0.08] rounded px-3 py-2 text-sm focus:outline-none focus:border-white/20"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-400 mb-1">Env vars (optional, KEY=VALUE one per line)</label>
                    <textarea
                      value={form.env}
                      onChange={e => setForm(f => ({ ...f, env: e.target.value }))}
                      placeholder="MY_KEY=value"
                      rows={3}
                      className="w-full bg-white/[0.06] border border-white/[0.08] rounded px-3 py-2 text-sm focus:outline-none focus:border-white/20 resize-none"
                    />
                  </div>
                </>
              ) : (
                <div>
                  <label className="block text-xs text-neutral-400 mb-1">URL</label>
                  <input
                    value={form.url}
                    onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                    placeholder="e.g. http://localhost:5173/sse"
                    className="w-full bg-white/[0.06] border border-white/[0.08] rounded px-3 py-2 text-sm focus:outline-none focus:border-white/20"
                  />
                </div>
              )}

              {formError && <p className="text-xs text-error">{formError}</p>}

              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowModal(false)}
                  className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAdd}
                  className="px-3 py-1.5 text-xs font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors"
                >
                  Add server
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}

function parseEnvString(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      result[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }
  return result;
}
