/**
 * SlashCommandMenu Component
 * Filtered command list shown above the chat input when typing `/`.
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface SlashCommand {
  command: string;
  label: string;
  action: () => void;
}

interface SlashCommandMenuProps {
  filter: string;
  commands: SlashCommand[];
  selectedIndex: number;
}

export function SlashCommandMenu({ filter, commands, selectedIndex }: SlashCommandMenuProps) {
  const filtered = commands.filter(c =>
    c.command.startsWith(filter) || c.label.toLowerCase().includes(filter.slice(1).toLowerCase())
  );

  if (filtered.length === 0) {
    return (
      <Box paddingX={1} marginBottom={0}>
        <Text color="gray" dimColor>No matching commands</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={0}>
      {filtered.map((cmd, i) => {
        const isSelected = i === selectedIndex;
        return (
          <Box key={cmd.command}>
            <Text color={isSelected ? 'cyan' : 'gray'} bold={isSelected}>
              {isSelected ? '> ' : '  '}
              {cmd.command}
            </Text>
            <Text color="gray" dimColor> {cmd.label}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function getFilteredCommands(filter: string, commands: SlashCommand[]): SlashCommand[] {
  return commands.filter(c =>
    c.command.startsWith(filter) || c.label.toLowerCase().includes(filter.slice(1).toLowerCase())
  );
}
