/**
 * Header Component
 * Top bar: title, connection status, clock.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { WhatsAppConnectionStatus } from '../../whatsapp/types.js';

interface HeaderProps {
  version: string;
  cloudConnected: boolean;
  tier?: 'free' | 'connected';
  whatsappStatus?: WhatsAppConnectionStatus;
  daemonPid?: number | null;
  daemonUptime?: number;
  daemonPort?: number;
  daemonConnectedAt?: number | null;
  initializing?: boolean;
  /** Active workspace name. Always shown so users always know which brain they're driving. */
  workspaceName?: string;
}

export function Header({ version, cloudConnected, tier, whatsappStatus, daemonPid, daemonUptime, daemonPort, daemonConnectedAt, initializing, workspaceName }: HeaderProps) {
  const [clock, setClock] = useState(() => ({ time: formatTime(), now: Date.now() }));

  useEffect(() => {
    const timer = setInterval(() => {
      setClock({ time: formatTime(), now: Date.now() });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Compute live uptime: daemon-reported base + seconds elapsed since we received it
  const liveUptime = daemonConnectedAt
    ? (daemonUptime || 0) + Math.floor((clock.now - daemonConnectedAt) / 1000)
    : (daemonUptime || 0);

  const isConnected = tier !== 'free';

  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1} justifyContent="space-between">
      <Box>
        <Text bold color="cyan">OHWOW v{version}</Text>
        {workspaceName && (
          <>
            <Text color="gray">  │  </Text>
            <Text bold color="magenta">⌂ {workspaceName}</Text>
          </>
        )}
        {daemonPid && (
          <Text color="gray">  │  PID {daemonPid}</Text>
        )}
        {daemonPort && (
          <Text color="gray">  :{daemonPort}</Text>
        )}
        {liveUptime > 0 && (
          <Text color="gray">  Up {formatUptime(liveUptime)}</Text>
        )}
      </Box>
      <Box>
        {isConnected ? (
          <Text color={initializing ? 'yellow' : cloudConnected ? 'green' : 'red'}>
            {initializing ? '◌' : cloudConnected ? '●' : '○'} {initializing ? 'Starting...' : cloudConnected ? 'Cloud' : 'Offline'}
          </Text>
        ) : (
          <Text color="green">● Local</Text>
        )}
        {whatsappStatus === 'connected' && (
          <Text color="green">  ● WhatsApp</Text>
        )}
        {whatsappStatus === 'qr_pending' && (
          <Text color="yellow">  ◌ WhatsApp QR</Text>
        )}
        <Text color="gray">  {clock.time}</Text>
      </Box>
    </Box>
  );
}

function formatTime(): string {
  const now = new Date();
  return now.toLocaleTimeString('en-US', { hour12: false });
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
