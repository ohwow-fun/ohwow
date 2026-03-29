/**
 * Stats Settings Subtab
 * Agent count, Task count, Token usage, Cost.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { HealthMetrics } from '../../types.js';

interface StatsTabProps {
  health: HealthMetrics;
}

export function StatsTab({ health }: StatsTabProps) {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Stats</Text>
      <Text>  Agents:     <Text color="gray">{health.totalAgents}</Text></Text>
      <Text>  Tasks:      <Text color="gray">{health.totalTasks}</Text></Text>
      <Text>  Tokens:     <Text color="gray">{health.totalTokens.toLocaleString()}</Text></Text>
      <Text>  Cost:       <Text color="gray">${(health.totalCostCents / 100).toFixed(2)}</Text></Text>
    </Box>
  );
}
