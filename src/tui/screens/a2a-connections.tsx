/**
 * A2A Connections List Screen
 * Shows all A2A connections with their status and health.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { healthCheck, parseConnectionRow } from '../../a2a/client.js';
import { ScrollableList } from '../components/scrollable-list.js';

interface A2AConnectionsListProps {
  db: DatabaseAdapter | null;
  workspaceId: string;
  onSetup: () => void;
  onBack: () => void;
}

interface ConnectionDisplay {
  id: string;
  name: string;
  endpoint: string;
  trustLevel: string;
  status: string;
  lastHealth: string | null;
  healthStatus: string | null;
  skills: string[];
}

export function A2AConnectionsList({ db, workspaceId, onSetup, onBack }: A2AConnectionsListProps) {
  const [connections, setConnections] = useState<ConnectionDisplay[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadConnections = async () => {
    if (!db) return;
    setLoading(true);

    const { data } = await db
      .from('a2a_connections')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false });

    const rows = (data || []) as Array<Record<string, unknown>>;
    const parsed = rows.map((r) => {
      const conn = parseConnectionRow(r);
      const skills = conn.agent_card_cache?.skills?.map((s) => s.name) || [];
      return {
        id: conn.id,
        name: conn.name,
        endpoint: conn.endpoint_url,
        trustLevel: conn.trust_level,
        status: conn.status,
        lastHealth: conn.last_health_check_at,
        healthStatus: conn.last_health_status,
        skills,
      };
    });

    setConnections(parsed);
    setLoading(false);
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect -- loading data on mount is standard
  useEffect(() => { loadConnections(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const testConnection = async (connectionId: string) => {
    if (!db || testing) return;
    setTesting(connectionId);
    setMessage(null);

    const { data } = await db
      .from('a2a_connections')
      .select('*')
      .eq('id', connectionId)
      .single();

    if (!data) {
      setMessage('Connection not found');
      setTesting(null);
      return;
    }

    const conn = parseConnectionRow(data as Record<string, unknown>);
    const result = await healthCheck(conn, db);

    setMessage(result.healthy
      ? `✓ ${conn.name} is healthy (${result.latencyMs}ms)`
      : `✗ ${conn.name} failed: ${result.error}`,
    );
    setTesting(null);
    loadConnections();
  };

  const deleteConnection = async (connectionId: string) => {
    if (!db) return;
    await db.from('a2a_connections').delete().eq('id', connectionId);
    setMessage('Connection deleted');
    loadConnections();
  };

  useInput((input, key) => {
    if (key.escape) {
      onBack();
      return;
    }

    if (input === 'n') {
      onSetup();
      return;
    }

    if (input === 't' && connections.length > 0) {
      testConnection(connections[0]?.id);
    }

    if (input === 'd' && connections.length > 0) {
      deleteConnection(connections[0]?.id);
    }
  });

  if (loading) {
    return <Text color="yellow">Loading connections...</Text>;
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>A2A CONNECTIONS</Text>
        <Text color="gray"> — External agent connections</Text>
      </Box>

      {connections.length === 0 ? (
        <Box flexDirection="column">
          <Text color="gray">No A2A connections configured.</Text>
          <Text color="gray">Press <Text bold color="white">n</Text> to add a new connection.</Text>
        </Box>
      ) : (
        <ScrollableList
          items={connections}
          renderItem={(conn, _i, isSelected) => (
            <Box>
              <Text color={isSelected ? 'white' : 'gray'}>
                <Text color={conn.status === 'active' ? 'green' : conn.status === 'error' ? 'red' : 'yellow'}>
                  {conn.status === 'active' ? '●' : conn.status === 'error' ? '✗' : '○'}
                </Text>
                {' '}{conn.name}
                <Text color="gray"> [{conn.trustLevel}]</Text>
                {conn.skills.length > 0 && (
                  <Text color="gray"> — {conn.skills.slice(0, 3).join(', ')}</Text>
                )}
              </Text>
            </Box>
          )}
        />
      )}

      {message && (
        <Box marginTop={1}>
          <Text color={message.startsWith('✓') ? 'green' : message.startsWith('✗') ? 'red' : 'yellow'}>
            {message}
          </Text>
        </Box>
      )}

      {testing && <Text color="yellow">Testing connection...</Text>}

      <Box marginTop={1}>
        <Text color="gray">
          [n] Add new  [t] Test  [d] Delete  [Esc] Back
        </Text>
      </Box>
    </Box>
  );
}
