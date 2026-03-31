/**
 * Onboarding Step 0: Experience Choice
 * Lets the user choose between terminal onboarding or web browser onboarding.
 */

import React from 'react';
import { Box, Text } from 'ink';

interface ExperienceChoiceStepProps {
  /** Currently highlighted option: 0 = terminal, 1 = web */
  selectedIndex: number;
}

export function ExperienceChoiceStep({ selectedIndex }: ExperienceChoiceStepProps) {
  const options = [
    {
      label: 'Continue here in the terminal',
      description: 'Step-by-step wizard right in this window',
      shortcut: '1',
    },
    {
      label: 'Set up in your browser',
      description: 'Opens a visual dashboard at localhost:7700',
      shortcut: '2',
    },
  ];

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">{'________    ___ ___  __      __________  __      __'}</Text>
        <Text bold color="cyan">{'\\_____  \\  /   |   \\/  \\    /  \\_____  \\/  \\    /  \\'}</Text>
        <Text bold color="cyan">{' /   |   \\/    ~    \\   \\/\\/   //   |   \\   \\/\\/   /'}</Text>
        <Text bold color="cyan">{'/    |    \\    Y    /\\        //    |    \\        /'}</Text>
        <Text bold color="cyan">{'\\_______  /\\___|_  /  \\__/\\  / \\_______  /\\__/\\  /'}</Text>
        <Text bold color="cyan">{'        \\/       \\/        \\/          \\/      \\/'}</Text>
      </Box>

      <Box marginTop={1} marginBottom={1}>
        <Text bold>How would you like to set up?</Text>
      </Box>

      {options.map((opt, i) => {
        const isSelected = i === selectedIndex;
        return (
          <Box key={i} marginBottom={i < options.length - 1 ? 1 : 0}>
            <Box>
              <Text color={isSelected ? 'cyan' : 'gray'}>
                {isSelected ? '▸ ' : '  '}
              </Text>
              <Text bold={isSelected} color={isSelected ? 'white' : 'gray'}>
                {opt.label}
              </Text>
            </Box>
            <Box marginLeft={4}>
              <Text color="gray" dimColor>{opt.description}</Text>
            </Box>
          </Box>
        );
      })}

      <Box marginTop={2}>
        <Text color="gray">
          Use <Text bold color="white">↑↓</Text> to select, <Text bold color="white">Enter</Text> to confirm
        </Text>
      </Box>
    </Box>
  );
}
