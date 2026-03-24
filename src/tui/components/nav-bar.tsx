/**
 * NavBar Component
 * Tab navigation with number key shortcuts.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Screen } from '../types.js';

interface NavBarProps {
  activeScreen: Screen;
  tabs: Screen[];
  labels: Record<string, string>;
}

export function NavBar({ activeScreen, tabs, labels }: NavBarProps) {
  return (
    <Box paddingX={1}>
      {tabs.map((tab, i) => {
        const isActive = tab === activeScreen;
        return (
          <Box key={tab} marginRight={1}>
            <Text color={isActive ? 'cyan' : 'gray'} bold={isActive}>
              [{i + 1}]{labels[tab]}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
