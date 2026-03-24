/**
 * Grid Menu Panel
 * Renders the bottom grid navigation menu and contextual key hints.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Screen } from '../../types.js';
import { TAB_LABELS } from '../../types.js';
import { GridMenu, GRID_COLS } from '../../components/grid-menu.js';

export { GRID_COLS };

interface KeyHint {
  key: string;
  label: string;
}

interface GridMenuPanelProps {
  gridScreens: Screen[];
  focused: boolean;
  gridIndex: number;
  onSelect: (screen: Screen) => void;
  keyHints: KeyHint[];
}

export function GridMenuPanel({
  gridScreens,
  focused,
  gridIndex,
  onSelect,
  keyHints,
}: GridMenuPanelProps) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <GridMenu
        items={gridScreens}
        labels={TAB_LABELS}
        focused={focused}
        selectedIndex={gridIndex}
        onSelect={onSelect}
      />
      <Box>
        {keyHints.map((hint, i) => (
          <Box key={i} marginRight={2}>
            <Text bold color="yellow">{hint.key}</Text>
            <Text color="gray">:{hint.label}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
