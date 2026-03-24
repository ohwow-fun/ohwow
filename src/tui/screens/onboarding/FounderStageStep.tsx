/**
 * Onboarding Step 4: Founder Stage
 * Collects founder path (stage) and current focus area.
 */

import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { KeyHints } from '../../components/key-hints.js';
import { FOUNDER_PATHS } from '../../../lib/onboarding-logic.js';

type Field = 'path' | 'focus';

interface FounderStageStepProps {
  founderPath: string;
  founderFocus: string;
  activeField: Field;
  pathIndex: number;
}

export function FounderStageStep({
  founderPath,
  founderFocus,
  activeField,
  pathIndex,
}: FounderStageStepProps) {
  return (
    <Box flexDirection="column">
      <Text bold>Where are you in your journey?</Text>
      <Text color="gray">This helps us prioritize which agents to recommend.</Text>

      {/* Founder Path */}
      <Box marginTop={1} flexDirection="column">
        <Text color={activeField === 'path' ? 'cyan' : 'gray'}>Your stage</Text>
        {activeField === 'path' ? (
          <Box flexDirection="column">
            {FOUNDER_PATHS.map((fp, i) => (
              <Box key={fp.id}>
                <Text color={i === pathIndex ? 'cyan' : 'gray'}>
                  {i === pathIndex ? '❯ ' : '  '}
                </Text>
                <Text bold={i === pathIndex} color={i === pathIndex ? 'white' : 'gray'}>
                  {fp.label}
                </Text>
                <Text color="gray" dimColor> — {fp.description}</Text>
              </Box>
            ))}
          </Box>
        ) : (
          <Text color={founderPath ? 'white' : 'gray'}>
            {'  '}{FOUNDER_PATHS.find(fp => fp.id === founderPath)?.label || '(not set)'}
          </Text>
        )}
      </Box>

      {/* Focus Area */}
      <Box marginTop={1} flexDirection="column">
        <Text color={activeField === 'focus' ? 'cyan' : 'gray'}>What are you focused on right now?</Text>
        <Box>
          {activeField === 'focus' ? (
            <Box>
              <Text color="cyan">{'> '}</Text>
              <TextInput
                value={founderFocus}
                onChange={() => {}}
                placeholder="e.g. Getting my first 10 customers"
              />
            </Box>
          ) : (
            <Text color={founderFocus ? 'white' : 'gray'}>
              {'  '}{founderFocus || '(not set)'}
            </Text>
          )}
        </Box>
      </Box>

      <Box marginTop={1}>
        <KeyHints
          hints={[
            ...(activeField === 'path'
              ? [{ key: 'j/k', label: 'Navigate' }]
              : []),
            { key: 'Enter', label: activeField === 'focus' ? 'Continue' : 'Next field' },
            { key: 'Esc', label: 'Back' },
          ]}
        />
      </Box>
    </Box>
  );
}
