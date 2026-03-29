/**
 * Input Field Component
 * Labeled text input wrapper with optional masking.
 */

import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

interface InputFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  mask?: string;
  placeholder?: string;
}

export function InputField({ label, value, onChange, onSubmit, mask, placeholder }: InputFieldProps) {
  return (
    <Box>
      <Text color="cyan">{label}: </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        mask={mask}
        placeholder={placeholder}
      />
    </Box>
  );
}
