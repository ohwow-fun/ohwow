/**
 * AgentDetail Screen
 * Single agent view: info, memory, prompt, tasks, and config tabs.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { AgentRow } from '../types.js';
import { TextPanel } from '../components/text-panel.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { TaskRow as TaskRowComponent } from '../components/task-row.js';
import { InputField } from '../components/input-field.js';

interface AgentDetailProps {
  agentId: string;
  db: DatabaseAdapter | null;
  onBack: () => void;
  onMcpServers?: () => void;
}

interface MemoryItem {
  id: string;
  memory_type: string;
  content: string;
  relevance_score: number;
}

interface AgentTask {
  id: string;
  title: string;
  status: string;
  tokens_used: number | null;
  priority: string | null;
  created_at: string;
}

type Tab = 'info' | 'memory' | 'prompt' | 'tasks' | 'config';

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

export function AgentDetail({ agentId, db, onBack, onMcpServers }: AgentDetailProps) {
  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [tab, setTab] = useState<Tab>('info');
  const [editing, setEditing] = useState(false);
  const [editFields, setEditFields] = useState<ConfigField[]>([]);
  const [editIndex, setEditIndex] = useState(0);

  useEffect(() => {
    if (!db) return;

    const fetch = async () => {
      const { data: agentData } = await db
        .from<AgentRow>('agent_workforce_agents')
        .select('*')
        .eq('id', agentId)
        .single();

      if (agentData) {
        setAgent(agentData);
      }

      const { data: memData } = await db
        .from<MemoryItem>('agent_workforce_agent_memory')
        .select('*')
        .eq('agent_id', agentId)
        .eq('is_active', 1)
        .order('created_at', { ascending: false });

      if (memData) {
        setMemories(memData);
      }

      const { data: taskData } = await db
        .from<AgentTask>('agent_workforce_tasks')
        .select('id, title, status, tokens_used, priority, created_at')
        .eq('agent_id', agentId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (taskData) {
        setTasks(taskData);
      }
    };

    fetch();
  }, [db, agentId]);

  const config = useMemo(() => {
    if (!agent) return {};
    return typeof agent.config === 'string' ? JSON.parse(agent.config as string) : (agent.config || {});
  }, [agent]);

  const deviceAccessEnabled = config.local_files_enabled === true && config.bash_enabled === true;

  const [paths, setPaths] = useState<Array<{id: string; path: string}>>([]);
  const [pathIndex, setPathIndex] = useState(0);
  const [addingPath, setAddingPath] = useState(false);
  const [newPathValue, setNewPathValue] = useState('');

  useEffect(() => {
    if (!db || !agent) return;
    const fetchPaths = async () => {
      const { data: pathData } = await db
        .from('agent_file_access_paths')
        .select('id, path')
        .eq('agent_id', agentId);
      if (pathData) setPaths(pathData as Array<{id: string; path: string}>);
    };
    fetchPaths();
  }, [db, agent, agentId]);

  const configFields = useMemo((): ConfigField[] => [
    { key: 'model', label: 'Model', value: 'router (auto)' },
    { key: 'temperature', label: 'Temperature', value: String(config.temperature ?? '0.7') },
    { key: 'max_tokens', label: 'Max tokens', value: String(config.max_tokens || '4096') },
    { key: 'requires_approval', label: 'Approval req', value: String(config.requires_approval ?? 'no') },
    { key: 'web_search', label: 'Web search', value: String(config.web_search ?? 'no') },
    { key: 'mcp_enabled', label: 'MCP tools', value: config.mcp_enabled === true ? 'yes' : 'no' },
    { key: 'device_access', label: 'Device access', value: deviceAccessEnabled ? 'yes' : 'no' },
  ], [config, deviceAccessEnabled]);

  const toggleStatus = async () => {
    if (!db || !agent) return;
    const newStatus = agent.status === 'paused' ? 'idle' : 'paused';
    await db.from('agent_workforce_agents').update({
      status: newStatus,
      updated_at: new Date().toISOString(),
    }).eq('id', agentId);
    setAgent({ ...agent, status: newStatus });
  };

  const addPath = async (pathValue: string) => {
    if (!db || !agent) return;
    const trimmed = pathValue.trim();
    if (!trimmed) return;

    // Basic validation
    if (!trimmed.startsWith('~') && !trimmed.startsWith('/')) return;
    const blocked = ['.ssh', '.gnupg', '.aws', '.env'];
    if (blocked.some(b => trimmed.includes(b))) return;

    // Resolve ~ to home dir for storage
    const resolved = trimmed.startsWith('~')
      ? trimmed  // Store as-is; the API/engine resolves ~
      : trimmed;

    const { error } = await db.from('agent_file_access_paths').insert({
      agent_id: agentId,
      workspace_id: agent.workspace_id,
      path: resolved,
    });
    if (!error) {
      // Re-fetch paths
      const { data: pathData } = await db
        .from('agent_file_access_paths')
        .select('id, path')
        .eq('agent_id', agentId);
      if (pathData) setPaths(pathData as Array<{id: string; path: string}>);
    }
  };

  const removePath = async () => {
    if (!db || paths.length === 0) return;
    const target = paths[pathIndex];
    if (!target) return;
    await db.from('agent_file_access_paths').delete().eq('id', target.id);
    const remaining = paths.filter(p => p.id !== target.id);
    setPaths(remaining);
    if (pathIndex >= remaining.length && remaining.length > 0) {
      setPathIndex(remaining.length - 1);
    }
  };

  const saveConfig = async () => {
    if (!db || !agent) return;
    const newConfig = { ...config };
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
    await db.from('agent_workforce_agents').update({
      config: JSON.stringify(newConfig),
      updated_at: new Date().toISOString(),
    }).eq('id', agentId);
    setAgent({ ...agent, config: newConfig });
    setEditing(false);
  };

  useInput((input, key) => {
    // Let InputField handle keys when editing or adding path
    if (editing || addingPath) {
      if (key.escape) {
        if (addingPath) {
          setAddingPath(false);
          setNewPathValue('');
        } else {
          setEditing(false);
        }
        return;
      }
      return;
    }

    if (key.escape) {
      onBack();
      return;
    }
    const tabs: Tab[] = ['info', 'memory', 'prompt', 'tasks', 'config'];
    if (key.leftArrow) {
      setTab(prev => {
        const idx = tabs.indexOf(prev);
        return tabs[(idx - 1 + tabs.length) % tabs.length];
      });
      return;
    }
    if (key.rightArrow) {
      setTab(prev => {
        const idx = tabs.indexOf(prev);
        return tabs[(idx + 1) % tabs.length];
      });
      return;
    }
    if (input === 'p' && tab === 'info') {
      toggleStatus();
      return;
    }
    if (input === 'x' && tab === 'config') {
      setEditFields(configFields.map(f => ({ ...f })));
      setEditIndex(0);
      setEditing(true);
      return;
    }
    if (input === 'm' && tab === 'config' && config.mcp_enabled === true && onMcpServers) {
      onMcpServers();
      return;
    }
    // Path management keys (config tab, device access on, not editing)
    if (tab === 'config' && deviceAccessEnabled) {
      if (input === 'a') {
        setAddingPath(true);
        setNewPathValue('');
        return;
      }
      if (input === 'd' && paths.length > 0) {
        removePath();
        return;
      }
      if (key.upArrow && paths.length > 0) {
        setPathIndex(prev => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow && paths.length > 0) {
        setPathIndex(prev => Math.min(paths.length - 1, prev + 1));
        return;
      }
    }
  });

  if (!agent) {
    return <Text color="gray">Loading agent...</Text>;
  }

  const stats = typeof agent.stats === 'string' ? JSON.parse(agent.stats) : (agent.stats || {});

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">{agent.name}</Text>
        <Text color="gray"> {'\u2014'} {agent.role}</Text>
      </Box>

      {/* Sub-tabs */}
      <Box marginBottom={1}>
        <Text color={tab === 'info' ? 'cyan' : 'gray'} bold={tab === 'info'}>Info  </Text>
        <Text color={tab === 'memory' ? 'cyan' : 'gray'} bold={tab === 'memory'}>Memory({memories.length})  </Text>
        <Text color={tab === 'prompt' ? 'cyan' : 'gray'} bold={tab === 'prompt'}>Prompt  </Text>
        <Text color={tab === 'tasks' ? 'cyan' : 'gray'} bold={tab === 'tasks'}>Tasks({tasks.length})  </Text>
        <Text color={tab === 'config' ? 'cyan' : 'gray'} bold={tab === 'config'}>Config</Text>
        <Text color="gray">  ←/→</Text>
      </Box>

      {tab === 'info' && (
        <Box flexDirection="column">
          <Text>Status:     <Text color={agent.status === 'working' ? 'yellow' : agent.status === 'paused' ? 'red' : 'green'}>{agent.status}</Text></Text>
          <Text>Tasks:      <Text color="gray">{stats.total_tasks || 0}</Text></Text>
          <Text>Completed:  <Text color="gray">{stats.completed_tasks || 0}</Text></Text>
          <Text>Failed:     <Text color="gray">{stats.failed_tasks || 0}</Text></Text>
          <Text>Tokens:     <Text color="gray">{(stats.tokens_used || 0).toLocaleString()}</Text></Text>
          <Text>Cost:       <Text color="gray">${((stats.cost_cents || 0) / 100).toFixed(2)}</Text></Text>
          <Text>Model:      <Text color="gray">router (auto)</Text></Text>
          {agent.description && <Text>Description: <Text color="gray">{agent.description}</Text></Text>}
        </Box>
      )}

      {tab === 'memory' && (
        <Box flexDirection="column">
          {memories.length === 0 ? (
            <Text color="gray">No memories yet. Memories are extracted after task completion.</Text>
          ) : (
            <ScrollableList
              items={memories}
              emptyMessage="No memories."
              renderItem={(m, _, isSelected) => (
                <Text bold={isSelected}>
                  <Text color="cyan">[{m.memory_type}]</Text>
                  <Text> {m.content}</Text>
                </Text>
              )}
            />
          )}
        </Box>
      )}

      {tab === 'prompt' && (
        <TextPanel
          content={agent.system_prompt}
          title="System Prompt"
        />
      )}

      {tab === 'tasks' && (
        <Box flexDirection="column">
          {tasks.length === 0 ? (
            <Text color="gray">No tasks for this agent yet.</Text>
          ) : (
            <ScrollableList
              items={tasks}
              emptyMessage="No tasks."
              renderItem={(task, _, isSelected) => (
                <TaskRowComponent
                  title={task.title}
                  status={task.status}
                  timeAgo={getTimeAgo(task.created_at)}
                  tokensUsed={task.tokens_used}
                  priority={task.priority}
                  isSelected={isSelected}
                />
              )}
            />
          )}
        </Box>
      )}

      {tab === 'config' && !editing && (
        <Box flexDirection="column">
          {configFields.map(f => (
            <Text key={f.key}>{f.label.padEnd(16)}<Text color="gray">{f.value}</Text></Text>
          ))}
          {deviceAccessEnabled && paths.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {paths.map((p, i) => (
                <Text key={p.id} color={i === pathIndex ? 'cyan' : 'gray'}>
                  {i === pathIndex ? '▸ ' : '  '}{p.path}
                </Text>
              ))}
            </Box>
          )}
          {deviceAccessEnabled && paths.length === 0 && (
            <Box marginTop={1}>
              <Text color="yellow">No allowed paths configured. Press a to add one.</Text>
            </Box>
          )}
          {addingPath && (
            <Box marginTop={1}>
              <InputField
                label="Path"
                value={newPathValue}
                onChange={setNewPathValue}
                onSubmit={() => {
                  addPath(newPathValue);
                  setAddingPath(false);
                  setNewPathValue('');
                }}
              />
            </Box>
          )}
        </Box>
      )}

      {tab === 'config' && editing && (
        <Box flexDirection="column">
          {editFields.map((f, i) => (
            <Box key={f.key}>
              {i === editIndex ? (
                <InputField
                  label={f.label}
                  value={f.value}
                  onChange={(val) => {
                    const updated = [...editFields];
                    updated[i] = { ...f, value: val };
                    setEditFields(updated);
                  }}
                  onSubmit={() => {
                    if (editIndex < editFields.length - 1) {
                      setEditIndex(editIndex + 1);
                    } else {
                      saveConfig();
                    }
                  }}
                />
              ) : (
                <Text color={i < editIndex ? 'green' : 'gray'}>{f.label.padEnd(16)}{f.value}</Text>
              )}
            </Box>
          ))}
          <Box marginTop={1}>
            <Text color="gray">Enter: next field / save last  Esc: cancel</Text>
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray">
          Esc:back  ←/→:tabs
          {tab === 'info' && '  p:pause/resume'}
          {tab === 'config' && !editing && !addingPath && '  x:edit'}
          {tab === 'config' && !editing && !addingPath && config.mcp_enabled === true && onMcpServers && '  m:MCP servers'}
          {tab === 'config' && !editing && !addingPath && deviceAccessEnabled && '  a:add path  d:remove path'}
        </Text>
      </Box>
    </Box>
  );
}
