/**
 * McpServers Screen
 * Lists per-agent or global MCP servers. Supports add (n), delete (d),
 * test (t), and inspect (i) keybinds.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { McpServerConfig } from '../../mcp/types.js';
import { testMcpConnection } from '../../mcp/test-connection.js';
import type { McpTestResult } from '../../mcp/test-connection.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { logger } from '../../lib/logger.js';

interface McpServersProps {
  /** Agent ID — when set, manages per-agent MCP servers. When null, manages global servers. */
  agentId: string | null;
  db: DatabaseAdapter | null;
  onSetup: () => void;
  onBack: () => void;
}

type ViewMode = 'list' | 'inspect';

export function McpServers({ agentId, db, onSetup, onBack }: McpServersProps) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [messageColor, setMessageColor] = useState<string>('green');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [testing, setTesting] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [toolCounts, setToolCounts] = useState<Record<string, number>>({});
  const [inspectResult, setInspectResult] = useState<McpTestResult | null>(null);

  const loadServers = async () => {
    if (!db) return;
    setLoading(true);

    if (agentId) {
      const { data } = await db
        .from('agent_workforce_agents')
        .select('config')
        .eq('id', agentId)
        .single();

      if (data) {
        const agentConfig = typeof (data as { config: unknown }).config === 'string'
          ? JSON.parse((data as { config: string }).config)
          : ((data as { config: Record<string, unknown> }).config || {});
        setServers((agentConfig.mcp_servers as McpServerConfig[]) || []);
      }
    } else {
      const { data } = await db
        .from('runtime_settings')
        .select('value')
        .eq('key', 'global_mcp_servers')
        .maybeSingle();

      if (data) {
        try {
          setServers(JSON.parse((data as { value: string }).value) as McpServerConfig[]);
        } catch {
          setServers([]);
        }
      }
    }

    setLoading(false);
  };

  useEffect(() => { loadServers(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteServer = async (name: string) => {
    if (!db) return;
    const updated = servers.filter(s => s.name !== name);

    if (agentId) {
      const { data } = await db
        .from('agent_workforce_agents')
        .select('config')
        .eq('id', agentId)
        .single();

      if (data) {
        const agentConfig = typeof (data as { config: unknown }).config === 'string'
          ? JSON.parse((data as { config: string }).config)
          : ((data as { config: Record<string, unknown> }).config || {});
        agentConfig.mcp_servers = updated;
        await db.from('agent_workforce_agents').update({
          config: JSON.stringify(agentConfig),
          updated_at: new Date().toISOString(),
        }).eq('id', agentId);
      }
    } else {
      const { data: existing } = await db.from('runtime_settings').select('key').eq('key', 'global_mcp_servers').maybeSingle();
      if (existing) {
        await db.from('runtime_settings').update({ value: JSON.stringify(updated), updated_at: new Date().toISOString() }).eq('key', 'global_mcp_servers');
      } else {
        await db.from('runtime_settings').insert({ key: 'global_mcp_servers', value: JSON.stringify(updated) });
      }
    }

    setServers(updated);
    setMessage(`Deleted "${name}"`);
    setMessageColor('green');
    setConfirmDelete(null);
  };

  const handleTest = async () => {
    if (servers.length === 0 || testing) return;
    const server = servers[selectedIndex];
    if (!server) return;

    setTesting(true);
    setMessage(`Testing ${server.name}...`);
    setMessageColor('yellow');

    try {
      const result = await testMcpConnection(server);
      if (result.success) {
        const count = result.tools.length;
        setToolCounts(prev => ({ ...prev, [server.name]: count }));
        setMessage(`Connected. ${count === 1 ? '1 tool' : `${count} tools`} available`);
        setMessageColor('green');
      } else {
        setMessage(result.error || 'Couldn\'t connect to this server');
        setMessageColor('yellow');
      }
    } catch (err) {
      logger.error({ err, server: server.name }, 'MCP test connection error');
      setMessage('Couldn\'t connect to this server');
      setMessageColor('yellow');
    } finally {
      setTesting(false);
    }
  };

  const handleInspect = async () => {
    if (servers.length === 0 || testing) return;
    const server = servers[selectedIndex];
    if (!server) return;

    setTesting(true);
    setMessage(`Connecting to ${server.name}...`);
    setMessageColor('yellow');

    try {
      const result = await testMcpConnection(server);
      if (result.success) {
        setToolCounts(prev => ({ ...prev, [server.name]: result.tools.length }));
        setInspectResult(result);
        setViewMode('inspect');
        setMessage(null);
      } else {
        setMessage(result.error || 'Couldn\'t connect to inspect tools');
        setMessageColor('yellow');
      }
    } catch (err) {
      logger.error({ err, server: server.name }, 'MCP inspect error');
      setMessage('Couldn\'t connect to inspect tools');
      setMessageColor('yellow');
    } finally {
      setTesting(false);
    }
  };

  useInput((input, key) => {
    if (viewMode === 'inspect') {
      if (key.escape) {
        setViewMode('list');
        setInspectResult(null);
      }
      return;
    }

    if (confirmDelete) {
      if (input === 'y') { deleteServer(confirmDelete); return; }
      if (key.escape || input === 'n') { setConfirmDelete(null); return; }
      return;
    }
    if (testing) return;
    if (key.escape) { onBack(); return; }
    if (input === 'n') { onSetup(); return; }
    if (input === 'd' && servers.length > 0) {
      setMessage(null);
      const server = servers[selectedIndex];
      if (server) setConfirmDelete(server.name);
    }
    if (input === 't') { handleTest(); return; }
    if (input === 'i') { handleInspect(); return; }
  });

  if (loading) return <Text color="gray">Loading...</Text>;

  // Inspect view: show tools for the selected server
  if (viewMode === 'inspect' && inspectResult) {
    const server = servers[selectedIndex];
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="cyan">Tools</Text>
          <Text color="gray"> {server ? server.name : ''}</Text>
        </Box>

        {inspectResult.tools.length === 0 ? (
          <Text color="gray">No tools exposed by this server.</Text>
        ) : (
          <ScrollableList
            items={inspectResult.tools}
            emptyMessage="No tools."
            renderItem={(tool, _, isSelected) => (
              <Box flexDirection="column">
                <Text bold={isSelected}>
                  <Text color={isSelected ? 'cyan' : 'white'}>{tool.name}</Text>
                </Text>
                {tool.description ? (
                  <Text color="gray" wrap="truncate">
                    {'  '}{tool.description.length > 70 ? tool.description.slice(0, 70) + '...' : tool.description}
                  </Text>
                ) : null}
              </Box>
            )}
          />
        )}

        <Box marginTop={1}>
          <Text color="gray">esc:back</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">MCP Servers</Text>
        {agentId && <Text color="gray"> (agent)</Text>}
        {!agentId && <Text color="gray"> (global defaults)</Text>}
      </Box>

      {confirmDelete ? (
        <Box flexDirection="column">
          <Text color="yellow">{'Delete "'}{confirmDelete}{'"? '}</Text>
          <Text color="gray">y:confirm  n/esc:cancel</Text>
        </Box>
      ) : (
        <>
          {servers.length === 0 ? (
            <Text color="gray">No MCP servers yet. Press n to add one, or browse popular servers.</Text>
          ) : (
            <ScrollableList
              items={servers}
              emptyMessage="No servers."
              onSelectedIndexChange={setSelectedIndex}
              renderItem={(s, _, isSelected) => (
                <Text bold={isSelected}>
                  <Text color={isSelected ? 'cyan' : 'white'}>{s.name.padEnd(16)}</Text>
                  {toolCounts[s.name] !== undefined && (
                    <Text color="green">{`(${toolCounts[s.name] === 1 ? '1 tool' : `${toolCounts[s.name]} tools`}) `}</Text>
                  )}
                  <Text color="gray">
                    {s.transport === 'stdio'
                      ? `stdio · ${s.command}${s.args?.length ? ' ' + s.args.join(' ') : ''}`
                      : `http  · ${s.url}`}
                  </Text>
                </Text>
              )}
            />
          )}

          {message && <Text color={messageColor}>{message}</Text>}

          <Box marginTop={1}>
            <Text color="gray">n:add  d:delete  t:test  i:inspect  esc:back</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
