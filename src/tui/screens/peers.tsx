/**
 * Peers Screen
 * Shows all workspace peers with status, health checking, and pairing.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { healthCheck, parsePeerRow } from '../../peers/peer-client.js';
import { ScrollableList } from '../components/scrollable-list.js';

interface PeersScreenProps {
  db: DatabaseAdapter | null;
  onBack: () => void;
}

interface PeerDisplay {
  id: string;
  name: string;
  baseUrl: string;
  tunnelUrl: string | null;
  status: string;
  lastSeenAt: string | null;
  lastHealthAt: string | null;
  consecutiveFailures: number;
  // Device capabilities
  totalMemoryGb: number | null;
  memoryTier: string | null;
  isAppleSilicon: boolean;
  hasNvidiaGpu: boolean;
  gpuName: string | null;
  localModels: string[];
  deviceRole: string;
}

type InputMode = 'none' | 'add-url';

export function PeersScreen({ db, onBack }: PeersScreenProps) {
  const [peers, setPeers] = useState<PeerDisplay[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<InputMode>('none');
  const [inputValue, setInputValue] = useState('');
  const [pairing, setPairing] = useState(false);

  const loadPeers = async () => {
    if (!db) return;
    setLoading(true);

    const { data } = await db
      .from('workspace_peers')
      .select('*')
      .order('created_at', { ascending: false });

    const rows = (data || []) as Array<Record<string, unknown>>;
    const parsed = rows.map((r) => {
      const peer = parsePeerRow(r);
      let models: string[] = [];
      try {
        const m = r.local_models;
        if (typeof m === 'string') models = JSON.parse(m);
        else if (Array.isArray(m)) models = m as string[];
      } catch { /* ignore */ }

      return {
        id: peer.id,
        name: peer.name,
        baseUrl: peer.base_url,
        tunnelUrl: peer.tunnel_url,
        status: peer.status,
        lastSeenAt: peer.last_seen_at,
        lastHealthAt: peer.last_health_at,
        consecutiveFailures: peer.consecutive_failures,
        totalMemoryGb: r.total_memory_gb as number | null ?? null,
        memoryTier: r.memory_tier as string | null ?? null,
        isAppleSilicon: !!(r.is_apple_silicon),
        hasNvidiaGpu: !!(r.has_nvidia_gpu),
        gpuName: r.gpu_name as string | null ?? null,
        localModels: models,
        deviceRole: (r.device_role as string) || 'hybrid',
      };
    });

    setPeers(parsed);
    setLoading(false);
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect -- loading data on mount is standard
  useEffect(() => { loadPeers(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const testPeer = async (peerId: string) => {
    if (!db || testing) return;
    setTesting(peerId);
    setMessage(null);

    const { data } = await db
      .from('workspace_peers')
      .select('*')
      .eq('id', peerId)
      .maybeSingle();

    if (!data) {
      setMessage('Peer not found');
      setTesting(null);
      return;
    }

    const peer = parsePeerRow(data as Record<string, unknown>);
    const result = await healthCheck(peer, db);

    setMessage(result.healthy
      ? `✓ ${peer.name} is reachable (${result.latencyMs}ms)`
      : `✗ ${peer.name}: ${result.error}`,
    );
    setTesting(null);
    loadPeers();
  };

  const deletePeer = async (peerId: string) => {
    if (!db) return;
    await db.from('workspace_peers').delete().eq('id', peerId);
    setMessage('Peer removed');
    loadPeers();
  };

  const initiatePairing = async (url: string) => {
    if (!db || pairing) return;
    setPairing(true);
    setMessage(null);

    const baseUrl = url.replace(/\/+$/, '');

    try {
      // Call our own API to initiate pairing
      // Since we're in the TUI, we can call the database directly
      const ourToken = crypto.randomUUID();
      const now = new Date().toISOString();

      // Get our workspace name
      const { data: nameSetting } = await db.from('runtime_settings')
        .select('value')
        .eq('key', 'workspace_name')
        .maybeSingle();
      const ourName = (nameSetting as { value: string } | null)?.value || 'Workspace';

      // Get our port for callback
      const { data: portSetting } = await db.from('runtime_settings')
        .select('value')
        .eq('key', 'port')
        .maybeSingle();
      const port = (portSetting as { value: string } | null)?.value || '7700';
      const callbackUrl = `http://localhost:${port}`;

      // Send pairing request to the target
      const response = await fetch(`${baseUrl}/api/peers/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: ourName,
          callbackUrl,
          token: ourToken,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (response.status === 403) {
          setMessage('Connection declined by the peer.');
        } else {
          setMessage(`Couldn't connect: ${response.status} ${text}`);
        }
        setPairing(false);
        return;
      }

      const result = (await response.json()) as {
        name: string;
        peerToken: string;
        capabilities: Record<string, unknown>;
      };

      // Check for existing peer with same base_url
      const { data: existing } = await db.from('workspace_peers')
        .select('*')
        .eq('base_url', baseUrl)
        .maybeSingle();

      if (existing) {
        const peer = existing as Record<string, unknown>;
        await db.from('workspace_peers').update({
          name: result.name,
          peer_token: result.peerToken,
          our_token: ourToken,
          status: 'connected',
          capabilities: JSON.stringify(result.capabilities || {}),
          last_seen_at: now,
          updated_at: now,
        }).eq('id', peer.id as string);
      } else {
        const id = crypto.randomUUID();
        await db.from('workspace_peers').insert({
          id,
          name: result.name,
          base_url: baseUrl,
          peer_token: result.peerToken,
          our_token: ourToken,
          status: 'connected',
          capabilities: JSON.stringify(result.capabilities || {}),
          last_seen_at: now,
          created_at: now,
          updated_at: now,
        });
      }

      setMessage(`✓ Connected to ${result.name}`);
      loadPeers();
    } catch {
      setMessage(`Couldn't reach ${baseUrl}. Check the URL.`);
    }
    setPairing(false);
  };

  useInput((input, key) => {
    if (inputMode !== 'none') {
      if (key.escape) {
        setInputMode('none');
        setInputValue('');
        return;
      }
      return;
    }

    if (key.escape) {
      onBack();
      return;
    }

    if (input === 'a') {
      setInputMode('add-url');
      setInputValue('');
      return;
    }

    if (input === 't' && peers.length > 0) {
      testPeer(peers[0].id);
      return;
    }

    if (input === 'd' && peers.length > 0) {
      deletePeer(peers[0].id);
    }
  });

  if (loading) {
    return <Text color="yellow">Loading peers...</Text>;
  }

  const statusColor = (status: string) => {
    switch (status) {
      case 'connected': return 'green';
      case 'error': return 'red';
      case 'rejected': return 'red';
      default: return 'yellow';
    }
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'connected': return '●';
      case 'error': return '✗';
      case 'rejected': return '✗';
      default: return '○';
    }
  };

  // Compute mesh summary
  const connectedPeers = peers.filter((p) => p.status === 'connected');
  const totalRam = connectedPeers.reduce((sum, p) => sum + (p.totalMemoryGb || 0), 0);
  const gpuCount = connectedPeers.filter((p) => p.hasNvidiaGpu || p.isAppleSilicon).length;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Box>
          <Text bold>DEVICES</Text>
          <Text color="gray"> — Local mesh</Text>
        </Box>
        {connectedPeers.length > 0 && (
          <Text color="gray">
            Mesh: {connectedPeers.length + 1} devices
            {totalRam > 0 ? `, ${totalRam}GB RAM total` : ''}
            {gpuCount > 0 ? `, ${gpuCount} GPU${gpuCount > 1 ? 's' : ''}` : ''}
          </Text>
        )}
      </Box>

      {inputMode === 'add-url' && (
        <Box marginBottom={1} flexDirection="column">
          <Text>Enter the peer workspace URL (e.g. http://192.168.1.10:7700):</Text>
          <Box>
            <Text color="cyan">{'> '}</Text>
            <TextInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={(val) => {
                setInputMode('none');
                if (val.trim()) initiatePairing(val.trim());
              }}
            />
          </Box>
          {pairing && <Text color="yellow">Connecting...</Text>}
        </Box>
      )}

      {peers.length === 0 ? (
        <Box flexDirection="column">
          <Text color="gray">No workspace peers connected.</Text>
          <Text color="gray">Press <Text bold color="white">a</Text> to add a peer workspace.</Text>
        </Box>
      ) : (
        <ScrollableList
          items={peers}
          renderItem={(peer, _i, isSelected) => (
            <Box flexDirection="column">
              <Box>
                <Text color={isSelected ? 'white' : 'gray'}>
                  <Text color={statusColor(peer.status)}>
                    {statusIcon(peer.status)}
                  </Text>
                  {' '}{peer.name}
                  {peer.deviceRole !== 'hybrid' && (
                    <Text color="cyan"> [{peer.deviceRole}]</Text>
                  )}
                  <Text color="gray"> {peer.baseUrl}</Text>
                  {peer.lastSeenAt && (
                    <Text color="gray"> (seen {formatRelativeTime(peer.lastSeenAt)})</Text>
                  )}
                </Text>
              </Box>
              {isSelected && peer.totalMemoryGb && (
                <Box paddingLeft={3}>
                  <Text color="gray">
                    {peer.totalMemoryGb}GB RAM
                    {peer.isAppleSilicon ? ' | Apple Silicon' : ''}
                    {peer.hasNvidiaGpu && peer.gpuName ? ` | ${peer.gpuName}` : ''}
                    {peer.localModels.length > 0 ? ` | Models: ${peer.localModels.join(', ')}` : ''}
                  </Text>
                </Box>
              )}
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
          [a] Add peer  [t] Test  [d] Disconnect  [Esc] Back
        </Text>
      </Box>
    </Box>
  );
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
