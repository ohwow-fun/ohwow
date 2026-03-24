/**
 * GridMenu Component
 * Compact 4-column grid of screen labels for the chat home.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Screen } from '../types.js';

export const GRID_COLS = 4;

interface GridMenuProps {
  items: Screen[];
  labels: Record<string, string>;
  focused: boolean;
  selectedIndex: number;
  onSelect: (screen: Screen) => void;
}

export function GridMenu({ items, labels, focused, selectedIndex }: GridMenuProps) {
  const rows: Screen[][] = [];
  for (let i = 0; i < items.length; i += GRID_COLS) {
    rows.push(items.slice(i, i + GRID_COLS));
  }

  return (
    <Box flexDirection="column">
      {rows.map((row, rowIdx) => (
        <Box key={rowIdx}>
          {row.map((screen, colIdx) => {
            const idx = rowIdx * GRID_COLS + colIdx;
            const isSelected = focused && idx === selectedIndex;
            return (
              <Box key={screen} width={16}>
                <Text
                  bold={isSelected}
                  color={isSelected ? 'cyan' : 'gray'}
                >
                  {isSelected ? '\u25B8' : ' '}{labels[screen] || screen}
                </Text>
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
