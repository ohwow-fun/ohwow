/**
 * Onboarding Step 3: Business Info
 * Collects business name, type, and description.
 */

import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { KeyHints } from '../../components/key-hints.js';
import { BUSINESS_TYPES } from '../../data/agent-presets.js';

type Field = 'name' | 'type' | 'description';

interface BusinessInfoStepProps {
  businessName: string;
  businessType: string;
  businessDescription: string;
  activeField: Field;
  typeIndex: number;
  onChangeName: (value: string) => void;
  onChangeDescription: (value: string) => void;
}

export function BusinessInfoStep({
  businessName,
  businessType,
  businessDescription,
  activeField,
  typeIndex,
}: BusinessInfoStepProps) {
  return (
    <Box flexDirection="column">
      <Text bold>Tell us about your business</Text>
      <Text color="gray">This helps us recommend the right AI agents for you.</Text>

      {/* Business Name */}
      <Box marginTop={1} flexDirection="column">
        <Text color={activeField === 'name' ? 'cyan' : 'gray'}>Business name</Text>
        <Box>
          {activeField === 'name' ? (
            <Box>
              <Text color="cyan">{'> '}</Text>
              <TextInput
                value={businessName}
                onChange={() => {}}
                placeholder="e.g. Acme Inc"
              />
            </Box>
          ) : (
            <Text color={businessName ? 'white' : 'gray'}>
              {'  '}{businessName || '(not set)'}
            </Text>
          )}
        </Box>
      </Box>

      {/* Business Type */}
      <Box marginTop={1} flexDirection="column">
        <Text color={activeField === 'type' ? 'cyan' : 'gray'}>Business type</Text>
        {activeField === 'type' ? (
          <Box flexDirection="column">
            {BUSINESS_TYPES.map((bt, i) => (
              <Box key={bt.id}>
                <Text color={i === typeIndex ? 'cyan' : 'gray'}>
                  {i === typeIndex ? '❯ ' : '  '}
                </Text>
                <Text bold={i === typeIndex} color={i === typeIndex ? 'white' : 'gray'}>
                  {bt.label}
                </Text>
                <Text color="gray" dimColor> — {bt.tagline}</Text>
              </Box>
            ))}
          </Box>
        ) : (
          <Text color={businessType ? 'white' : 'gray'}>
            {'  '}{BUSINESS_TYPES.find(bt => bt.id === businessType)?.label || '(not set)'}
          </Text>
        )}
      </Box>

      {/* Business Description */}
      <Box marginTop={1} flexDirection="column">
        <Text color={activeField === 'description' ? 'cyan' : 'gray'}>What does your business do? (one sentence)</Text>
        <Box>
          {activeField === 'description' ? (
            <Box>
              <Text color="cyan">{'> '}</Text>
              <TextInput
                value={businessDescription}
                onChange={() => {}}
                placeholder="e.g. We help small businesses automate their marketing"
              />
            </Box>
          ) : (
            <Text color={businessDescription ? 'white' : 'gray'}>
              {'  '}{businessDescription || '(not set)'}
            </Text>
          )}
        </Box>
      </Box>

      <Box marginTop={1}>
        <KeyHints
          hints={[
            ...(activeField === 'type'
              ? [{ key: 'j/k', label: 'Navigate' }]
              : []),
            { key: 'Enter', label: activeField === 'description' ? 'Continue' : 'Next field' },
            { key: 'Esc', label: 'Back' },
          ]}
        />
      </Box>
    </Box>
  );
}
