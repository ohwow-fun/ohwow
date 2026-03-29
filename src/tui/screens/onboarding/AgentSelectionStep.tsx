/**
 * Onboarding Step 6: Agent Selection
 * Multi-select checklist of agents to create.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { KeyHints } from '../../components/key-hints.js';
import type { AgentPreset } from '../../data/agent-presets.js';

export interface AgentHealthInfo {
  name: string;
  role: string;
  status: 'idle' | 'working' | 'error';
  taskCount: number;
  costCents: number;
}

interface AgentSelectionStepProps {
  presets: AgentPreset[];
  selectedIds: Set<string>;
  cursorIndex: number;
  /** When true, renders a readonly status view instead of toggleable checkboxes */
  readonlyMode?: boolean;
  /** Agent health data for readonly mode */
  agentHealth?: AgentHealthInfo[];
  /** When true, shows an empty state message (connected mode with no agents) */
  emptyState?: boolean;
}

const STATUS_COLORS: Record<AgentHealthInfo['status'], string> = {
  idle: 'green',
  working: 'yellow',
  error: 'red',
};

export function AgentSelectionStep({
  presets,
  selectedIds,
  cursorIndex,
  readonlyMode,
  agentHealth,
  emptyState,
}: AgentSelectionStepProps) {
  if (emptyState) {
    return (
      <Box flexDirection="column">
        <Text bold>Your Agents</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">No agents have been set up yet.</Text>
          <Text color="gray">You can add agents from the dashboard after setup.</Text>
        </Box>
        <Box marginTop={1}>
          <Text color="gray">Press <Text bold color="white">Enter</Text> to continue</Text>
        </Box>
      </Box>
    );
  }

  if (readonlyMode && agentHealth) {
    return (
      <Box flexDirection="column">
        <Text bold>Your Agents</Text>

        <Box flexDirection="column" marginTop={1}>
          {agentHealth.map((agent) => (
            <Box key={agent.name} marginBottom={0}>
              <Text color={STATUS_COLORS[agent.status]}>●</Text>
              <Text> </Text>
              <Text bold color="white">{agent.name.padEnd(22)}</Text>
              <Text color="gray">{agent.status.padEnd(10)}</Text>
              <Text color="gray">{String(agent.taskCount).padStart(3)} {agent.taskCount === 1 ? 'task' : 'tasks'}   </Text>
              <Text color="gray">${(agent.costCents / 100).toFixed(2)}</Text>
            </Box>
          ))}
        </Box>

        <Box marginTop={1}>
          <Text color="gray">Press <Text bold color="white">Enter</Text> to continue</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Choose your agents</Text>
      <Text color="gray">
        Toggle agents with Space. {selectedIds.size} selected.
      </Text>

      <Box flexDirection="column" marginTop={1}>
        {presets.map((agent, i) => {
          const isSelected = selectedIds.has(agent.id);
          const isCursor = i === cursorIndex;

          return (
            <Box key={agent.id} marginBottom={1} flexDirection="column">
              <Box>
                <Text color={isCursor ? 'cyan' : 'gray'}>
                  {isCursor ? '❯ ' : '  '}
                </Text>
                <Text color={isSelected ? 'green' : 'gray'}>
                  {isSelected ? '[✓]' : '[ ]'}{' '}
                </Text>
                <Text bold={isCursor} color={isCursor ? 'white' : isSelected ? 'white' : 'gray'}>
                  {agent.name}
                </Text>
                <Text color="gray"> — {agent.role}</Text>
              </Box>
              {isCursor && (
                <Box marginLeft={8}>
                  <Text color="gray" dimColor>{agent.description}</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <KeyHints hints={[
          { key: 'j/k', label: 'Navigate' },
          { key: 'Space', label: 'Toggle' },
          { key: 'Enter', label: `Create ${selectedIds.size} agent${selectedIds.size === 1 ? '' : 's'}` },
          { key: 'Esc', label: 'Back' },
        ]} />
      </Box>
    </Box>
  );
}
