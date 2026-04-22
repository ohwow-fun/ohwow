/**
 * AgentBioCard
 * Dossier-style overlay for a single agent. Triggered by pressing 'i' on a
 * selected agent row in TodayBoard. Typewriter reveal for header + intel.
 * Press Escape to close.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { useTypewriter } from '../hooks/use-typewriter.js';
import { C } from '../theme.js';

interface AgentBioCardProps {
  agent: {
    id: string;
    name: string;
    role: string;
    status: string;
    description?: string | null;
    stats?: Record<string, unknown>;
  };
  sparkTasks: Array<{ agent_id: string; created_at: string; completed_at: string | null }>;
  onClose: () => void;
}

export function AgentBioCard({ agent, sparkTasks, onClose }: AgentBioCardProps) {
  const headerTyped = useTypewriter('◈ DOSSIER: ' + agent.name, true, 35);

  const personalityText = (agent.description ?? 'No briefing on file.').slice(0, 80);
  const personalityTyped = useTypewriter(personalityText, agent.description != null, 25);

  const currentTask = (agent.stats as Record<string, unknown> | undefined)?.currentTask as string | undefined;

  const recentText = [5, 6, 7].map(slot => {
    const slotStart = new Date(Date.now() - (8 - slot) * 60 * 60 * 1000);
    const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);
    const count = sparkTasks.filter(
      t =>
        t.agent_id === agent.id &&
        new Date(t.created_at) >= slotStart &&
        new Date(t.created_at) < slotEnd,
    ).length;
    const hoursAgo = 8 - slot - 1;
    return `${count} task${count !== 1 ? 's' : ''} (${hoursAgo}h ago)`;
  }).join(' → ');

  useInput((_, key) => {
    if (key.escape) onClose();
  });

  return (
    <Box position="absolute" flexDirection="column" alignItems="center" justifyContent="center" width="100%" height="100%">
      <Box flexDirection="column" width={56} borderStyle="round" borderColor={C.mint} paddingX={2} paddingY={1}>
        <Text color={C.mint}>{headerTyped}</Text>
        <Text> </Text>
        <Box flexDirection="row">
          <Text color={C.slate}>{'ROLE    '}</Text>
          <Text>{agent.role}</Text>
        </Box>
        <Box flexDirection="row">
          <Text color={C.slate}>{'STATUS  '}</Text>
          <Text>{agent.status}{currentTask ? ' ' + currentTask : ''}</Text>
        </Box>
        <Text> </Text>
        <Text color={C.slate}>INTEL</Text>
        <Text>{personalityTyped}</Text>
        <Text> </Text>
        <Text color={C.slate}>RECENT</Text>
        <Text dimColor>{recentText}</Text>
        <Text> </Text>
        <Text dimColor>ESC to close</Text>
      </Box>
    </Box>
  );
}
