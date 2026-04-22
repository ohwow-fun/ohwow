/**
 * Header Component
 * Top bar: title, connection status, clock.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { WhatsAppConnectionStatus } from '../../whatsapp/types.js';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { C } from '../theme.js';

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
  const cols = useTerminalSize();

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
  const narrow = cols < 90;    // hide PID / port / uptime
  const compact = cols < 75;   // also hide workspace name

  return (
    <Box borderStyle="single" borderColor={C.cyan} paddingX={1} justifyContent="space-between">
      <Box>
        <Text bold color={C.cyan}>OHWOW v{version}</Text>
        {workspaceName && !compact && (
          <>
            <Text color={C.dim}>  ┃  </Text>
            <Text bold color={C.purple}>⌂ {workspaceName}</Text>
          </>
        )}
        {daemonPid && !narrow && (
          <Text color={C.dim}>  ┃  PID {daemonPid}</Text>
        )}
        {daemonPort && !narrow && (
          <Text color={C.dim}>  :{daemonPort}</Text>
        )}
        {liveUptime > 0 && !narrow && (
          <Text color={C.dim}>  Up {formatUptime(liveUptime)}</Text>
        )}
      </Box>
      <Box>
        {isConnected ? (
          <Text color={initializing ? C.amber : cloudConnected ? C.green : C.red}>
            {initializing ? '◌' : cloudConnected ? '●' : '○'} {initializing ? 'Starting...' : cloudConnected ? 'Cloud' : 'Offline'}
          </Text>
        ) : (
          <Text color={C.green}>● Local</Text>
        )}
        {whatsappStatus === 'connected' && !narrow && (
          <Text color={C.green}>  ● WA</Text>
        )}
        {whatsappStatus === 'qr_pending' && !narrow && (
          <Text color={C.amber}>  ◌ WA QR</Text>
        )}
        <Text color={C.dim}>  {clock.time}</Text>
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
