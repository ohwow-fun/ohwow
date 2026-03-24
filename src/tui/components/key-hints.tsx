/**
 * Key Hints Component
 * Bottom bar showing context-sensitive keyboard shortcuts.
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface KeyHint {
  key: string;
  label: string;
}

interface KeyHintsProps {
  hints: KeyHint[];
}

export function KeyHints({ hints }: KeyHintsProps) {
  if (hints.length === 0) return null;

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      {hints.map((hint, i) => (
        <Box key={i} marginRight={2}>
          <Text bold color="yellow">{hint.key}</Text>
          <Text color="gray">:{hint.label}</Text>
        </Box>
      ))}
    </Box>
  );
}
