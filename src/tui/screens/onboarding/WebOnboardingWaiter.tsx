/**
 * Web Onboarding Waiter
 * Shown in the TUI while the user completes onboarding in the browser.
 * Polls the daemon for onboarding completion.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';

interface WebOnboardingWaiterProps {
  port: number;
  sessionToken: string;
  onComplete: () => void;
  onCancel: () => void;
}

export function WebOnboardingWaiter({ port, sessionToken, onComplete, onCancel }: WebOnboardingWaiterProps) {
  // Handle Esc to cancel and go back to terminal onboarding
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  const [dots, setDots] = useState('');
  const [status, setStatus] = useState<'waiting' | 'starting' | 'ready'>('starting');
  const [elapsed, setElapsed] = useState(0);
  const cancelled = useRef(false);

  // Animate dots
  useEffect(() => {
    const interval = setInterval(() => {
      setDots(d => d.length >= 3 ? '' : d + '.');
      setElapsed(e => e + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Wait for daemon to be ready, then start polling
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const waitForReady = async () => {
      // Wait for health endpoint
      for (let i = 0; i < 30; i++) {
        if (cancelled.current) return;
        try {
          const res = await fetch(`http://localhost:${port}/health`, {
            signal: AbortSignal.timeout(2000),
          });
          if (res.ok) {
            setStatus('ready');
            break;
          }
        } catch {
          // Not ready yet
        }
        await new Promise(r => setTimeout(r, 1000));
      }

      if (cancelled.current) return;
      setStatus('ready');

      // Poll for onboarding completion
      timer = setInterval(async () => {
        if (cancelled.current) return;
        try {
          const res = await fetch(`http://localhost:${port}/api/onboarding/model-available`, {
            headers: { Authorization: `Bearer ${sessionToken}` },
            signal: AbortSignal.timeout(2000),
          });
          if (!res.ok) return;

          // Also check if onboarding was completed by looking for agents
          const agentsRes = await fetch(`http://localhost:${port}/api/agents`, {
            headers: { Authorization: `Bearer ${sessionToken}` },
            signal: AbortSignal.timeout(2000),
          });
          if (agentsRes.ok) {
            const body = await agentsRes.json() as { data?: unknown[] };
            if (body.data && body.data.length > 0) {
              if (!cancelled.current) onComplete();
            }
          }
        } catch {
          // Ignore poll errors
        }
      }, 3000);
    };

    waitForReady();

    return () => {
      cancelled.current = true;
      if (timer) clearInterval(timer);
    };
  }, [port, sessionToken, onComplete]);

  const url = `http://localhost:${port}/ui/onboarding`;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">{'________    ___ ___  __      __________  __      __'}</Text>
        <Text bold color="cyan">{'\\_____  \\  /   |   \\/  \\    /  \\_____  \\/  \\    /  \\'}</Text>
        <Text bold color="cyan">{' /   |   \\/    ~    \\   \\/\\/   //   |   \\   \\/\\/   /'}</Text>
        <Text bold color="cyan">{'/    |    \\    Y    /\\        //    |    \\        /'}</Text>
        <Text bold color="cyan">{'\\_______  /\\___|_  /  \\__/\\  / \\_______  /\\__/\\  /'}</Text>
        <Text bold color="cyan">{'        \\/       \\/        \\/          \\/      \\/'}</Text>
      </Box>

      <Box marginTop={1} marginBottom={1}>
        <Text bold>Setting up in your browser</Text>
      </Box>

      {status === 'starting' ? (
        <Box>
          <Text color="yellow">Starting the web server{dots}</Text>
        </Box>
      ) : (
        <>
          <Box marginBottom={1}>
            <Text color="green">✓ </Text>
            <Text>Web dashboard is ready</Text>
          </Box>
          <Box marginBottom={1}>
            <Text color="gray">Open this URL if it didn't open automatically:</Text>
          </Box>
          <Box marginBottom={1}>
            <Text bold color="cyan">{url}</Text>
          </Box>
          <Box>
            <Text color="gray">Waiting for you to finish setup in the browser{dots}</Text>
          </Box>
        </>
      )}

      <Box marginTop={2}>
        <Text color="gray" dimColor>
          {elapsed > 0 && `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} elapsed · `}
          Press <Text bold dimColor>Esc</Text> to go back and use the terminal instead
        </Text>
      </Box>
    </Box>
  );
}
