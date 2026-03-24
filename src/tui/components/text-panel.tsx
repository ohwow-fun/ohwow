/**
 * TextPanel Component
 * Scrollable text output for task output, memories, etc.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface TextPanelProps {
  content: string;
  title?: string;
  maxHeight?: number;
}

export function TextPanel({ content, title, maxHeight = 20 }: TextPanelProps) {
  const lines = content.split('\n');
  const [scrollOffset, setScrollOffset] = useState(0);
  const maxOffset = Math.max(0, lines.length - maxHeight);

  useInput((input, key) => {
    if (input === 'j' || key.downArrow) {
      setScrollOffset(o => Math.min(o + 1, maxOffset));
    }
    if (input === 'k' || key.upArrow) {
      setScrollOffset(o => Math.max(o - 1, 0));
    }
    // Page down/up
    if (input === 'd') {
      setScrollOffset(o => Math.min(o + Math.floor(maxHeight / 2), maxOffset));
    }
    if (input === 'u') {
      setScrollOffset(o => Math.max(o - Math.floor(maxHeight / 2), 0));
    }
  });

  const visibleLines = lines.slice(scrollOffset, scrollOffset + maxHeight);
  const showScroll = lines.length > maxHeight;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {title && (
        <Box marginBottom={1}>
          <Text bold color="cyan">{title}</Text>
          {showScroll && (
            <Text color="gray"> ({scrollOffset + 1}-{Math.min(scrollOffset + maxHeight, lines.length)}/{lines.length})</Text>
          )}
        </Box>
      )}
      {visibleLines.map((line, i) => (
        <Text key={scrollOffset + i}>{line}</Text>
      ))}
      {showScroll && (
        <Text color="gray">j/k:scroll  d/u:page</Text>
      )}
    </Box>
  );
}
