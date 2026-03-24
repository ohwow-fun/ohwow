/**
 * Shortcut Palette
 * Overlay showing all commands grouped by section.
 * Opened with `?` key, supports type-to-filter and keyboard navigation.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SlashCommand } from './slash-command-menu.js';

interface ShortcutPaletteProps {
  commands: SlashCommand[];
  selectedIndex: number;
  filter: string;
}

interface Section {
  title: string;
  commands: string[];
}

const SECTIONS: Section[] = [
  {
    title: 'Navigate',
    commands: ['/dashboard', '/agents', '/tasks', '/contacts', '/people', '/activity', '/automations', '/approvals', '/settings', '/media', '/sessions'],
  },
  {
    title: 'Session',
    commands: ['/new', '/clear', '/rename', '/model'],
  },
  {
    title: 'System',
    commands: ['/device', '/restart', '/stop', '/help'],
  },
];

export function ShortcutPalette({ commands, selectedIndex, filter }: ShortcutPaletteProps) {
  const filtered = filter
    ? commands.filter(c =>
        c.command.slice(1).toLowerCase().includes(filter.toLowerCase()) ||
        c.label.toLowerCase().includes(filter.toLowerCase())
      )
    : commands;

  if (filtered.length === 0) {
    return (
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="gray" dimColor>No matching shortcuts</Text>
      </Box>
    );
  }

  // Build a flat index so we can match selectedIndex across sections
  let flatIdx = 0;

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
      {filter ? (
        <Box marginBottom={1}>
          <Text color="cyan" bold>Filter: </Text>
          <Text color="white">{filter}</Text>
        </Box>
      ) : (
        <Box marginBottom={1}>
          <Text color="cyan" bold>Shortcuts</Text>
          <Text color="gray" dimColor>  type to filter, arrows to navigate, enter to run</Text>
        </Box>
      )}

      {SECTIONS.map(section => {
        const sectionCmds = filtered.filter(c => section.commands.includes(c.command));
        if (sectionCmds.length === 0) return null;

        const rows = sectionCmds.map(cmd => {
          const isSelected = flatIdx === selectedIndex;
          flatIdx++;
          const name = cmd.command.slice(1); // strip leading /
          return (
            <Box key={cmd.command}>
              <Text color={isSelected ? 'cyan' : 'gray'} bold={isSelected}>
                {isSelected ? '> ' : '  '}
              </Text>
              <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
                {name}
              </Text>
              <Text color="gray" dimColor>  {cmd.label}</Text>
            </Box>
          );
        });

        return (
          <Box key={section.title} flexDirection="column" marginBottom={1}>
            <Text color="yellow" dimColor>{section.title.toUpperCase()}</Text>
            {rows}
          </Box>
        );
      })}

      <Box>
        <Text color="gray" dimColor>esc to close</Text>
      </Box>
    </Box>
  );
}

export function getFilteredPaletteCommands(filter: string, commands: SlashCommand[]): SlashCommand[] {
  if (!filter) return commands;
  const q = filter.toLowerCase();
  return commands.filter(c =>
    c.command.slice(1).toLowerCase().includes(q) ||
    c.label.toLowerCase().includes(q)
  );
}
