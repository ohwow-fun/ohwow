/**
 * TaskRow Component
 * Task summary row for lists.
 */

import React from 'react';
import { Box, Text } from 'ink';

interface TaskRowProps {
  title: string;
  status: string;
  agentName?: string;
  timeAgo: string;
  tokensUsed?: number | null;
  priority?: string | null;
  isSelected?: boolean;
}

function getPriorityIndicator(priority: string | null | undefined): { char: string; color: string } | null {
  switch (priority) {
    case 'urgent': return { char: '!', color: 'red' };
    case 'high': return { char: '\u2191', color: 'yellow' };
    case 'low': return { char: '\u2193', color: 'gray' };
    default: return null;
  }
}

export function TaskRow({ title, status, agentName, timeAgo, tokensUsed, priority, isSelected }: TaskRowProps) {
  const icon = status === 'completed' ? '\u2713' : status === 'approved' ? '\u2713' : status === 'failed' ? '\u2717' : status === 'in_progress' ? '\u25C9' : status === 'needs_approval' ? '\u231B' : '\u25CB';
  const color = status === 'completed' ? 'green' : status === 'approved' ? 'green' : status === 'failed' ? 'red' : status === 'in_progress' ? 'yellow' : status === 'needs_approval' ? 'magenta' : 'gray';
  const pri = getPriorityIndicator(priority);

  return (
    <Box>
      <Text color={color}>{icon}</Text>
      <Text> </Text>
      {pri && <><Text color={pri.color}>{pri.char}</Text><Text> </Text></>}
      <Text bold={isSelected}>{title.slice(0, 35).padEnd(35)}</Text>
      {agentName && <Text color="gray">{agentName.slice(0, 15).padEnd(15)}</Text>}
      <Text color={color}>{status.padEnd(15)}</Text>
      {tokensUsed != null && <Text color="gray">{String(tokensUsed).padStart(6)}tk  </Text>}
      <Text color="gray">{timeAgo}</Text>
    </Box>
  );
}
