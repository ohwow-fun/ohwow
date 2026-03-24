/**
 * AgentsList Screen
 * Agent roster with status and stats.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { ScrollableList } from '../components/scrollable-list.js';
import { AgentCard } from '../components/agent-card.js';

interface Agent {
  id: string;
  name: string;
  role: string;
  status: string;
  stats: Record<string, unknown>;
}

interface AgentsListProps {
  agents: Agent[];
  onSelect: (id: string) => void;
}

export function AgentsList({ agents, onSelect }: AgentsListProps) {
  return (
    <Box flexDirection="column">
      <Text bold>Agents ({agents.length})</Text>
      <Box marginTop={1}>
        <ScrollableList
          items={agents}
          onSelect={(agent) => onSelect(agent.id)}
          emptyMessage="No agents yet. Press c to create your first one."
          renderItem={(agent, _, isSelected) => {
            const stats = agent.stats as Record<string, number>;
            return (
              <AgentCard
                name={agent.name}
                role={agent.role}
                status={agent.status}
                taskCount={stats.total_tasks || 0}
                costDollars={((stats.cost_cents || 0) / 100).toFixed(2)}
                isSelected={isSelected}
              />
            );
          }}
        />
      </Box>
    </Box>
  );
}
