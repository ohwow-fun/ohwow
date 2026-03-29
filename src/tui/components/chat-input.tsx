/**
 * ChatInput Component
 * Single-line input for the orchestrator chat.
 */

import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  isDisabled?: boolean;
  isFocused?: boolean;
}

export function ChatInput({ value, onChange, onSubmit, isDisabled, isFocused = true }: ChatInputProps) {
  const handleSubmit = (text: string) => {
    if (text.trim() && !isDisabled) {
      onSubmit(text.trim());
      onChange('');
    }
  };

  return (
    <Box borderStyle="single" borderColor={!isFocused || isDisabled ? 'gray' : 'cyan'} paddingX={1}>
      <Text color={isFocused ? 'cyan' : 'gray'}>&gt; </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={handleSubmit}
        focus={isFocused && !isDisabled}
        placeholder={isDisabled ? 'Waiting for response...' : 'Type a message... (Enter to send)'}
      />
    </Box>
  );
}
