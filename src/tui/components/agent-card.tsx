/**
 * AgentCard Component
 * Agent summary row for lists.
 */

import React from 'react';
import { Box, Text } from 'ink';

interface AgentCardProps {
  name: string;
  role: string;
  status: string;
  taskCount: number;
  costDollars: string;
  isSelected?: boolean;
}

export function AgentCard({ name, role, status, taskCount, costDollars, isSelected }: AgentCardProps) {
  const statusColor = status === 'working' ? 'yellow' : status === 'idle' ? 'green' : 'gray';
  const statusIcon = status === 'working' ? '◉' : '●';

  return (
    <Box>
      <Text color={statusColor}>{statusIcon}</Text>
      <Text> </Text>
      <Text bold={isSelected}>{name.padEnd(22)}</Text>
      <Text color="gray">{role.slice(0, 18).padEnd(18)}</Text>
      <Text color={statusColor}>{status.padEnd(10)}</Text>
      <Text color="gray">{String(taskCount).padStart(4)} tasks  ${costDollars}</Text>
    </Box>
  );
}
